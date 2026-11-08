import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/core';
import type { PostgreSqlDriver } from '@mikro-orm/postgresql';
import ormConfig from '../../src/database/mikro-orm.config.js';
import { Money } from '../../src/domain/shared/value-objects/money.js';
import { LedgerDirection } from '../../src/domain/wallets/wallet-ledger-entry.js';
import { InsufficientFundsError } from '../../src/domain/wallets/wallet.errors.js';
import {
  IdempotencyConflictError,
  PostgresWalletRepository,
} from '../../src/infrastructure/wallets/postgres-wallet.repository.js';

const integrationDescribe = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

integrationDescribe('PostgreSQL wallet concurrency (real database)', () => {
  let orm: MikroORM<PostgreSqlDriver>;
  let repository: PostgresWalletRepository;

  beforeAll(async () => {
    if (!process.env.DB_NAME?.endsWith('_test')) {
      throw new Error('Integration tests require DB_NAME ending with _test');
    }
    orm = await MikroORM.init(ormConfig);
    repository = new PostgresWalletRepository(orm);
  });

  afterAll(async () => {
    if (orm) await orm.close(true);
  });

  async function walletWithBalance(amount: string) {
    const walletId = randomUUID();
    await repository.create({
      walletId,
      playerId: randomUUID(),
      initialBalance: brl(amount),
      openingTransactionId: randomUUID(),
    });
    return walletId;
  }

  async function ledgerCount(walletId: string): Promise<number> {
    const rows = await orm.em.fork().execute<Array<{ count: string }>>(
      'SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE wallet_id = ?',
      [walletId],
      'all',
    );
    return Number(rows[0]?.count ?? 0);
  }

  test('two concurrent debits of 80 from 100: one succeeds, one fails', async () => {
    const walletId = await walletWithBalance('100.00');
    const submissions = [randomUUID(), randomUUID()].map((transactionId) =>
      repository.apply({
        walletId, transactionId, direction: LedgerDirection.Debit, amount: brl('80.00'),
      }),
    );
    const outcomes = await Promise.allSettled(submissions);
    const succeeded = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientFundsError);
    const wallet = await repository.findById(walletId);
    expect(wallet?.balance.toJSON().amount).toBe('20.00');
    expect(wallet?.version).toBe(2);
    expect(await ledgerCount(walletId)).toBe(2);
  });

  test('30 parallel debits of 1 from 10: exactly 10 succeed', async () => {
    const walletId = await walletWithBalance('10.00');
    const outcomes = await Promise.allSettled(
      Array.from({ length: 30 }, () => repository.apply({
        walletId,
        transactionId: randomUUID(),
        direction: LedgerDirection.Debit,
        amount: brl('1.00'),
      })),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(10);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(20);
    expect((await repository.findById(walletId))?.balance.toJSON().amount).toBe('0.00');
    expect((await repository.findById(walletId))?.version).toBe(11);
    expect(await ledgerCount(walletId)).toBe(11);
  });

  test('20 retries with the same transaction ID: apply just once', async () => {
    const walletId = await walletWithBalance('10.00');
    const transactionId = randomUUID();
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => repository.apply({
        walletId,
        transactionId,
        direction: LedgerDirection.Debit,
        amount: brl('1.00'),
      })),
    );
    expect(outcomes.filter((outcome) => !outcome.replayed)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.replayed)).toHaveLength(19);
    expect((await repository.findById(walletId))?.balance.toJSON().amount).toBe('9.00');
    expect(await ledgerCount(walletId)).toBe(2);
  });

  test('duplicate transaction ID with conflicting amount is rejected', async () => {
    const walletId = await walletWithBalance('100.00');
    const transactionId = randomUUID();
    await repository.apply({
      walletId, transactionId, direction: LedgerDirection.Debit, amount: brl('10.00'),
    });
    await expect(repository.apply({
      walletId, transactionId, direction: LedgerDirection.Debit, amount: brl('20.00'),
    })).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect((await repository.findById(walletId))?.balance.toJSON().amount).toBe('90.00');
    expect(await ledgerCount(walletId)).toBe(2);
  });

  test('DB trigger rejects UPDATE and DELETE of an existing ledger entry', async () => {
    const walletId = await walletWithBalance('5.00');
    const rows = await orm.em.fork().execute<Array<{ id: string }>>(
      'SELECT id FROM wallet_ledger_entries WHERE wallet_id = ?',
      [walletId], 'all',
    );
    const id = rows[0].id;
    await expect(orm.em.fork().execute(
      'UPDATE wallet_ledger_entries SET amount = ? WHERE id = ?',
      ['4.00', id], 'run',
    )).rejects.toThrow();
    await expect(orm.em.fork().execute(
      'DELETE FROM wallet_ledger_entries WHERE id = ?',
      [id], 'run',
    )).rejects.toThrow();
    expect(await ledgerCount(walletId)).toBe(1);
  });

  test('DB constraint rejects negative balance even outside domain code', async () => {
    const walletId = await walletWithBalance('5.00');
    await expect(orm.em.fork().execute(
      'UPDATE wallets SET balance = ? WHERE id = ?',
      ['-1.00', walletId], 'run',
    )).rejects.toThrow();
    expect((await repository.findById(walletId))?.balance.toJSON().amount).toBe('5.00');
  });
});
