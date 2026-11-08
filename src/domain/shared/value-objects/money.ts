import { Decimal } from 'decimal.js';

import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from '../errors/money.errors.js';

export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

const MoneyDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
});

const MAX_AMOUNT = new MoneyDecimal(
  '999999999999999999.99',
);

const DECIMAL_PATTERN = /^(0|[1-9]\d*)\.\d{2}$/;

const VALID_CURRENCIES = new Set(
  Intl.supportedValuesOf('currency'),
);

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (
      !props ||
      typeof props.amount !== 'string' ||
      typeof props.currency !== 'string'
    ) {
      throw new InvalidMoneyError(
        'Money requires amount and currency strings',
      );
    }

    if (!DECIMAL_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(
        'Amount must be a non-negative decimal string with exactly 2 decimal places',
      );
    }

    Money.validateCurrency(props.currency);

    const value = new MoneyDecimal(props.amount);

    return Money.fromInternal(value, props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({
      amount: '0.00',
      currency,
    });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);

    return Money.fromInternal(
      this.value.plus(other.value),
      this.currency,
    );
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);

    return Money.fromInternal(
      this.value.minus(other.value),
      this.currency,
    );
  }

  negate(): Money {
    return Money.fromInternal(
      this.value.negated(),
      this.currency,
    );
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return (
      this.currency === other.currency &&
      this.value.equals(other.value)
    );
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(
        this.currency,
        other.currency,
      );
    }
  }

  private static validateCurrency(currency: string): void {
    if (
      !/^[A-Z]{3}$/.test(currency) ||
      !VALID_CURRENCIES.has(currency)
    ) {
      throw new InvalidMoneyError(
        `Invalid ISO-4217 currency: ${currency}`,
      );
    }
  }

  private static fromInternal(
    value: Decimal,
    currency: string,
  ): Money {
    if (!value.isFinite()) {
      throw new InvalidMoneyError(
        'Money value must be finite',
      );
    }

    if (value.decimalPlaces() > 2) {
      throw new InvalidMoneyError(
        'Money precision cannot exceed 2 decimal places',
      );
    }

    if (value.abs().greaterThan(MAX_AMOUNT)) {
      throw new InvalidMoneyError(
        'Money amount exceeds NUMERIC(20,2) limits',
      );
    }

    return new Money(value, currency);
  }
}
