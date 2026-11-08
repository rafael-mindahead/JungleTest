import { Money } from '../shared/value-objects/money.js';
import { InvalidLedgerEntryError } from './wallet.errors.js';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;
}

export class WalletLedgerEntry {
  private readonly createdAtValue: Date;

  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    createdAt: Date,
  ) {
    this.createdAtValue = new Date(createdAt.getTime());
    Object.freeze(this);
  }

  get createdAt(): Date {
    return new Date(this.createdAtValue.getTime());
  }

  static create(state: LedgerEntryState): WalletLedgerEntry {
    if (!state.id || !state.walletId || !state.transactionId) {
      throw new InvalidLedgerEntryError('Ledger identifiers are required');
    }
    if (!state.money.isPositive()) {
      throw new InvalidLedgerEntryError('Ledger amount must be positive');
    }
    if (state.balanceBefore.isNegative() || state.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('Ledger cannot produce a negative balance');
    }
    if (state.direction !== LedgerDirection.Credit && state.direction !== LedgerDirection.Debit) {
      throw new InvalidLedgerEntryError('Invalid ledger direction');
    }
    if (
      state.money.currency !== state.balanceBefore.currency ||
      state.money.currency !== state.balanceAfter.currency
    ) {
      throw new InvalidLedgerEntryError('Ledger currencies must match');
    }

    const entry = WalletLedgerEntry.rehydrate(state);
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError('Ledger arithmetic is inconsistent');
    }
    return entry;
  }

  // Rehydration reads an already-persisted entry; it does not reapply business transitions.
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    try {
      const expected = this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
      return !this.balanceBefore.isNegative() &&
        !this.balanceAfter.isNegative() &&
        this.money.isPositive() &&
        expected.equals(this.balanceAfter);
    } catch {
      return false;
    }
  }
}
