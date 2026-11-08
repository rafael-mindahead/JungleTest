import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { MikroORM } from '@mikro-orm/core';
import type { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { AppModule } from '../../src/app.module.js';

const integrationDescribe = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
type Kind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
interface Scope { playerId: string; walletId: string }
interface WagerInput {
  providerId: string; externalTransactionId: string; playerId: string;
  walletId: string; roundId: string; gameId: string; kind: Kind;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

integrationDescribe('Financial HTTP regression and adversarial cases', () => {
  let app: INestApplication;
  let orm: MikroORM<PostgreSqlDriver>;

  beforeAll(async () => {
    if (!process.env.DB_NAME?.endsWith('_test')) {
      throw new Error('Refusing financial regression tests outside disposable *_test DB');
    }
    process.env.SQS_WORKER_ENABLED = '0';
    process.env.OUTBOX_PUBLISHER_ENABLED = '0';
    process.env.REFERENCE_WORKER_ENABLED = '0';
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    await app.init();
    orm = app.get(MikroORM);
  });

  afterAll(async () => { if (app) await app.close(); });

  async function wallet(amount = '100.00'): Promise<Scope> {
    const playerId = randomUUID();
    const result = await request(app.getHttpServer()).post('/wallets').send({
      playerId, initialBalance: { amount, currency: 'BRL' },
    }).expect(201);
    return { playerId, walletId: result.body.id as string };
  }

  function wager(scope: Scope, kind: Kind, amount: string,
                 overrides: Partial<WagerInput> = {}): WagerInput {
    return {
      providerId: 'regression-' + scope.walletId,
      externalTransactionId: randomUUID(),
      playerId: scope.playerId, walletId: scope.walletId,
      roundId: 'regression-round', gameId: 'regression-game',
      kind, money: { amount, currency: 'BRL' }, ...overrides,
    };
  }
  const post = (body: object, key: string = randomUUID()) =>
    request(app.getHttpServer()).post('/wagering/transactions')
      .set('Idempotency-Key', key).send(body);

  async function count(table: 'wallet_ledger_entries' | 'wager_outbox' |
      'wager_transactions', walletId: string): Promise<number> {
    const column = table === 'wager_outbox' ? 'aggregate_id' : 'wallet_id';
    const rows = await orm.em.fork().execute<Array<{ n: string }>>(
      'SELECT COUNT(*)::text AS n FROM ' + table + ' WHERE ' + column + ' = ?',
      [walletId], 'all',
    );
    return Number(rows[0]?.n ?? 0);
  }
  async function reconciles(scope: Scope, expectedBalance: string): Promise<void> {
    const result = await request(app.getHttpServer())
      .post('/wallets/' + scope.walletId + '/reconciliation').expect(201);
    expect(result.body.consistent).toBe(true);
    expect(result.body.storedBalance.amount).toBe(expectedBalance);
    expect(result.body.calculatedBalance.amount).toBe(expectedBalance);
  }

  test('rejects malformed money, unsupported OPENING and missing key without database effects', async () => {
    const scope = await wallet();
    const base = wager(scope, 'BET', '1.00');
    const invalid: object[] = [
      { ...base, money: { amount: 1.00, currency: 'BRL' } },
      { ...base, money: { amount: '1e2', currency: 'BRL' } },
      { ...base, money: { amount: '1.001', currency: 'BRL' } },
      { ...base, money: { amount: '-1.00', currency: 'BRL' } },
      { ...base, kind: 'OPENING' },
      { ...base, playerId: 'not-a-uuid' },
    ];
    for (const body of invalid) {
      await post(body).expect(400);
    }
    await request(app.getHttpServer()).post('/wagering/transactions')
      .send(base).expect(400);
    expect(await count('wager_transactions', scope.walletId)).toBe(0);
    expect(await count('wallet_ledger_entries', scope.walletId)).toBe(1);
    expect(await count('wager_outbox', scope.walletId)).toBe(1);
    await reconciles(scope, '100.00');
  });

  test('same external transaction ID from different providers is isolated', async () => {
    const scope = await wallet();
    const externalTransactionId = randomUUID();
    const a = wager(scope, 'BET', '1.00', {
      providerId: 'provider-a-' + scope.walletId, externalTransactionId,
    });
    const b = wager(scope, 'BET', '1.00', {
      providerId: 'provider-b-' + scope.walletId, externalTransactionId,
    });
    const first = await post(a, 'provider-a:' + externalTransactionId).expect(200);
    const second = await post(b, 'provider-b:' + externalTransactionId).expect(200);
    expect(second.body.transactionId).not.toBe(first.body.transactionId);
    await request(app.getHttpServer())
      .get('/providers/' + a.providerId + '/wagering/transactions/' + externalTransactionId)
      .expect(200);
    expect(await count('wallet_ledger_entries', scope.walletId)).toBe(3);
    await reconciles(scope, '98.00');
  });

  test('REFUND enforces round and amount, and cannot reverse a BET twice', async () => {
    const scope = await wallet();
    const externalTransactionId = randomUUID();
    await post(wager(scope, 'BET', '25.00', { externalTransactionId })).expect(200);
    const wrongRound = await post(wager(scope, 'REFUND', '25.00', {
      referenceExternalTransactionId: externalTransactionId,
      roundId: 'another-round',
    })).expect(422);
    expect(wrongRound.body.failureCode).toBe('REFERENCE_SCOPE_MISMATCH');
    const wrongAmount = await post(wager(scope, 'REFUND', '26.00', {
      referenceExternalTransactionId: externalTransactionId,
    })).expect(422);
    expect(wrongAmount.body.failureCode).toBe('REVERSAL_AMOUNT_MISMATCH');
    const correct = await post(wager(scope, 'REFUND', '25.00', {
      referenceExternalTransactionId: externalTransactionId,
    })).expect(200);
    expect(correct.body.status).toBe('PROCESSED');
    const repeated = await post(wager(scope, 'REFUND', '25.00', {
      referenceExternalTransactionId: externalTransactionId,
    })).expect(422);
    expect(repeated.body.failureCode).toBe('ALREADY_REVERSED');
    expect(await count('wallet_ledger_entries', scope.walletId)).toBe(3);
    await reconciles(scope, '100.00');
  });

  test('ROLLBACK cannot drive a wallet negative after winnings are spent', async () => {
    const scope = await wallet('5.00');
    const winId = randomUUID();
    await post(wager(scope, 'WIN', '10.00', { externalTransactionId: winId }))
      .expect(200);
    await post(wager(scope, 'BET', '12.00')).expect(200);
    const reversal = await post(wager(scope, 'ROLLBACK', '10.00', {
      referenceExternalTransactionId: winId,
    })).expect(422);
    expect(reversal.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect(await count('wallet_ledger_entries', scope.walletId)).toBe(3);
    await reconciles(scope, '3.00');
  });

  test('two simultaneous REFUNDs of the same BET result in just one credit', async () => {
    const scope = await wallet();
    const betId = randomUUID();
    await post(wager(scope, 'BET', '30.00', { externalTransactionId: betId }))
      .expect(200);
    const refunds = await Promise.all([
      post(wager(scope, 'REFUND', '30.00', { referenceExternalTransactionId: betId })),
      post(wager(scope, 'REFUND', '30.00', { referenceExternalTransactionId: betId })),
    ]);
    expect(refunds.map(result => result.status).sort()).toEqual([200, 422]);
    expect(refunds.find(result => result.status === 422)?.body.failureCode)
      .toBe('ALREADY_REVERSED');
    expect(await count('wallet_ledger_entries', scope.walletId)).toBe(3);
    await reconciles(scope, '100.00');
  });

  test('ledger cursor pagination visits every entry exactly once', async () => {
    const scope = await wallet();
    await post(wager(scope, 'BET', '5.00')).expect(200);
    await post(wager(scope, 'WIN', '2.00')).expect(200);
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 6; i++) {
      const url = '/wallets/' + scope.walletId + '/ledger?limit=1' +
        (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const page = await request(app.getHttpServer()).get(url).expect(200);
      expect(page.body.entries.length).toBeGreaterThan(0);
      ids.push(page.body.entries[0].id as string);
      cursor = page.body.nextCursor as string | null;
      if (!cursor) break;
    }
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    await reconciles(scope, '97.00');
  });
});
