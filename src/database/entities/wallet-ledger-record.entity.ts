import { DecimalType } from '@mikro-orm/core';
import { Entity, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';
import { WalletRecord } from './wallet-record.entity.js';

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({
  properties: ['wallet', 'transactionId'],
  name: 'wallet_ledger_transaction_unique',
})
export class WalletLedgerRecord {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @ManyToOne({ entity: () => WalletRecord, fieldName: 'wallet_id', deleteRule: 'restrict' })
  wallet!: WalletRecord;

  @Property({ type: 'uuid', fieldName: 'transaction_id' })
  transactionId!: string;

  @Property({ type: 'string', length: 6 })
  direction!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({ type: DecimalType, precision: 20, scale: 2 })
  amount!: string;

  @Property({ type: DecimalType, precision: 20, scale: 2, fieldName: 'balance_before' })
  balanceBefore!: string;

  @Property({ type: DecimalType, precision: 20, scale: 2, fieldName: 'balance_after' })
  balanceAfter!: string;

  @Property({ type: 'datetime', columnType: 'timestamptz', fieldName: 'created_at' })
  createdAt!: Date;
}
