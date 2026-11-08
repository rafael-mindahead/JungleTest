import { timingSafeEqual } from 'node:crypto';
import {
  Controller, Get, Header, Headers, Inject, OnModuleDestroy,
  ServiceUnavailableException, UnauthorizedException,
} from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import type { PostgreSqlDriver } from '@mikro-orm/postgresql';
import {
  GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient,
} from '@aws-sdk/client-sqs';
import { FinancialMetrics } from './financial-metrics.service.js';
import { formatPrometheus } from './prometheus-metrics.js';

interface StatusRow { status: string; total: number }
interface OutboxRow { pending: number; lag_seconds: number; retries: number }
interface RetryRow { retry_attempts: number }
interface InboxRow { total: number }

/**
 * Diagnostic endpoint deliberately protected by a separate ops token.
 * Disabled unless METRICS_TOKEN is configured; no player/transaction IDs
 * or monetary payloads are included in the response.
 */
@Controller('internal')
export class FinancialMetricsController implements OnModuleDestroy {
  private readonly sqs = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM<PostgreSqlDriver>,
    private readonly local: FinancialMetrics,
  ) {}

  @Get('metrics')
  async read(@Headers('x-metrics-token') supplied: string | undefined) {
    const configured = process.env.METRICS_TOKEN;
    if (!configured || configured.length < 12) {
      throw new ServiceUnavailableException('Metrics require METRICS_TOKEN (min 12 characters)');
    }
    const expected = Buffer.from(configured);
    const actual = Buffer.from(supplied ?? '');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new UnauthorizedException('Metrics credential invalid');
    }

    const em = this.orm.em.fork();
    const [statuses, outbox, retries, inbox] = await Promise.all([
      em.execute<StatusRow[]>(
        'SELECT status, COUNT(*)::integer AS total FROM wager_transactions GROUP BY status', [], 'all',
      ),
      em.execute<OutboxRow[]>([
        'SELECT COUNT(*)::integer AS pending,',
        'COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(occurred_at))), 0)::double precision AS lag_seconds,',
        'COALESCE(SUM(attempts), 0)::integer AS retries',
        'FROM wager_outbox WHERE published_at IS NULL',
      ].join(' '), [], 'all'),
      em.execute<RetryRow[]>(
        'SELECT COALESCE(SUM(attempts), 0)::integer AS retry_attempts FROM wager_transactions',
        [], 'all',
      ),
      em.execute<InboxRow[]>(
        'SELECT COUNT(*)::integer AS total FROM wager_inbox', [], 'all',
      ),
    ]);
    let dlq: { available: boolean; visible: number | null; inFlight: number | null } = {
      available: false, visible: null, inFlight: null,
    };
    try {
      const name = process.env.SQS_DLQ_NAME ?? 'wager-transactions-dlq.fifo';
      const url = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
      if (url.QueueUrl) {
        const attributes = await this.sqs.send(new GetQueueAttributesCommand({
          QueueUrl: url.QueueUrl,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }));
        dlq = {
          available: true,
          visible: Number(attributes.Attributes?.ApproximateNumberOfMessages ?? 0),
          inFlight: Number(attributes.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
        };
      }
    } catch {
      // Monitoring must remain queryable during SQS outages.
    }

    return {
      measuredAt: new Date().toISOString(),
      source: {
        database: 'shared-postgres-durable',
        process: 'local-instance-volatile',
        sqs: 'approximate',
      },
      transactionsByStatus: Object.fromEntries(statuses.map(row => [
        row.status, Number(row.total),
      ])),
      inboxMessages: Number(inbox[0]?.total ?? 0),
      pendingReferenceRetries: Number(retries[0]?.retry_attempts ?? 0),
      outbox: {
        pending: Number(outbox[0]?.pending ?? 0),
        oldestPendingSeconds: Number(outbox[0]?.lag_seconds ?? 0),
        retryAttemptsPending: Number(outbox[0]?.retries ?? 0),
      },
      deadLetterQueue: dlq,
      local: this.local.snapshot(),
    };
  }

  /** Prometheus can authenticate with Authorization: Bearer <METRICS_TOKEN>. */
  @Get('prometheus')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async prometheus(@Headers('authorization') authorization?: string,
                   @Headers('x-metrics-token') token?: string): Promise<string> {
    const supplied = token ?? (authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined);
    const snapshot = await this.read(supplied);
    return formatPrometheus(snapshot);
  }

  onModuleDestroy(): void {
    this.sqs.destroy();
  }
}
