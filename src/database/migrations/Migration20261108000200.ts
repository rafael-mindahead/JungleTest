import { Migration } from '@mikro-orm/migrations';

export class Migration20261108000200 extends Migration {
  override async up(): Promise<void> {
    this.addSql([
      'CREATE TABLE wallet_ledger_entries (',
      'id UUID PRIMARY KEY,',
      'wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,',
      'transaction_id UUID NOT NULL,',
      'direction VARCHAR(6) NOT NULL,',
      'currency VARCHAR(3) NOT NULL,',
      'amount NUMERIC(20,2) NOT NULL,',
      'balance_before NUMERIC(20,2) NOT NULL,',
      'balance_after NUMERIC(20,2) NOT NULL,',
      'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),',
      'CONSTRAINT wallet_ledger_transaction_unique UNIQUE (wallet_id, transaction_id),',
      'CONSTRAINT wallet_ledger_direction_valid CHECK (direction IN (\'DEBIT\', \'CREDIT\')),',
      'CONSTRAINT wallet_ledger_currency_valid CHECK (currency ~ \'^[A-Z]{3}$\'),',
      'CONSTRAINT wallet_ledger_amount_positive CHECK (amount > 0),',
      'CONSTRAINT wallet_ledger_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),',
      'CONSTRAINT wallet_ledger_arithmetic_valid CHECK (',
      '(direction = \'CREDIT\' AND balance_after = balance_before + amount)',
      'OR (direction = \'DEBIT\' AND balance_after = balance_before - amount)',
      ')',
      ')',
    ].join(' '));

    this.addSql(
      'CREATE INDEX wallet_ledger_wallet_created_idx ' +
      'ON wallet_ledger_entries (wallet_id, created_at, id)',
    );

    this.addSql([
      'CREATE FUNCTION prevent_wallet_ledger_mutation() RETURNS trigger',
      'LANGUAGE plpgsql AS $$',
      'BEGIN',
      "RAISE EXCEPTION 'wallet_ledger_entries is append-only' USING ERRCODE = '55000';",
      'END;',
      '$$;',
    ].join(' '));

    this.addSql(
      'CREATE TRIGGER wallet_ledger_append_only ' +
      'BEFORE UPDATE OR DELETE ON wallet_ledger_entries ' +
      'FOR EACH ROW EXECUTE FUNCTION prevent_wallet_ledger_mutation()',
    );
  }

  override async down(): Promise<void> {
    this.addSql('DROP TRIGGER IF EXISTS wallet_ledger_append_only ON wallet_ledger_entries');
    this.addSql('DROP FUNCTION IF EXISTS prevent_wallet_ledger_mutation()');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries');
  }
}
