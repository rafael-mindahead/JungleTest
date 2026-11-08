export class InvalidWalletAmountError extends Error {
  constructor(message = 'Wallet movement must have a strictly positive amount') {
    super(message);
    this.name = 'InvalidWalletAmountError';
  }
}

export class InsufficientFundsError extends Error {
  constructor() {
    super('Insufficient funds');
    this.name = 'InsufficientFundsError';
  }
}

export class InvalidLedgerEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLedgerEntryError';
  }
}
