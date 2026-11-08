import { randomUUID } from 'node:crypto';
export interface EventProps<T> {
  eventId?: string; aggregateId: string; correlationId: string;
  causationId?: string; occurredAt?: Date; data: T;
}
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;
  protected constructor(props: EventProps<T>) {
    this.eventId = props.eventId ?? randomUUID();
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt ?? new Date();
    this.data = Object.freeze(props.data);
  }
  toJSON() {
    return {
      eventId: this.eventId, eventType: this.eventType, version: this.version,
      aggregateId: this.aggregateId, correlationId: this.correlationId,
      causationId: this.causationId, occurredAt: this.occurredAt.toISOString(),
      data: this.data,
    };
  }
}
export class WagerTransactionProcessed extends IntegrationEvent<Readonly<Record<string, unknown>>> {
  readonly eventType = 'WagerTransactionProcessed'; readonly version = 1;
  static from(props: EventProps<Readonly<Record<string, unknown>>>): WagerTransactionProcessed { return new WagerTransactionProcessed(props); }
}
export class WagerTransactionRejected extends IntegrationEvent<Readonly<Record<string, unknown>>> {
  readonly eventType = 'WagerTransactionRejected'; readonly version = 1;
  static from(props: EventProps<Readonly<Record<string, unknown>>>): WagerTransactionRejected { return new WagerTransactionRejected(props); }
}
export class WalletBalanceChanged extends IntegrationEvent<Readonly<Record<string, unknown>>> {
  readonly eventType = 'WalletBalanceChanged'; readonly version = 1;
  static from(props: EventProps<Readonly<Record<string, unknown>>>): WalletBalanceChanged { return new WalletBalanceChanged(props); }
}
export class WagerTransactionPendingReference extends IntegrationEvent<Readonly<Record<string, unknown>>> {
  readonly eventType = 'WagerTransactionPendingReference'; readonly version = 1;
  static from(props: EventProps<Readonly<Record<string, unknown>>>): WagerTransactionPendingReference { return new WagerTransactionPendingReference(props); }
}
