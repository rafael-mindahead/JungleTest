import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { MikroORM } from '@mikro-orm/core';
import type { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { AppModule } from '../../src/app.module.js';
import { WageringService } from '../../src/wagering/wagering.service.js';

type TransactionKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
interface WagerBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: TransactionKind;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

const integrationDescribe = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

integrationDescribe('Financial HTTP API against real PostgreSQL', () => {
  let app: INestApplication;
  let orm: MikroORM<PostgreSqlDriver>;
  let service: WageringService;

  beforeAll(async () => {
    if (!process.env.DB_NAME?.endsWith('_test')) {
      throw new Error('Refusing financial integration tests outside a disposable *_test database');
    }
    // Worker loops are tested separately against MiniStack, not in HTTP-only tests.
    process.env.SQS_WORKER_ENABLED = '0';
    process.env.OUTBOX_PUBLISHER_ENABLED = '0';
    process.env.REFERENCE_WORKER_ENABLED = '0';
    const testing = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = testing.createNestApplication();
    await app.init();
    orm = app.get(MikroORM);
    service = app.get(WageringService);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function createWallet(amount = '100.00') {
    const playerId = randomUUID();
    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, initialBalance: { amount, currency: 'BRL' } })
      .expect(201);
    const walletId = response.body.id as string;
    expect(walletId).toBeTruthy();
    return { playerId, walletId };
  }

  function wager(
    scope: { playerId: string; walletId: string },
    kind: TransactionKind,
    amount: string,
    overrides: Partial<WagerBody> = {},
  ): WagerBody {
    return {
      providerId: 'api-integration-' + scope.walletId,
      externalTransactionId: randomUUID(),
      playerId: scope.playerId,
      walletId: scope.walletId,
      roundId: 'test-round-1',
      gameId: 'test-game-1',
      kind,
      money: { amount, currency: 'BRL' },
      ...overrides,
    };
  }

  const post = (body: WagerBody, key = randomUUID()) =>
    request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(body);

  async function balance(walletId: string): Promise<string> {
    const result = await request(app.getHttpServer())
      .get('/wallets/' + walletId)
      .expect(200);
    return result.body.balance.amount as string;
  }

  async function count(table: 'wallet_ledger_entries' | 'wager_outbox' | 'wager_inbox', walletId: string) {
    if (table === 'wager_inbox') throw new Error('Inbox is keyed by message, not wallet');
    const column = table === 'wager_outbox' ? 'aggregate_id' : 'wallet_id';
    const rows = await orm.em.fork().execute<Array<{ n: string }>>(
      'SELECT COUNT(*)::text AS n FROM ' + table + ' WHERE ' + column + ' = ?',
      [walletId], 'all',
    );
    return Number(rows[0]?.n ?? 0);
  }

  test('creates a wallet with an opening ledger and reconciles it', async () => {
    const scope = await createWallet('100.00');
    const ledger = await request(app.getHttpServer())
      .get('/wallets/' + scope.walletId + '/ledger')
      .expect(200);
    expect(ledger.body.entries).toHaveLength(1);
    expect(ledger.body.entries[0].direction).toBe('CREDIT');
    const reconciliation = await request(app.getHttpServer())
      .post('/wallets/' + scope.walletId + '/reconciliation')
      .expect(201);
    expect(reconciliation.body.consistent).toBe(true);
    expect(reconciliation.body.calculatedBalance.amount).toBe('100.00');
  });

  test('BET is idempotent, with ledger and outbox committed only once', async () => {
    const scope = await createWallet();
    const body = wager(scope, 'BET', '25.00');
    const key = randomUUID();
    const first = await post(body, key).expect(200);
    expect(first.body.status).toBe('PROCESSED');
    expect(first.body.balance.amount).toBe('75.00');
    const duplicate = await post(body, key).expect(200);
    expect(duplicate.body.idempotentReplay).toBe(true);
    expect(duplicate.body.transactionId).toBe(first.body.transactionId);
    const conflict = await post({ ...body, money: { amount: '26.00', currency: 'BRL' } }, key)
      .expect(409);
    expect(conflict.body).toBeTruthy();
    expect(await balance(scope.walletId)).toBe('75.00');
    expect(await count('wallet_ledger_entries', scope.walletId)).toBe(2);
    expect(await count('wager_outbox', scope.walletId)).toBe(2);
    const fetched = await request(app.getHttpServer())
      .get('/wagering/transactions/' + first.body.transactionId)
      .expect(200);
    expect(fetched.body.status).toBe('PROCESSED');
  });

  test('two concurrent BET requests cannot overdraw a wallet', async () => {
    const scope = await createWallet();
    const bets = await Promise.all([
      post(wager(scope, 'BET', '80.00')),
      post(wager(scope, 'BET', '80.00')),
    ]);
    expect(bets.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(bets.find((r) => r.status === 422)?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await balance(scope.walletId)).toBe('20.00');
    expect(await count('wallet_ledger_entries', scope.walletId)).toBe(2);
    expect(await count('wager_outbox', scope.walletId)).toBe(3);
  });

  test('out-of-order REFUND is pending, then settles when its BET arrives', async () => {
    const scope = await createWallet();
    const externalId = randomUUID();
    const refund = wager(scope, 'REFUND', '40.00', {
      referenceExternalTransactionId: externalId,
    });
    const pending = await post(refund).expect(202);
    expect(pending.body.status).toBe('PENDING_REFERENCE');
    expect(await balance(scope.walletId)).toBe('100.00');

    await post(wager(scope, 'BET', '40.00', { externalTransactionId: externalId }))
      .expect(200);
    // The reference worker normally waits with backoff; advance ONLY this test row.
    await orm.em.fork().execute(
      'UPDATE wager_transactions SET next_attempt_at = NOW() WHERE id = ?',
      [pending.body.transactionId], 'run',
    );
    expect(await service.retryPending(10)).toBeGreaterThanOrEqual(1);
    const resolved = await request(app.getHttpServer())
      .get('/wagering/transactions/' + pending.body.transactionId)
      .expect(200);
    expect(resolved.body.status).toBe('PROCESSED');
    expect(await balance(scope.walletId)).toBe('100.00');
    const reconciled = await request(app.getHttpServer())
      .post('/wallets/' + scope.walletId + '/reconciliation')
      .expect(201);
    expect(reconciled.body.consistent).toBe(true);
    expect(await count('wallet_ledger_entries', scope.walletId)).toBe(3);
  });

  test('LOSS causes no movement, WIN credits and ROLLBACK reverses WIN', async () => {
    const scope = await createWallet();
    const loss = await post(wager(scope, 'LOSS', '10.00')).expect(200);
    expect(loss.body.status).toBe('PROCESSED');
    expect(await balance(scope.walletId)).toBe('100.00');
    const winExternalId = randomUUID();
    await post(wager(scope, 'WIN', '15.00', { externalTransactionId: winExternalId }))
      .expect(200);
    expect(await balance(scope.walletId)).toBe('115.00');
    const rollback = await post(wager(scope, 'ROLLBACK', '15.00', {
      referenceExternalTransactionId: winExternalId,
    })).expect(200);
    expect(rollback.body.status).toBe('PROCESSED');
    expect(await balance(scope.walletId)).toBe('100.00');
    expect(await count('wallet_ledger_entries', scope.walletId)).toBe(3);
  });

  test('Inbox stores a processed message once and rejects conflicting replay', async () => {
    const scope = await createWallet();
    const body = wager(scope, 'BET', '1.00');
    const messageId = randomUUID();
    const key = randomUUID();
    const first = await service.submit(body, key, { consumerName: 'test-consumer', messageId });
    const replay = await service.submit(body, key, { consumerName: 'test-consumer', messageId });
    expect(first.status).toBe('PROCESSED');
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    await expect(service.submit(
      { ...body, money: { amount: '2.00', currency: 'BRL' } }, key,
      { consumerName: 'test-consumer', messageId },
    )).rejects.toThrow();
    expect(await balance(scope.walletId)).toBe('99.00');
    const inbox = await orm.em.fork().execute<Array<{ transaction_id: string }>>(
      'SELECT transaction_id FROM wager_inbox WHERE consumer_name = ? AND message_id = ?',
      ['test-consumer', messageId], 'all',
    );
    expect(inbox).toHaveLength(1);
    expect(inbox[0].transaction_id).toBe(first.transactionId);
  });
  test('reconciliation remains consistent while independent HTTP wagers commit', async () => {
    const scope = await createWallet('100.00');
    const operations = Array.from({ length: 12 }, () =>
      post(wager(scope, 'BET', '1.00')));
    const snapshots = Array.from({ length: 12 }, () =>
      request(app.getHttpServer())
        .post('/wallets/' + scope.walletId + '/reconciliation')
        .expect(201));
    const [wagers, reconciliations] = await Promise.all([
      Promise.all(operations), Promise.all(snapshots),
    ]);
    expect(wagers.every(response => response.status === 200)).toBe(true);
    expect(reconciliations.every(response => response.body.consistent === true)).toBe(true);
    const final = await request(app.getHttpServer())
      .post('/wallets/' + scope.walletId + '/reconciliation').expect(201);
    expect(final.body.consistent).toBe(true);
    expect(final.body.storedBalance.amount).toBe('88.00');
    expect(final.body.calculatedBalance.amount).toBe('88.00');
    expect(await count('wallet_ledger_entries', scope.walletId)).toBe(13);
  });

  test('HTTP errors include stable codes and traceable correlation IDs', async () => {
    const response = await request(app.getHttpServer())
      .get('/wallets/not-a-uuid')
      .set('X-Correlation-Id', 'client-request-42')
      .expect(400);
    expect(response.headers['x-correlation-id']).toBe('client-request-42');
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.correlationId).toBe('client-request-42');
    const unsafe = await request(app.getHttpServer())
      .get('/wallets/not-a-uuid')
      .set('X-Correlation-Id', 'bad value with spaces')
      .expect(400);
    expect(unsafe.body.error.correlationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(unsafe.headers['x-correlation-id']).toBe(unsafe.body.error.correlationId);
  });

});
