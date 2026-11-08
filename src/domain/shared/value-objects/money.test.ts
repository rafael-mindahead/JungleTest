
import { describe, expect, test } from 'bun:test';

import { Money } from './money.js';

import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from '../errors/money.errors.js';

const brl = (amount: string): Money =>
  Money.from({ amount, currency: 'BRL' });

describe('Money Value Object', () => {
  describe('Creation', () => {
    test('creates an exact decimal amount', () => {
      expect(brl('25.00').toJSON()).toEqual({
        amount: '25.00',
        currency: 'BRL',
      });
    });

    test('creates zero', () => {
      const money = Money.zero('BRL');

      expect(money.isZero()).toBe(true);
      expect(money.toString()).toBe('0.00 BRL');
    });

    test('accepts valid currencies', () => {
      expect(
        Money.from({
          amount: '10.00',
          currency: 'USD',
        }).currency,
      ).toBe('USD');

      expect(
        Money.from({
          amount: '10.00',
          currency: 'EUR',
        }).currency,
      ).toBe('EUR');
    });
  });

  describe('Financial precision', () => {
    test('adds 0.10 + 0.20 exactly', () => {
      const result = brl('0.10').add(brl('0.20'));

      expect(result.toJSON().amount).toBe('0.30');
    });

    test('subtracts without floating point errors', () => {
      const result = brl('100.00').subtract(brl('0.01'));

      expect(result.toJSON().amount).toBe('99.99');
    });

    test('preserves precision with large amounts', () => {
      const result = brl(
        '999999999999999999.98',
      ).add(brl('0.01'));

      expect(result.toJSON().amount).toBe(
        '999999999999999999.99',
      );
    });

    test('rejects overflow beyond NUMERIC(20,2)', () => {
      expect(() =>
        brl('999999999999999999.99').add(brl('0.01')),
      ).toThrow(InvalidMoneyError);
    });
  });

  describe('Validation', () => {
    const invalidAmounts = [
      '',
      'NaN',
      'Infinity',
      '-1.00',
      '1e3',
      '1.001',
      '1.999',
      '10',
      '10.0',
      '001.00',
      '+10.00',
    ];

    for (const amount of invalidAmounts) {
      test(`rejects invalid amount: "${amount}"`, () => {
        expect(() => brl(amount)).toThrow(
          InvalidMoneyError,
        );
      });
    }

    test('rejects unsupported currency', () => {
      expect(() =>
        Money.from({
          amount: '10.00',
          currency: 'ZZZ',
        }),
      ).toThrow(InvalidMoneyError);
    });

    test('rejects operations between currencies', () => {
      const real = brl('10.00');

      const dollar = Money.from({
        amount: '10.00',
        currency: 'USD',
      });

      expect(() => real.add(dollar)).toThrow(
        CurrencyMismatchError,
      );

      expect(() => real.subtract(dollar)).toThrow(
        CurrencyMismatchError,
      );

      expect(() => real.isLessThan(dollar)).toThrow(
        CurrencyMismatchError,
      );
    });
  });

  describe('Immutability', () => {
    test('does not mutate the original money', () => {
      const original = brl('100.00');

      const updated = original.subtract(brl('25.00'));

      expect(original.toJSON().amount).toBe('100.00');
      expect(updated.toJSON().amount).toBe('75.00');
      expect(updated).not.toBe(original);
    });

    test('allows negative internal results', () => {
      const result = brl('5.00').subtract(brl('10.00'));

      expect(result.isNegative()).toBe(true);
      expect(result.toJSON().amount).toBe('-5.00');
    });

    test('negates an amount', () => {
      const result = brl('10.00').negate();

      expect(result.toJSON().amount).toBe('-10.00');
    });

    test('compares values correctly', () => {
      expect(brl('5.00').isLessThan(brl('10.00'))).toBe(
        true,
      );

      expect(brl('10.00').equals(brl('10.00'))).toBe(
        true,
      );

      expect(brl('10.00').equals(brl('10.01'))).toBe(
        false,
      );
    });
  });

  describe('Serialization', () => {
    test('serializes money as decimal strings', () => {
      const money = brl('25.50');

      expect(JSON.stringify(money)).toBe(
        '{"amount":"25.50","currency":"BRL"}',
      );
    });
  });
});
