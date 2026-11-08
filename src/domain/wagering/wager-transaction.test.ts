import { describe, expect, test } from 'bun:test';
import { WagerTransaction, type WagerKind, type WagerStatus } from './wager-transaction.js';

const tx = (kind: WagerKind = 'BET', status: WagerStatus = 'PENDING') =>
  WagerTransaction.rehydrate({ id: 'aggregate-test', kind, status });

describe('WagerTransaction domain transition invariants', () => {
  test('moves from PENDING to processed and never processes twice', () => {
    const wager = tx();
    expect(wager.isTerminal()).toBe(false);
    expect(wager.transition('PROCESSED')).toBe('PROCESSED');
    expect(wager.isTerminal()).toBe(true);
    expect(() => wager.transition('PROCESSED')).toThrow();
    expect(() => wager.transition('REJECTED')).toThrow();
  });

  test('pending reference can be retried and ultimately rejected', () => {
    const wager = tx('REFUND');
    wager.transition('PENDING_REFERENCE');
    wager.transition('PENDING_REFERENCE');
    expect(wager.transition('REJECTED')).toBe('REJECTED');
    expect(() => wager.transition('PENDING_REFERENCE')).toThrow();
  });

  test('a delayed reference may resolve successfully', () => {
    const wager = tx('ROLLBACK', 'PENDING_REFERENCE');
    expect(wager.transition('PROCESSED')).toBe('PROCESSED');
  });

  test('failed transactions are terminal', () => {
    expect(() => tx('BET', 'FAILED').transition('PROCESSED')).toThrow();
  });

  test('reference kinds enforce refund and rollback business rules', () => {
    expect(tx('REFUND').canReference('BET')).toBe(true);
    expect(tx('REFUND').canReference('WIN')).toBe(false);
    expect(tx('ROLLBACK').canReference('BET')).toBe(true);
    expect(tx('ROLLBACK').canReference('REFUND')).toBe(true);
    expect(tx('ROLLBACK').canReference('LOSS')).toBe(false);
    expect(tx('WIN').canReference('BET')).toBe(true);
    expect(tx('BET').canReference('BET')).toBe(false);
  });
});
