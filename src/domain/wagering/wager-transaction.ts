/**
 * Financial transaction aggregate: a replay never changes a terminal state.
 * PostgreSQL remains authoritative; the service uses this guard inside its
 * existing wallet-locked SQL transaction before persisting every transition.
 */
export type WagerKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export type WagerStatus = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';

const ALLOWED_TRANSITIONS: Readonly<Record<WagerStatus, ReadonlySet<WagerStatus>>> = {
  PENDING: new Set(['PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED']),
  PENDING_REFERENCE: new Set(['PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED']),
  PROCESSED: new Set(),
  REJECTED: new Set(),
  FAILED: new Set(),
};

const ALLOWED_REFERENCES: Readonly<Record<WagerKind, ReadonlySet<WagerKind>>> = {
  BET: new Set(),
  WIN: new Set(['BET']),
  LOSS: new Set(['BET']),
  REFUND: new Set(['BET']),
  ROLLBACK: new Set(['BET', 'WIN', 'REFUND']),
};

export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly kind: WagerKind,
    private currentStatus: WagerStatus,
  ) {}

  static rehydrate(row: { id: string; kind: WagerKind; status: WagerStatus }): WagerTransaction {
    if (!ALLOWED_TRANSITIONS[row.status]) throw new Error('Unknown wager status');
    if (!ALLOWED_REFERENCES[row.kind]) throw new Error('Unknown wager kind');
    return new WagerTransaction(row.id, row.kind, row.status);
  }

  get status(): WagerStatus { return this.currentStatus; }

  isTerminal(): boolean { return ALLOWED_TRANSITIONS[this.currentStatus].size === 0; }

  canReference(otherKind: WagerKind): boolean {
    return ALLOWED_REFERENCES[this.kind].has(otherKind);
  }

  transition(to: WagerStatus): WagerStatus {
    if (!ALLOWED_TRANSITIONS[this.currentStatus].has(to)) {
      throw new Error(`Illegal wager transition: ${this.currentStatus} -> ${to}`);
    }
    this.currentStatus = to;
    return this.currentStatus;
  }
}
