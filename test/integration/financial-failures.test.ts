import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import type { PostgreSqlDriver } from '@mikro-orm/postgresql';
import {
  DeleteMessageCommand, GetQueueAttributesCommand, GetQueueUrlCommand,
  ReceiveMessageCommand, SendMessageCommand, SQSClient,
} from '@aws-sdk/client-sqs';
import { AppModule } from '../../src/app.module.js';
import { Money } from '../../src/domain/shared/value-objects/money.js';
import { PostgresWalletRepository } from '../../src/infrastructure/wallets/postgres-wallet.repository.js';
import { WageringService } from '../../src/wagering/wagering.service.js';

const onlyWithSqs = process.env.RUN_SQS_TESTS === '1' ? describe : describe.skip;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(fn: () => Promise<boolean>, label: string, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(250);
  }
  throw new Error('Timeout: ' + label);
}

onlyWithSqs('SQS crash, DLQ and publisher recovery against MiniStack', () => {
  let sqs: SQSClient;
  let requestUrl: string;
  let eventsUrl: string;
  let dlqUrl: string;
  const live: INestApplication[] = [];

  async function startApp(consumer: boolean, publisher: boolean): Promise<INestApplication> {
    process.env.SQS_WORKER_ENABLED = consumer ? '1' : '0';
    process.env.OUTBOX_PUBLISHER_ENABLED = publisher ? '1' : '0';
    process.env.REFERENCE_WORKER_ENABLED = '0';
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = module.createNestApplication();
    await app.init();
    live.push(app);
    return app;
  }
  async function stopApp(app: INestApplication) {
    await app.close();
    const i = live.indexOf(app);
    if (i >= 0) live.splice(i, 1);
  }
  async function rows<T extends object>(app: INestApplication, sql: string, args: unknown[] = []) {
    return app.get<MikroORM<PostgreSqlDriver>>(MikroORM).em.fork().execute<T[]>(sql, args, 'all');
  }
  async function amount(app: INestApplication, walletId: string): Promise<string> {
    const wallet = await app.get(PostgresWalletRepository).findById(walletId);
    if (!wallet) throw new Error('Missing wallet');
    return wallet.balance.toJSON().amount;
  }

  beforeAll(async () => {
    if (!process.env.DB_NAME?.endsWith('_test') ||
        !process.env.SQS_ENDPOINT?.startsWith('http://127.0.0.1:')) {
      throw new Error('Failure tests require disposable test DB and loopback MiniStack');
    }
    process.env.SQS_VISIBILITY_TIMEOUT_SECONDS = '1';
    sqs = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.SQS_ENDPOINT,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
    for (const [name, queue] of [
      ['request', process.env.SQS_QUEUE_NAME ?? 'wager-transactions.fifo'],
      ['events', process.env.SQS_EVENTS_QUEUE_NAME ?? 'wager-events.fifo'],
      ['dlq', process.env.SQS_DLQ_NAME ?? 'wager-transactions-dlq.fifo'],
    ] as const) {
      const r = await sqs.send(new GetQueueUrlCommand({ QueueName: queue }));
      if (!r.QueueUrl) throw new Error('Missing ' + name + ' queue');
      if (name === 'request') requestUrl = r.QueueUrl;
      if (name === 'events') eventsUrl = r.QueueUrl;
      if (name === 'dlq') dlqUrl = r.QueueUrl;
    }
  });

  afterAll(async () => {
    for (const app of [...live]) await stopApp(app);
    sqs?.destroy();
  });

  test('genuine process death after COMMIT and before ACK redelivers without double debit', async () => {
    const app = await startApp(false, false);
    const playerId = randomUUID();
    const walletId = randomUUID();
    await app.get(PostgresWalletRepository).create({
      walletId, playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    const externalTransactionId = randomUUID();
    const messageId = randomUUID();
    const payload = {
      providerId: 'crash-' + walletId,
      externalTransactionId,
      idempotencyKey: randomUUID(),
      playerId, walletId, roundId: 'crash-round', gameId: 'crash-game',
      kind: 'BET', money: { amount: '35.00', currency: 'BRL' },
    };
    await sqs.send(new SendMessageCommand({
      QueueUrl: requestUrl,
      MessageGroupId: walletId,
      MessageDeduplicationId: randomUUID(),
      MessageBody: JSON.stringify({
        messageId, type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(), data: payload,
      }),
    }));

    const child = spawn(process.execPath, ['run', 'test/helpers/crash-after-commit.ts'], {
      env: {
        ...process.env,
        SQS_WORKER_ENABLED: '0',
        OUTBOX_PUBLISHER_ENABLED: '0',
        REFERENCE_WORKER_ENABLED: '0',
      },
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let childOutput = '';
    child.stderr?.on('data', (chunk: Buffer) => { childOutput += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Crash helper timed out')); }, 15000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', exitCode => { clearTimeout(timer); resolve(exitCode); });
    });
    expect(code).toBe(17);
    expect(childOutput).toContain('CRASH_AFTER_FINANCIAL_COMMIT_BEFORE_SQS_ACK');

    expect(await amount(app, walletId)).toBe('65.00');
    const committed = await rows<{ n: string }>(app,
      'SELECT COUNT(*)::text AS n FROM wager_inbox WHERE message_id = ?', [messageId]);
    expect(Number(committed[0].n)).toBe(1);
    const alreadyCommitted = await rows<{ n: string }>(app,
      'SELECT COUNT(*)::text AS n FROM wallet_ledger_entries WHERE wallet_id = ?', [walletId]);
    expect(Number(alreadyCommitted[0].n)).toBe(2);

    // Start a NEW worker instance. A previously invisible message becomes visible again,
    // the durable Inbox prevents a second debit, and the worker acknowledges it.
    const worker = await startApp(true, true);
    await until(async () => {
      const r = await rows<{ n: string }>(app,
        'SELECT COUNT(*)::text AS n FROM wager_outbox WHERE aggregate_id = ? AND published_at IS NOT NULL',
        [walletId]);
      return Number(r[0].n) === 2;
    }, 'publisher after crash');
    await sleep(2500);
    expect(await amount(worker, walletId)).toBe('65.00');
    const ledger = await rows<{ n: string }>(app,
      'SELECT COUNT(*)::text AS n FROM wallet_ledger_entries WHERE wallet_id = ?', [walletId]);
    expect(Number(ledger[0].n)).toBe(2);
    const attrs = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: requestUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }));
    expect(Number(attrs.Attributes?.ApproximateNumberOfMessages ?? 0)).toBe(0);
    expect(Number(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)).toBe(0);
    await stopApp(worker);
    await stopApp(app);
  }, 45000);

  test('poison event is retried and moved to the configured DLQ', async () => {
    const worker = await startApp(true, false);
    const messageId = randomUUID();
    const walletId = randomUUID();
    await sqs.send(new SendMessageCommand({
      QueueUrl: requestUrl, MessageGroupId: walletId, MessageDeduplicationId: randomUUID(),
      MessageBody: JSON.stringify({
        type: 'WagerTransactionRequested', messageId,
        data: { providerId: 'bad-envelope' }, // intentionally missing fields and key
      }),
    }));
    let deadLetter: { Body?: string; ReceiptHandle?: string } | undefined;
    await until(async () => {
      const messages = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: dlqUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1,
        VisibilityTimeout: 5,
      }));
      deadLetter = messages.Messages?.find(m => m.Body?.includes(messageId));
      return Boolean(deadLetter);
    }, 'poison message moved to DLQ', 30000);
    expect(deadLetter?.Body).toContain(messageId);
    if (deadLetter?.ReceiptHandle) {
      await sqs.send(new DeleteMessageCommand({
        QueueUrl: dlqUrl, ReceiptHandle: deadLetter.ReceiptHandle,
      }));
    }
    await stopApp(worker);
  }, 40000);

  test('two independent Outbox publishers can recover pending events without losing rows', async () => {
    const seed = await startApp(false, false);
    const walletIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const playerId = randomUUID();
      const walletId = randomUUID();
      walletIds.push(walletId);
      await seed.get(PostgresWalletRepository).create({
        walletId, playerId,
        initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      });
      const r = await seed.get(WageringService).submit({
        providerId: 'publish-' + walletId,
        externalTransactionId: randomUUID(),
        playerId, walletId, roundId: 'publish-round', gameId: 'publish-game',
        kind: 'BET', money: { amount: '1.00', currency: 'BRL' },
      }, randomUUID());
      expect(r.status).toBe('PROCESSED');
    }
    const expected = walletIds.length * 2;
    const countBefore = await rows<{ n: string }>(seed,
      'SELECT COUNT(*)::text AS n FROM wager_outbox WHERE aggregate_id = ANY(?::uuid[]) AND published_at IS NULL',
      [walletIds]);
    expect(Number(countBefore[0].n)).toBe(expected);
    // The first instance stopped before the publisher came online; events remain durable.
    await stopApp(seed);
    const [publisherA, publisherB] = await Promise.all([
      startApp(false, true), startApp(false, true),
    ]);
    await until(async () => {
      const result = await rows<{ n: string }>(publisherA,
        'SELECT COUNT(*)::text AS n FROM wager_outbox WHERE aggregate_id = ANY(?::uuid[]) AND published_at IS NOT NULL',
        [walletIds]);
      return Number(result[0].n) === expected;
    }, 'parallel publishers drain persistent outbox', 30000);
    const pending = await rows<{ n: string }>(publisherA,
      'SELECT COUNT(*)::text AS n FROM wager_outbox WHERE aggregate_id = ANY(?::uuid[]) AND published_at IS NULL',
      [walletIds]);
    expect(Number(pending[0].n)).toBe(0);
    for (const walletId of walletIds) {
      expect(await amount(publisherA, walletId)).toBe('99.00');
    }
    await stopApp(publisherA);
    await stopApp(publisherB);
  }, 55000);
});
