import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { MikroORM, type EntityManager } from '@mikro-orm/core';
import type { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Money } from '../domain/shared/value-objects/money.js';
import { Wallet } from '../domain/wallets/wallet.js';
import { InsufficientFundsError } from '../domain/wallets/wallet.errors.js';
import { LedgerDirection, type WalletLedgerEntry } from '../domain/wallets/wallet-ledger-entry.js';
import {
  WalletBalanceChanged, WagerTransactionPendingReference,
  WagerTransactionProcessed, WagerTransactionRejected, type IntegrationEvent,
} from './integration-events.js';

type WagerKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
type WagerStatus = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';
const UUID_RE = /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

interface WagerInput {
  providerId: string; externalTransactionId: string; playerId: string;
  walletId: string; roundId: string; gameId: string; kind: WagerKind;
  money: Money; referenceExternalTransactionId?: string;
}
interface WagerRow {
  id: string; provider_id: string; external_transaction_id: string;
  idempotency_key: string; payload_hash: string; wallet_id: string;
  player_id: string; round_id: string; game_id: string;
  kind: WagerKind; currency: string; amount: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: WagerStatus; failure_code: string | null;
  result_balance: string | null; attempts: number;
}
interface WalletRow {
  id: string; player_id: string; currency: string; balance: string;
  version: number; created_at: Date; updated_at: Date;
}
interface InboxMeta { messageId: string; consumerName: string }
export interface WagerResult {
  transactionId: string; status: WagerStatus;
  balance: { amount: string; currency: string } | null;
  failureCode?: string; idempotentReplay: boolean;
}

function nonempty(value: unknown, name: string, maxLength = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new BadRequestException(name + ' must be a nonempty string (max ' + maxLength + ')');
  }
  return value;
}
function uuid(value: unknown, name: string): string {
  const v = nonempty(value, name);
  if (!UUID_RE.test(v)) throw new BadRequestException(name + ' must be UUID');
  return v.toLowerCase();
}
function parseInput(raw: unknown): WagerInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException('Body must be an object');
  }
  const input = raw as Record<string, unknown>;
  if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(String(input.kind))) {
    throw new BadRequestException('Invalid transaction kind');
  }
  if (!input.money || typeof input.money !== 'object' || Array.isArray(input.money)) {
    throw new BadRequestException('money must be a decimal amount and currency');
  }
  const monetary = input.money as Record<string, unknown>;
  let money: Money;
  try {
    money = Money.from({ amount: monetary.amount as string, currency: monetary.currency as string });
  } catch {
    throw new BadRequestException('Invalid money: require nonnegative decimal string with two places and ISO currency');
  }
  if (!money.isPositive()) throw new BadRequestException('Transaction amount must be positive');
  const kind = input.kind as WagerKind;
  const reference = input.referenceExternalTransactionId === undefined
    ? undefined : nonempty(input.referenceExternalTransactionId, 'referenceExternalTransactionId');
  if (['REFUND', 'ROLLBACK'].includes(kind) && !reference) {
    throw new BadRequestException('REFUND/ROLLBACK require referenceExternalTransactionId');
  }
  return {
    providerId: nonempty(input.providerId, 'providerId', 128),
    externalTransactionId: nonempty(input.externalTransactionId, 'externalTransactionId'),
    playerId: uuid(input.playerId, 'playerId'), walletId: uuid(input.walletId, 'walletId'),
    roundId: nonempty(input.roundId, 'roundId'), gameId: nonempty(input.gameId, 'gameId'),
    kind, money, referenceExternalTransactionId: reference,
  };
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((k) => [k, sorted(record[k])]));
  }
  return value;
}
function payloadHash(input: WagerInput): string {
  const canonical = {
    providerId: input.providerId, externalTransactionId: input.externalTransactionId,
    walletId: input.walletId, playerId: input.playerId, roundId: input.roundId,
    gameId: input.gameId, kind: input.kind, money: input.money.toJSON(),
    ...(input.referenceExternalTransactionId
      ? { referenceExternalTransactionId: input.referenceExternalTransactionId } : {}),
  };
  return createHash('sha256').update(JSON.stringify(sorted(canonical))).digest('hex');
}
function fromRow(row: WagerRow): WagerInput {
  return {
    providerId: row.provider_id, externalTransactionId: row.external_transaction_id,
    playerId: row.player_id, walletId: row.wallet_id, roundId: row.round_id,
    gameId: row.game_id, kind: row.kind,
    money: Money.from({ amount: String(row.amount), currency: row.currency }),
    referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
  };
}
function response(row: WagerRow, replayed: boolean): WagerResult {
  return {
    transactionId: row.id, status: row.status,
    balance: row.result_balance == null
      ? null : { amount: String(row.result_balance), currency: row.currency },
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    idempotentReplay: replayed,
  };
}
function walletFromRow(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id, playerId: row.player_id, currency: row.currency,
    balance: Money.from({ amount: String(row.balance), currency: row.currency }),
    version: Number(row.version), createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  });
}
type EM = EntityManager<PostgreSqlDriver>;

@Injectable()
export class WageringService {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM<PostgreSqlDriver>) {}

  async submit(raw: unknown, idempotencyKey: string, inbox?: InboxMeta): Promise<WagerResult> {
    const input = parseInput(raw);
    const key = nonempty(idempotencyKey, 'Idempotency-Key', 250);
    const hash = payloadHash(input);
    if (inbox) {
      nonempty(inbox.messageId, 'messageId', 250);
      nonempty(inbox.consumerName, 'consumerName', 100);
    }
    return this.orm.em.fork().transactional(async (em) => {
      if (inbox) {
        const inserted = await em.execute<Array<{ message_id: string }>>(
          'INSERT INTO wager_inbox (consumer_name, message_id, payload_hash) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING message_id',
          [inbox.consumerName, inbox.messageId, hash], 'all',
        );
        if (!inserted.length) {
          const old = await em.execute<Array<{ payload_hash: string; transaction_id: string | null }>>(
            'SELECT payload_hash, transaction_id FROM wager_inbox WHERE consumer_name = ? AND message_id = ?',
            [inbox.consumerName, inbox.messageId], 'all',
          );
          if (!old[0] || old[0].payload_hash !== hash) {
            throw new ConflictException('Inbox message ID reused with conflicting payload');
          }
          if (!old[0].transaction_id) throw new Error('Committed inbox without transaction link');
          const existing = await em.execute<WagerRow[]>(
            'SELECT * FROM wager_transactions WHERE id = ?', [old[0].transaction_id], 'all',
          );
          if (!existing[0]) throw new Error('Inbox references missing transaction');
          return response(existing[0], true);
        }
      }

      const newId = randomUUID();
      const inserted = await em.execute<WagerRow[]>([
        'INSERT INTO wager_transactions',
        '(id, provider_id, external_transaction_id, idempotency_key, payload_hash,',
        'wallet_id, player_id, round_id, game_id, kind, currency, amount,',
        'reference_external_transaction_id, status)',
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')",
        'ON CONFLICT DO NOTHING RETURNING *',
      ].join(' '), [
        newId, input.providerId, input.externalTransactionId, key, hash,
        input.walletId, input.playerId, input.roundId, input.gameId,
        input.kind, input.money.currency, input.money.toJSON().amount,
        input.referenceExternalTransactionId ?? null,
      ], 'all');

      if (!inserted.length) {
        const existing = await em.execute<WagerRow[]>([
          'SELECT * FROM wager_transactions',
          'WHERE idempotency_key = ? OR (provider_id = ? AND external_transaction_id = ?)',
        ].join(' '), [key, input.providerId, input.externalTransactionId], 'all');
        if (!existing.length || existing.length !== 1 ||
            existing[0].idempotency_key !== key || existing[0].payload_hash !== hash) {
          throw new ConflictException('Idempotency-Key or provider transaction conflicts with prior payload');
        }
        if (inbox) await this.completeInbox(em, inbox, existing[0].id);
        return response(existing[0], true);
      }
      const result = await this.settle(em, inserted[0], input, false);
      if (inbox) await this.completeInbox(em, inbox, inserted[0].id);
      return result;
    }, { clear: true });
  }

  private async completeInbox(em: EM, inbox: InboxMeta, transactionId: string): Promise<void> {
    await em.execute([
      'UPDATE wager_inbox SET transaction_id = ?, processed_at = NOW()',
      'WHERE consumer_name = ? AND message_id = ?',
    ].join(' '), [transactionId, inbox.consumerName, inbox.messageId], 'run');
  }
  private async emit(em: EM, event: IntegrationEvent<Readonly<Record<string, unknown>>>): Promise<void> {
    const envelope = event.toJSON();
    await em.execute([
      'INSERT INTO wager_outbox (id, aggregate_id, event_type, payload)',
      'VALUES (?, ?, ?, ?::jsonb)',
    ].join(' '), [event.eventId, event.aggregateId, event.eventType, JSON.stringify(envelope)], 'run');
  }
  private async settle(em: EM, tx: WagerRow, input: WagerInput, retry: boolean): Promise<WagerResult> {
    const wallets = await em.execute<WalletRow[]>(
      'SELECT * FROM wallets WHERE id = ? FOR UPDATE', [tx.wallet_id], 'all',
    );
    if (!wallets.length) return this.reject(em, tx, 'WALLET_NOT_FOUND', null);
    const wallet = walletFromRow(wallets[0]);
    const initialBalance = wallet.balance.toJSON().amount;
    if (wallet.playerId !== input.playerId || wallet.currency !== input.money.currency) {
      return this.reject(em, tx, 'WALLET_SCOPE_MISMATCH', initialBalance);
    }
    let reference: WagerRow | undefined;
    if (input.referenceExternalTransactionId) {
      const found = await em.execute<WagerRow[]>([
        'SELECT * FROM wager_transactions',
        'WHERE provider_id = ? AND external_transaction_id = ?',
      ].join(' '), [input.providerId, input.referenceExternalTransactionId], 'all');
      reference = found[0];
      if (!reference || reference.status === 'PENDING' || reference.status === 'PENDING_REFERENCE') {
        if (tx.attempts >= 7) return this.reject(em, tx, 'REFERENCE_NOT_FOUND', initialBalance);
        const attempts = Number(tx.attempts) + 1;
        const seconds = Math.min(300, 2 ** attempts);
        await em.execute([
          "UPDATE wager_transactions SET status = 'PENDING_REFERENCE', attempts = ?,",
          "next_attempt_at = NOW() + (? * INTERVAL '1 second'), result_balance = ? WHERE id = ?",
        ].join(' '), [attempts, seconds, initialBalance, tx.id], 'run');
        if (!retry) {
          await this.emit(em, WagerTransactionPendingReference.from({
            aggregateId: tx.wallet_id, correlationId: tx.id,
            data: { transactionId: tx.id, providerId: tx.provider_id, kind: tx.kind },
          }));
        }
        return { transactionId: tx.id, status: 'PENDING_REFERENCE',
          balance: wallet.balance.toJSON(), idempotentReplay: false };
      }
      if (reference.id === tx.id || reference.status !== 'PROCESSED') {
        return this.reject(em, tx, 'REFERENCE_NOT_PROCESSED', initialBalance);
      }
      if (reference.wallet_id !== input.walletId || reference.player_id !== input.playerId ||
          reference.round_id !== input.roundId || reference.currency !== input.money.currency ||
          reference.provider_id !== input.providerId || reference.game_id !== input.gameId) {
        return this.reject(em, tx, 'REFERENCE_SCOPE_MISMATCH', initialBalance);
      }
      if (['REFUND', 'ROLLBACK'].includes(input.kind)) {
        if (String(reference.amount) !== input.money.toJSON().amount) {
          return this.reject(em, tx, 'REVERSAL_AMOUNT_MISMATCH', initialBalance);
        }
        if (input.kind === 'REFUND' && reference.kind !== 'BET') {
          return this.reject(em, tx, 'REFUND_REQUIRES_BET', initialBalance);
        }
        if (input.kind === 'ROLLBACK' && !['BET','WIN','REFUND'].includes(reference.kind)) {
          return this.reject(em, tx, 'INVALID_ROLLBACK_REFERENCE', initialBalance);
        }
        const reversed = await em.execute<Array<{ id: string }>>([
          'SELECT id FROM wager_transactions',
          "WHERE reference_transaction_id = ? AND kind = ? AND status = 'PROCESSED' LIMIT 1",
        ].join(' '), [reference.id, input.kind], 'all');
        if (reversed.length) return this.reject(em, tx, 'ALREADY_REVERSED', initialBalance);
      }
    }
    let direction: LedgerDirection | undefined;
    if (input.kind === 'BET') direction = LedgerDirection.Debit;
    if (input.kind === 'WIN' || input.kind === 'REFUND') direction = LedgerDirection.Credit;
    if (input.kind === 'ROLLBACK') {
      if (!reference) return this.reject(em, tx, 'REFERENCE_NOT_FOUND', initialBalance);
      direction = reference.kind === 'BET' ? LedgerDirection.Credit : LedgerDirection.Debit;
    }
    if (input.kind === 'WIN' && reference?.kind !== undefined && reference.kind !== 'BET') {
      return this.reject(em, tx, 'WIN_REQUIRES_BET', initialBalance);
    }
    let ledger: WalletLedgerEntry | undefined;
    try {
      if (direction === LedgerDirection.Credit) {
        ledger = wallet.credit({ id: randomUUID(), transactionId: tx.id, money: input.money });
      } else if (direction === LedgerDirection.Debit) {
        ledger = wallet.debit({ id: randomUUID(), transactionId: tx.id, money: input.money });
      }
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        return this.reject(em, tx,
          input.kind === 'ROLLBACK' ? 'REVERSAL_INSUFFICIENT_FUNDS' : 'INSUFFICIENT_FUNDS',
          initialBalance);
      }
      throw error;
    }
    if (ledger) {
      const updated = await em.execute<Array<{ id: string }>>([
        'UPDATE wallets SET balance = ?, version = ?, updated_at = ?',
        'WHERE id = ? AND version = ? RETURNING id',
      ].join(' '), [wallet.balance.toJSON().amount, wallet.version, wallet.updatedAt,
        wallet.id, wallet.version - 1], 'all');
      if (!updated.length) throw new Error('Unexpected wallet version conflict');
      await em.execute([
        'INSERT INTO wallet_ledger_entries',
        '(id, wallet_id, transaction_id, direction, currency, amount,',
        'balance_before, balance_after, created_at)',
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ].join(' '), [ledger.id, ledger.walletId, ledger.transactionId, ledger.direction,
        ledger.money.currency, ledger.money.toJSON().amount,
        ledger.balanceBefore.toJSON().amount, ledger.balanceAfter.toJSON().amount,
        ledger.createdAt], 'run');
    }
    await em.execute([
      "UPDATE wager_transactions SET status = 'PROCESSED', processed_at = NOW(),",
      'reference_transaction_id = ?, result_balance = ?, next_attempt_at = NULL WHERE id = ?',
    ].join(' '), [reference?.id ?? null, wallet.balance.toJSON().amount, tx.id], 'run');
    await this.emit(em, WagerTransactionProcessed.from({
      aggregateId: tx.wallet_id, correlationId: tx.id,
      data: { transactionId: tx.id, providerId: tx.provider_id, kind: tx.kind, status: 'PROCESSED' },
    }));
    if (ledger) {
      await this.emit(em, WalletBalanceChanged.from({
        aggregateId: tx.wallet_id, correlationId: tx.id,
        data: { transactionId: tx.id, walletId: wallet.id,
          direction: ledger.direction, money: ledger.money.toJSON(),
          balanceBefore: ledger.balanceBefore.toJSON(),
          balanceAfter: ledger.balanceAfter.toJSON(), walletVersion: wallet.version },
      }));
    }
    return { transactionId: tx.id, status: 'PROCESSED',
      balance: wallet.balance.toJSON(), idempotentReplay: false };
  }
  private async reject(em: EM, tx: WagerRow, code: string,
                       amount: string | null): Promise<WagerResult> {
    await em.execute([
      "UPDATE wager_transactions SET status = 'REJECTED', failure_code = ?,",
      'result_balance = ?, processed_at = NOW(), next_attempt_at = NULL WHERE id = ?',
    ].join(' '), [code, amount, tx.id], 'run');
    await this.emit(em, WagerTransactionRejected.from({
      aggregateId: tx.wallet_id, correlationId: tx.id,
      data: { transactionId: tx.id, providerId: tx.provider_id, failureCode: code },
    }));
    return { transactionId: tx.id, status: 'REJECTED',
      balance: amount === null ? null : { amount, currency: tx.currency },
      failureCode: code, idempotentReplay: false };
  }
  async retryPending(max = 10): Promise<number> {
    let count = 0;
    for (let i = 0; i < max; i++) {
      const didProcess = await this.orm.em.fork().transactional(async (em) => {
        const pending = await em.execute<WagerRow[]>([
          'SELECT * FROM wager_transactions',
          "WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= NOW()",
          'ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1',
        ].join(' '), [], 'all');
        if (!pending.length) return false;
        await this.settle(em, pending[0], fromRow(pending[0]), true);
        return true;
      }, { clear: true });
      if (!didProcess) break;
      count++;
    }
    return count;
  }
  async getById(id: string): Promise<WagerResult | null> {
    const rows = await this.orm.em.fork().execute<WagerRow[]>(
      'SELECT * FROM wager_transactions WHERE id = ?', [uuid(id, 'transactionId')], 'all');
    return rows[0] ? response(rows[0], false) : null;
  }
  async getByExternal(providerId: string, externalId: string): Promise<WagerResult | null> {
    const rows = await this.orm.em.fork().execute<WagerRow[]>([
      'SELECT * FROM wager_transactions',
      'WHERE provider_id = ? AND external_transaction_id = ?',
    ].join(' '), [nonempty(providerId, 'providerId', 128),
      nonempty(externalId, 'externalTransactionId')], 'all');
    return rows[0] ? response(rows[0], false) : null;
  }
}
