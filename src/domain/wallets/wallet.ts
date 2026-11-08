import { Money } from '../shared/value-objects/money.js';
import { CurrencyMismatchError } from '../shared/errors/money.errors.js';
import { InsufficientFundsError, InvalidWalletAmountError } from './wallet.errors.js';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.js';

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WalletMovement {
  readonly id: string;
  readonly transactionId: string;
  readonly money: Money;
  readonly at?: Date;
}

export class Wallet {
  private _createdAt: Date;
  private _updatedAt: Date;

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    createdAt: Date,
    updatedAt: Date,
  ) {
    this._createdAt = new Date(createdAt.getTime());
    this._updatedAt = new Date(updatedAt.getTime());
  }

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    at?: Date;
  }): Wallet {
    if (!props.id || !props.playerId) {
      throw new InvalidWalletAmountError('Wallet and player identifiers are required');
    }
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletAmountError('Initial balance cannot be negative');
    }
    const at = props.at ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      at,
      at,
    );
  }

  // Called only on a trusted, already persisted snapshot, without replaying transitions.
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt.getTime());
  }

  // The persistence service MUST insert this OPENING entry and the wallet in one SQL transaction.
  // Opening credits do not increment version: a newly opened wallet has version 1.
  createOpeningLedgerEntry(input: {
    id: string;
    transactionId: string;
  }): WalletLedgerEntry | null {
    if (this._balance.isZero()) return null;
    return WalletLedgerEntry.create({
      id: input.id,
      walletId: this.id,
      transactionId: input.transactionId,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      createdAt: this._createdAt,
    });
  }

  debit(input: WalletMovement): WalletLedgerEntry {
    this.assertMovement(input.money);
    if (this._balance.isLessThan(input.money)) {
      throw new InsufficientFundsError();
    }
    return this.move(input, LedgerDirection.Debit);
  }

  credit(input: WalletMovement): WalletLedgerEntry {
    this.assertMovement(input.money);
    return this.move(input, LedgerDirection.Credit);
  }

  private assertMovement(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
    if (!money.isPositive()) {
      throw new InvalidWalletAmountError();
    }
  }

  private move(input: WalletMovement, direction: LedgerDirection): WalletLedgerEntry {
    const next = direction === LedgerDirection.Credit
      ? this._balance.add(input.money)
      : this._balance.subtract(input.money);
    const at = input.at ?? new Date();

    // Validate and construct the immutable ledger BEFORE mutating this aggregate.
    const entry = WalletLedgerEntry.create({
      id: input.id,
      walletId: this.id,
      transactionId: input.transactionId,
      direction,
      money: input.money,
      balanceBefore: this._balance,
      balanceAfter: next,
      createdAt: at,
    });
    this._balance = next;
    this._version += 1;
    this._updatedAt = new Date(at.getTime());
    return entry;
  }
}
