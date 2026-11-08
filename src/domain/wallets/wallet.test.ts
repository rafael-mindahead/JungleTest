import { describe, expect, test } from 'bun:test';
import { Money } from '../shared/value-objects/money.js';
import { CurrencyMismatchError } from '../shared/errors/money.errors.js';
import { Wallet } from './wallet.js';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.js';
import {
  InsufficientFundsError,
  InvalidLedgerEntryError,
  InvalidWalletAmountError,
} from './wallet.errors.js';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });
const at = new Date('2026-11-08T12:00:00.000Z');

function open(amount = '100.00'): Wallet {
  return Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl(amount), at });
}

describe('Wallet aggregate', () => {
  test('opens with version 1 and an exact balance', () => {
    const wallet = open();
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
  });

  test('creates exactly one balanced opening entry for non-zero initial credit', () => {
    const entry = open().createOpeningLedgerEntry({ id: 'opening-1', transactionId: 'tx-opening' });
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(entry?.balanceBefore.toJSON().amount).toBe('0.00');
    expect(entry?.balanceAfter.toJSON().amount).toBe('100.00');
    expect(entry?.isBalanced()).toBe(true);
    expect(open().version).toBe(1);
  });

  test('does not emit ledger for a zero-value opening', () => {
    expect(open('0.00').createOpeningLedgerEntry({ id: 'unused', transactionId: 'unused' })).toBeNull();
  });

  test('debits 80 from 100 and produces a balanced immutable entry', () => {
    const wallet = open();
    const entry = wallet.debit({ id: 'entry-bet-1', transactionId: 'bet-1', money: brl('80.00'), at });
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
    expect(entry.isBalanced()).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2);
  });

  test('refuses a second 80 debit without changing balance/version', () => {
    const wallet = open();
    wallet.debit({ id: 'entry-1', transactionId: 'bet-1', money: brl('80.00') });
    expect(() => wallet.debit({ id: 'entry-2', transactionId: 'bet-2', money: brl('80.00') }))
      .toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2);
  });

  test('credits exactly and increments version', () => {
    const wallet = open();
    const entry = wallet.credit({ id: 'entry-win', transactionId: 'win-1', money: brl('25.50') });
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toJSON().amount).toBe('125.50');
    expect(wallet.version).toBe(2);
  });

  test('rejects zero and internally negative movements', () => {
    const wallet = open();
    expect(() => wallet.credit({ id: 'a', transactionId: 'a', money: brl('0.00') }))
      .toThrow(InvalidWalletAmountError);
    expect(() => wallet.debit({ id: 'b', transactionId: 'b', money: brl('2.00').negate() }))
      .toThrow(InvalidWalletAmountError);
    expect(wallet.version).toBe(1);
  });

  test('rejects cross-currency operations', () => {
    const wallet = open();
    expect(() => wallet.credit({ id: 'c', transactionId: 'c', money: usd('1.00') }))
      .toThrow(CurrencyMismatchError);
  });

  test('rejects invalid opening balance', () => {
    expect(() => open('-1.00')).toThrow();
    expect(() => Wallet.open({
      id: 'w', playerId: 'p', initialBalance: brl('1.00').negate(),
    })).toThrow(InvalidWalletAmountError);
  });

  test('rehydrates a persisted snapshot without changing its version', () => {
    const wallet = Wallet.rehydrate({
      id: 'w', playerId: 'p', currency: 'BRL', balance: brl('45.00'),
      version: 7, createdAt: at, updatedAt: at,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.toJSON().amount).toBe('45.00');
  });

  test('defensively copies timestamps', () => {
    const wallet = open();
    const read = wallet.createdAt;
    read.setUTCFullYear(2030);
    expect(wallet.createdAt.getUTCFullYear()).toBe(2026);
    const entry = wallet.createOpeningLedgerEntry({ id: 'e', transactionId: 't' });
    const readEntryDate = entry!.createdAt;
    readEntryDate.setUTCFullYear(2030);
    expect(entry!.createdAt.getUTCFullYear()).toBe(2026);
  });

  test('does not mutate wallet when a ledger entry cannot be constructed', () => {
    const wallet = open();
    expect(() => wallet.credit({ id: '', transactionId: 'tx', money: brl('1.00') }))
      .toThrow(InvalidLedgerEntryError);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });
});

describe('WalletLedgerEntry', () => {
  test('rejects inconsistent accounting', () => {
    expect(() => WalletLedgerEntry.create({
      id: 'e', walletId: 'w', transactionId: 't', direction: LedgerDirection.Credit,
      money: brl('1.00'), balanceBefore: brl('100.00'),
      balanceAfter: brl('100.50'), createdAt: at,
    })).toThrow(InvalidLedgerEntryError);
  });

  test('rejects a debit that makes balance negative', () => {
    expect(() => WalletLedgerEntry.create({
      id: 'e', walletId: 'w', transactionId: 't', direction: LedgerDirection.Debit,
      money: brl('5.00'), balanceBefore: brl('3.00'),
      balanceAfter: brl('2.00').negate(), createdAt: at,
    })).toThrow(InvalidLedgerEntryError);
  });
});
