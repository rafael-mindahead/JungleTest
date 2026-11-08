import { describe, expect, test } from 'bun:test';
import { parseInput } from '../../src/wagering/wager-input.js';

const valid = () => ({
  providerId: 'test-provider', externalTransactionId: 'tx-1',
  playerId: '55b5e589-0f78-49d6-a475-0dc2f5f7c018',
  walletId: 'bed4db9b-2fb8-46ed-91b3-e394bc7781a4',
  roundId: 'round-1', gameId: 'game-1',
  kind: 'BET', money: { amount: '10.00', currency: 'BRL' },
});

describe('shared wagering input contract', () => {
  test('accepts precise decimal strings and normalizes IDs', () => {
    const value = parseInput(valid());
    expect(value.money.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(value.kind).toBe('BET');
  });
  test('refuses negative and floating money without rounding', () => {
    expect(() => parseInput({ ...valid(), money: { amount: -1, currency: 'BRL' } })).toThrow();
    expect(() => parseInput({ ...valid(), money: { amount: '1.111', currency: 'BRL' } })).toThrow();
  });
  test('refuses external OPENING and invalid UUID', () => {
    expect(() => parseInput({ ...valid(), kind: 'OPENING' })).toThrow();
    expect(() => parseInput({ ...valid(), walletId: 'non-uuid' })).toThrow();
  });
  test('requires explicit refund reference', () => {
    expect(() => parseInput({ ...valid(), kind: 'REFUND' })).toThrow();
  });
  test('refuses self-reference and unwanted BET reference', () => {
    expect(() => parseInput({ ...valid(), kind: 'REFUND', referenceExternalTransactionId: 'tx-1' })).toThrow();
    expect(() => parseInput({ ...valid(), referenceExternalTransactionId: 'another-tx' })).toThrow();
  });
});
