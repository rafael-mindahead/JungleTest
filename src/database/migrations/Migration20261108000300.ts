import { Migration } from '@mikro-orm/migrations';
export class Migration20261108000300 extends Migration {
  override async up(): Promise<void> {
    this.addSql("CREATE TABLE wager_transactions (id UUID PRIMARY KEY, provider_id VARCHAR(128) NOT NULL, external_transaction_id VARCHAR(200) NOT NULL, idempotency_key VARCHAR(250) NOT NULL, payload_hash CHAR(64) NOT NULL, wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT, player_id UUID NOT NULL, round_id VARCHAR(200) NOT NULL, game_id VARCHAR(200) NOT NULL, kind VARCHAR(12) NOT NULL, currency VARCHAR(3) NOT NULL, amount NUMERIC(20,2) NOT NULL, reference_external_transaction_id VARCHAR(200), reference_transaction_id UUID REFERENCES wager_transactions(id), status VARCHAR(24) NOT NULL DEFAULT 'PENDING', failure_code VARCHAR(80), attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ, result_balance NUMERIC(20,2), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), processed_at TIMESTAMPTZ, CONSTRAINT wager_unique_external UNIQUE (provider_id, external_transaction_id), CONSTRAINT wager_unique_idempotency UNIQUE (idempotency_key), CONSTRAINT wager_kind_valid CHECK (kind IN ('BET','WIN','LOSS','REFUND','ROLLBACK')), CONSTRAINT wager_status_valid CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')), CONSTRAINT wager_amount_positive CHECK (amount > 0), CONSTRAINT wager_attempts_nonnegative CHECK (attempts >= 0), CONSTRAINT wager_currency_valid CHECK (currency ~ '^[A-Z]{3}$'), CONSTRAINT wager_reference_required CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL))");
    this.addSql("CREATE UNIQUE INDEX wager_one_refund_per_reference ON wager_transactions (reference_transaction_id) WHERE kind = 'REFUND' AND status = 'PROCESSED'");
    this.addSql("CREATE UNIQUE INDEX wager_one_rollback_per_reference ON wager_transactions (reference_transaction_id) WHERE kind = 'ROLLBACK' AND status = 'PROCESSED'");
    this.addSql("CREATE INDEX wager_pending_reference_due_idx ON wager_transactions (next_attempt_at, id) WHERE status = 'PENDING_REFERENCE'");
    this.addSql("CREATE INDEX wager_wallet_idx ON wager_transactions (wallet_id, created_at)");
    this.addSql("CREATE TABLE wager_inbox (consumer_name VARCHAR(100) NOT NULL, message_id VARCHAR(250) NOT NULL, payload_hash CHAR(64) NOT NULL, transaction_id UUID REFERENCES wager_transactions(id), received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), processed_at TIMESTAMPTZ, PRIMARY KEY (consumer_name, message_id))");
    this.addSql("CREATE TABLE wager_outbox (id UUID PRIMARY KEY, aggregate_id UUID NOT NULL, event_type VARCHAR(100) NOT NULL, payload JSONB NOT NULL, attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0), next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), locked_by UUID, locked_until TIMESTAMPTZ, occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), published_at TIMESTAMPTZ)");
    this.addSql("CREATE INDEX wager_outbox_due_idx ON wager_outbox (next_attempt_at, occurred_at) WHERE published_at IS NULL");
  }
  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS wager_outbox');
    this.addSql('DROP TABLE IF EXISTS wager_inbox');
    this.addSql('DROP TABLE IF EXISTS wager_transactions');
  }
}
