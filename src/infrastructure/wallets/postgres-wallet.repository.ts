import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import type { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Money } from '../../domain/shared/value-objects/money.js';
import { CurrencyMismatchError } from '../../domain/shared/errors/money.errors.js';
import { Wallet } from '../../domain/wallets/wallet.js';
import { LedgerDirection } from '../../domain/wallets/wallet-ledger-entry.js';
import { InvalidWalletAmountError } from '../../domain/wallets/wallet.errors.js';

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface LedgerRow {
  id: string;
  direction: string;
  currency: string;
  amount: string;
  balance_after: string;
}

export class WalletNotFoundError extends Error {
  constructor(walletId: string) {
    super('Wallet not found: ' + walletId);
    this.name = 'WalletNotFoundError';
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('Transaction ID already used with a different movement');
    this.name = 'IdempotencyConflictError';
  }
}

export interface CreateWalletInput {
  readonly walletId: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly openingTransactionId?: string;
  readonly openingEntryId?: string;
}

export interface ApplyMovementInput {
  readonly walletId: string;
  readonly transactionId: string;
  readonly amount: Money;
  readonly direction: LedgerDirection;
  readonly entryId?: string;
}

export interface AppliedMovement {
  readonly walletId: string;
  readonly transactionId: string;
  readonly ledgerEntryId: string;
  readonly replayed: boolean;
  readonly currentBalance: string;
  readonly currentVersion: number;
  readonly balanceAfterMovement: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: string | undefined, name: string): asserts value is string {
  if (!value || !UUID_PATTERN.test(value)) {
    throw new InvalidWalletAmountError(name + ' must be a UUID');
  }
}

function mapWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.player_id,
    currency: row.currency,
    balance: Money.from({ amount: String(row.balance), currency: row.currency }),
    version: Number(row.version),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  });
}

/**
 * Production persistence boundary for a single wallet.
 *
 * Invariant: wallet row lock -> idempotency check -> domain transition ->
 * balance/version update -> append-only ledger INSERT -> COMMIT.
 * Concurrent requests must use independent transactional EntityManagers.
 */
export class PostgresWalletRepository {
  constructor(private readonly orm: MikroORM<PostgreSqlDriver>) {}

  async create(input: CreateWalletInput): Promise<Wallet> {
    requireUuid(input.walletId, 'walletId');
    requireUuid(input.playerId, 'playerId');

    const wallet = Wallet.open({
      id: input.walletId,
      playerId: input.playerId,
      initialBalance: input.initialBalance,
    });

    const entryId = input.openingEntryId ?? randomUUID();
    const transactionId = input.openingTransactionId ?? randomUUID();
    if (!input.initialBalance.isZero()) {
      requireUuid(entryId, 'openingEntryId');
      requireUuid(transactionId, 'openingTransactionId');
    }
    const opening = wallet.createOpeningLedgerEntry({ id: entryId, transactionId });

    await this.orm.em.fork().transactional(async (em) => {
      await em.execute([
        'INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)',
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
      ].join(' '), [
        wallet.id,
        wallet.playerId,
        wallet.currency,
        wallet.balance.toJSON().amount,
        wallet.version,
        wallet.createdAt,
        wallet.updatedAt,
      ], 'run');

      if (opening) {
        await em.execute([
          'INSERT INTO wallet_ledger_entries',
          '(id, wallet_id, transaction_id, direction, currency, amount,',
          'balance_before, balance_after, created_at)',
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ].join(' '), [
          opening.id, opening.walletId, opening.transactionId,
          opening.direction, opening.money.currency, opening.money.toJSON().amount,
          opening.balanceBefore.toJSON().amount, opening.balanceAfter.toJSON().amount,
          opening.createdAt,
        ], 'run');
      }
    }, { clear: true });

    return wallet;
  }

  async findById(walletId: string): Promise<Wallet | null> {
    requireUuid(walletId, 'walletId');
    const rows = await this.orm.em.fork().execute<WalletRow[]>(
      'SELECT * FROM wallets WHERE id = ?',
      [walletId],
      'all',
    );
    return rows[0] ? mapWallet(rows[0]) : null;
  }

  async apply(input: ApplyMovementInput): Promise<AppliedMovement> {
    requireUuid(input.walletId, 'walletId');
    requireUuid(input.transactionId, 'transactionId');
    if (input.entryId) requireUuid(input.entryId, 'entryId');
    if (!input.amount.isPositive()) throw new InvalidWalletAmountError();
    if (input.direction !== LedgerDirection.Debit && input.direction !== LedgerDirection.Credit) {
      throw new InvalidWalletAmountError('Unsupported movement direction');
    }

    return this.orm.em.fork().transactional(async (em) => {
      // SELECT FOR UPDATE serializes transactions targeting the same wallet row.
      // The second contender reads the balance committed by the first.
      const rows = await em.execute<WalletRow[]>(
        'SELECT * FROM wallets WHERE id = ? FOR UPDATE',
        [input.walletId],
        'all',
      );
      if (!rows[0]) throw new WalletNotFoundError(input.walletId);
      const wallet = mapWallet(rows[0]);

      if (wallet.currency !== input.amount.currency) {
        throw new CurrencyMismatchError(wallet.currency, input.amount.currency);
      }

      // Checking after the row lock makes duplicate retries deterministic.
      const duplicates = await em.execute<LedgerRow[]>([
        'SELECT id, direction, currency, amount, balance_after',
        'FROM wallet_ledger_entries WHERE wallet_id = ? AND transaction_id = ?',
      ].join(' '), [input.walletId, input.transactionId], 'all');

      if (duplicates[0]) {
        const previous = duplicates[0];
        if (
          previous.direction !== input.direction ||
          previous.currency !== input.amount.currency ||
          String(previous.amount) !== input.amount.toJSON().amount
        ) {
          throw new IdempotencyConflictError();
        }
        return {
          walletId: wallet.id,
          transactionId: input.transactionId,
          ledgerEntryId: previous.id,
          replayed: true,
          currentBalance: wallet.balance.toJSON().amount,
          currentVersion: wallet.version,
          balanceAfterMovement: String(previous.balance_after),
        };
      }

      const entryId = input.entryId ?? randomUUID();
      const entry = input.direction === LedgerDirection.Credit
        ? wallet.credit({ id: entryId, transactionId: input.transactionId, money: input.amount })
        : wallet.debit({ id: entryId, transactionId: input.transactionId, money: input.amount });

      const updated = await em.execute<Array<{ id: string }>>([
        'UPDATE wallets SET balance = ?, version = ?, updated_at = ?',
        'WHERE id = ? AND version = ? RETURNING id',
      ].join(' '), [
        wallet.balance.toJSON().amount,
        wallet.version,
        wallet.updatedAt,
        wallet.id,
        wallet.version - 1,
      ], 'all');
      if (updated.length !== 1) {
        throw new Error('Wallet version changed unexpectedly');
      }

      await em.execute([
        'INSERT INTO wallet_ledger_entries',
        '(id, wallet_id, transaction_id, direction, currency, amount,',
        'balance_before, balance_after, created_at)',
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ].join(' '), [
        entry.id, entry.walletId, entry.transactionId,
        entry.direction, entry.money.currency, entry.money.toJSON().amount,
        entry.balanceBefore.toJSON().amount, entry.balanceAfter.toJSON().amount,
        entry.createdAt,
      ], 'run');

      return {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        ledgerEntryId: entry.id,
        replayed: false,
        currentBalance: wallet.balance.toJSON().amount,
        currentVersion: wallet.version,
        balanceAfterMovement: entry.balanceAfter.toJSON().amount,
      };
    }, { clear: true });
  }
}
