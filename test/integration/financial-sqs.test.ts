import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import type { PostgreSqlDriver } from '@mikro-orm/postgresql';
import {
  DeleteMessageCommand, GetQueueUrlCommand, ReceiveMessageCommand,
  SendMessageCommand, SQSClient,
} from '@aws-sdk/client-sqs';
import { AppModule } from '../../src/app.module.js';
import { Money } from '../../src/domain/shared/value-objects/money.js';
import { PostgresWalletRepository } from '../../src/infrastructure/wallets/postgres-wallet.repository.js';
import { WageringService } from '../../src/wagering/wagering.service.js';

const integrationDescribe = process.env.RUN_SQS_TESTS === '1' ? describe : describe.skip;

async function until(
  condition: () => Promise<boolean>,
  label: string,
  timeoutMs = 20000,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for ' + label);
}

integrationDescribe('Real MiniStack FIFO SQS -> Inbox -> PostgreSQL -> Outbox -> SQS', () => {
  let app: INestApplication;
  let orm: MikroORM<PostgreSqlDriver>;
  let wallets: PostgresWalletRepository;
  let wagers: WageringService;
  let sqs: SQSClient;
  let requestsQueueUrl: string;
  let eventsQueueUrl: string;

  beforeAll(async () => {
    if (!process.env.DB_NAME?.endsWith('_test')) {
      throw new Error('SQS integration test requires a disposable *_test database');
    }
    if (!process.env.SQS_ENDPOINT?.includes('127.0.0.1')) {
      throw new Error('SQS integration test must target the local emulator');
    }

    sqs = new SQSClient({
      endpoint: process.env.SQS_ENDPOINT,
      region: process.env.AWS_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });

    const requestQueue = await sqs.send(new GetQueueUrlCommand({
      QueueName: process.env.SQS_QUEUE_NAME ?? 'wager-transactions.fifo',
    }));
    const eventQueue = await sqs.send(new GetQueueUrlCommand({
      QueueName: process.env.SQS_EVENTS_QUEUE_NAME ?? 'wager-events.fifo',
    }));
    if (!requestQueue.QueueUrl || !eventQueue.QueueUrl) {
      throw new Error('SQS queues missing: run bun run sqs:setup first');
    }
    requestsQueueUrl = requestQueue.QueueUrl;
    eventsQueueUrl = eventQueue.QueueUrl;

    process.env.SQS_WORKER_ENABLED = '1';
    process.env.OUTBOX_PUBLISHER_ENABLED = '1';
    process.env.REFERENCE_WORKER_ENABLED = '0';
    const testing = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = testing.createNestApplication();
    await app.init();

    orm = app.get(MikroORM);
    wallets = app.get(PostgresWalletRepository);
    wagers = app.get(WageringService);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (sqs) sqs.destroy();
  });

  test('consumes BET once, records Inbox and ledger, and publishes both outbox events', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await wallets.create({
      walletId, playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    const externalId = randomUUID();
    const messageId = randomUUID();
    const idempotencyKey = randomUUID();
    const body = {
      providerId: 'integration-sqs-' + walletId,
      externalTransactionId: externalId,
      playerId, walletId,
      roundId: 'sqs-round',
      gameId: 'sqs-game',
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
      idempotencyKey,
    };

    await sqs.send(new SendMessageCommand({
      QueueUrl: requestsQueueUrl,
      MessageGroupId: walletId,
      MessageDeduplicationId: messageId,
      MessageBody: JSON.stringify({
        type: 'WagerTransactionRequested',
        messageId,
        data: body,
      }),
    }));

    let transactionId = '';
    await until(async () => {
      const result = await wagers.getByExternal(body.providerId, externalId);
      if (result?.status !== 'PROCESSED') return false;
      transactionId = result.transactionId;
      return true;
    }, 'SQS input transaction settlement');

    expect((await wallets.findById(walletId))?.balance.toJSON().amount).toBe('70.00');
    const inbox = await orm.em.fork().execute<Array<{ transaction_id: string }>>(
      'SELECT transaction_id FROM wager_inbox WHERE consumer_name = ? AND message_id = ?',
      ['wager-processor', messageId], 'all',
    );
    expect(inbox).toHaveLength(1);
    expect(inbox[0].transaction_id).toBe(transactionId);

    const ledger = await orm.em.fork().execute<Array<{ n: string }>>(
      'SELECT COUNT(*)::text AS n FROM wallet_ledger_entries WHERE wallet_id = ?',
      [walletId], 'all',
    );
    expect(Number(ledger[0].n)).toBe(2);

    await until(async () => {
      const rows = await orm.em.fork().execute<Array<{ published: string }>>(
        'SELECT COUNT(*)::text AS published FROM wager_outbox ' +
        'WHERE aggregate_id = ? AND published_at IS NOT NULL',
        [walletId], 'all',
      );
      return Number(rows[0]?.published ?? 0) === 2;
    }, 'Outbox publisher marking transaction events as published');

    const types = new Set<string>();
    const end = Date.now() + 15000;
    while (Date.now() < end && types.size < 2) {
      const received = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: eventsQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 5,
      }));
      for (const msg of received.Messages ?? []) {
        try {
          const parsed = JSON.parse(msg.Body ?? '{}') as {
            correlationId?: string; eventType?: string;
          };
          if (parsed.correlationId === transactionId && parsed.eventType) {
            types.add(parsed.eventType);
          }
        } finally {
          if (msg.ReceiptHandle) {
            await sqs.send(new DeleteMessageCommand({
              QueueUrl: eventsQueueUrl, ReceiptHandle: msg.ReceiptHandle,
            }));
          }
        }
      }
    }
    expect([...types].sort()).toEqual([
      'WagerTransactionProcessed', 'WalletBalanceChanged',
    ].sort());

    // Replay the same logical event via a new SQS delivery and another FIFO deduplication ID.
    // Transaction identity is checked by the database, not by SQS's deduplication window.
    await sqs.send(new SendMessageCommand({
      QueueUrl: requestsQueueUrl,
      MessageGroupId: walletId,
      MessageDeduplicationId: randomUUID(),
      MessageBody: JSON.stringify({
        type: 'WagerTransactionRequested', messageId, data: body,
      }),
    }));
    await until(async () => {
      const [inboxRows, ledgerRows] = await Promise.all([
        orm.em.fork().execute<Array<{ n: string }>>(
          'SELECT COUNT(*)::text AS n FROM wager_inbox WHERE consumer_name = ? AND message_id = ?',
          ['wager-processor', messageId], 'all',
        ),
        orm.em.fork().execute<Array<{ n: string }>>(
          'SELECT COUNT(*)::text AS n FROM wallet_ledger_entries WHERE wallet_id = ?',
          [walletId], 'all',
        ),
      ]);
      return Number(inboxRows[0]?.n) === 1 && Number(ledgerRows[0]?.n) === 2;
    }, 'Inbox replay idempotency');
    expect((await wallets.findById(walletId))?.balance.toJSON().amount).toBe('70.00');
  }, 60000);
});
