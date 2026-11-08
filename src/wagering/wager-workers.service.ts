import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import {
  CreateQueueCommand, DeleteMessageCommand, GetQueueUrlCommand, ReceiveMessageCommand,
  SendMessageCommand, SQSClient,
} from '@aws-sdk/client-sqs';
import type { EntityManager, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { WageringService } from './wagering.service.js';
import { startTraceSpan } from '../observability/otel-tracing.js';

interface OutboxRow {
  id: string; aggregate_id: string; event_type: string; payload: Record<string, unknown>;
}
interface QueueEnvelope {
  messageId: string; type: string; data: Record<string, unknown>;
}
const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * Three independent opt-in loops. Every listener may run on multiple processes.
 * SQS message ACK happens after WageringService's DB transaction commits.
 * The outbox lease survives publisher crashes; eventual delivery is at-least-once.
 */
@Injectable()
export class WagerWorkers implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WagerWorkers.name);
  private readonly id = randomUUID();
  private readonly client = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
  private readonly visibilityTimeout = (() => {
    const seconds = Number(process.env.SQS_VISIBILITY_TIMEOUT_SECONDS ?? '30');
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 43200) {
      throw new Error('SQS_VISIBILITY_TIMEOUT_SECONDS must be 1..43200');
    }
    return seconds;
  })();
  private stopping = false;
  private tasks: Promise<void>[] = [];

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM<PostgreSqlDriver>,
    private readonly wagers: WageringService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.SQS_WORKER_ENABLED === '1') this.tasks.push(this.consume());
    if (process.env.OUTBOX_PUBLISHER_ENABLED === '1') this.tasks.push(this.publish());
    if (process.env.REFERENCE_WORKER_ENABLED === '1') this.tasks.push(this.references());
  }

  private async queueUrl(name: string): Promise<string> {
    const result = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!result.QueueUrl) throw new Error('Queue URL unavailable: ' + name);
    return result.QueueUrl;
  }

  private async consume(): Promise<void> {
    const queue = process.env.SQS_QUEUE_NAME ?? 'wager-transactions.fifo';
    while (!this.stopping) {
      try {
        const url = await this.queueUrl(queue);
        const batch = await this.client.send(new ReceiveMessageCommand({
          QueueUrl: url, WaitTimeSeconds: 2, MaxNumberOfMessages: 10, MessageAttributeNames: ['All'],
          // Tunable to make crash/redelivery tests reproducible; default for production.
          VisibilityTimeout: this.visibilityTimeout,
        }));
        for (const msg of batch.Messages ?? []) {
          if (this.stopping) break;
          const span = startTraceSpan('sqs.wager.consume', 'CONSUMER', {
            'messaging.system': 'aws_sqs', 'messaging.operation.type': 'process',
          }, msg.MessageAttributes?.traceparent?.StringValue);
          try {
            const envelope = JSON.parse(msg.Body ?? '') as QueueEnvelope;
            if (envelope.type !== 'WagerTransactionRequested' ||
                typeof envelope.messageId !== 'string' || !envelope.data ||
                typeof envelope.data.idempotencyKey !== 'string') {
              throw new Error('Invalid SQS envelope');
            }
            // Narrow once before entering the async span callback.
            const requestKey = envelope.data.idempotencyKey as string;
            await span.run(async () => {
              await this.wagers.submit(envelope.data, requestKey, {
                messageId: envelope.messageId, consumerName: 'wager-processor',
              });
              if (msg.ReceiptHandle) {
                await this.client.send(new DeleteMessageCommand({
                  QueueUrl: url, ReceiptHandle: msg.ReceiptHandle,
                }));
              }
            });
            span.end('OK');
          } catch (error) {
            span.end('ERROR');
            // Malformed / conflicting messages remain visible and are moved
            // by SQS redrive to the configured DLQ after maxReceiveCount.
            this.logger.error(JSON.stringify({
              message: 'SQS message failed, leaving unacknowledged',
              messageId: msg.MessageId,
              reason: error instanceof Error ? error.name : 'unknown',
            }));
          }
        }
      } catch (error) {
        this.logger.error(JSON.stringify({
          message: 'SQS polling failed, retrying', reason: error instanceof Error ? error.name : 'unknown',
        }));
        if (!this.stopping) await pause(1000);
      }
    }
  }

  private async claimOutbox(limit: number): Promise<OutboxRow[]> {
    return this.orm.em.fork().transactional(async (em0) => {
      const em = em0 as unknown as EntityManager<PostgreSqlDriver>;
      const rows = await em.execute<OutboxRow[]>([
        'SELECT id, aggregate_id, event_type, payload FROM wager_outbox',
        'WHERE published_at IS NULL AND next_attempt_at <= NOW()',
        'AND (locked_until IS NULL OR locked_until < NOW())',
        'ORDER BY occurred_at, id FOR UPDATE SKIP LOCKED LIMIT ?',
      ].join(' '), [limit], 'all');
      if (!rows.length) return [];
      const ids = rows.map(row => row.id);
      await em.execute([
        "UPDATE wager_outbox SET locked_by = ?, locked_until = NOW() + INTERVAL '30 seconds'",
        'WHERE id IN (' + ids.map(() => '?').join(',') + ')',
      ].join(' '), [this.id, ...ids], 'run');
      return rows;
    }, { clear: true });
  }

  private async publish(): Promise<void> {
    const queue = process.env.SQS_EVENTS_QUEUE_NAME ?? 'wager-events.fifo';
    while (!this.stopping) {
      try {
        const url = await this.queueUrl(queue);
        const rows = await this.claimOutbox(10);
        for (const row of rows) {
          const span = startTraceSpan('sqs.outbox.publish', 'PRODUCER', {
            'messaging.system': 'aws_sqs', 'messaging.operation.type': 'publish',
            'event.type': row.event_type,
          }, row.payload.traceparent);
          try {
            await span.run(async () => {
              await this.client.send(new SendMessageCommand({
                QueueUrl: url,
                MessageBody: JSON.stringify(row.payload),
                MessageGroupId: row.aggregate_id,
                MessageDeduplicationId: row.id,
                ...(span.traceparent ? {
                  MessageAttributes: { traceparent: {
                    DataType: 'String', StringValue: span.traceparent,
                  } },
                } : {}),
              }));
            });
            await this.orm.em.fork().execute([
              'UPDATE wager_outbox SET published_at = NOW(), locked_by = NULL, locked_until = NULL',
              'WHERE id = ? AND locked_by = ?',
            ].join(' '), [row.id, this.id], 'run');
            span.end('OK');
          } catch (error) {
            span.end('ERROR');
            await this.orm.em.fork().execute([
              'UPDATE wager_outbox SET attempts = attempts + 1,',
              "next_attempt_at = NOW() + (LEAST(300, POWER(2, LEAST(attempts + 1, 8))) * INTERVAL '1 second'),",
              'locked_by = NULL, locked_until = NULL WHERE id = ? AND locked_by = ?',
            ].join(' '), [row.id, this.id], 'run');
            this.logger.warn(JSON.stringify({
              message: 'Outbox publish retry scheduled', eventId: row.id,
              reason: error instanceof Error ? error.name : 'unknown',
            }));
          }
        }
        if (!rows.length) await pause(300);
      } catch (error) {
        this.logger.error(JSON.stringify({
          message: 'Outbox publisher failed, retrying',
          reason: error instanceof Error ? error.name : 'unknown',
        }));
        if (!this.stopping) await pause(1000);
      }
    }
  }

  private async references(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.wagers.retryPending(10);
      } catch (error) {
        this.logger.warn(JSON.stringify({
          message: 'Pending-reference retry failed',
          reason: error instanceof Error ? error.name : 'unknown',
        }));
      }
      if (!this.stopping) await pause(1000);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled(this.tasks);
    this.client.destroy();
  }
}
