
import { Migration } from '@mikro-orm/migrations';

export class Migration20261108000100 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY,

        player_id UUID NOT NULL,

        currency VARCHAR(3) NOT NULL,

        balance NUMERIC(20, 2) NOT NULL DEFAULT 0.00,

        version INTEGER NOT NULL DEFAULT 1,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT wallets_balance_non_negative
          CHECK (balance >= 0),

        CONSTRAINT wallets_version_positive
          CHECK (version >= 1),

        CONSTRAINT wallets_currency_valid
          CHECK (currency ~ '^[A-Z]{3}$'),

        CONSTRAINT wallets_player_currency_unique
          UNIQUE (player_id, currency)
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS wallets;');
  }
}
