# Wallet + ledger: transactional guarantees

## SQL model
- Each wallet is unique by (player_id, currency), its balance cannot be negative, and its version is positive.
- Ledger rows are append-only (BEFORE UPDATE/DELETE trigger) with FK, UNIQUE(wallet_id, transaction_id), positive amount, non-negative snapshots and an arithmetic CHECK.
- No application operation should update the wallet without appending the corresponding ledger row in the **same SQL transaction**.
- A nonzero initial wallet balance creates an opening CREDIT ledger row in the same transaction as wallet creation. Opening does not increase version 1.

## Concurrency
PostgresWalletRepository.apply() forks the MikroORM EntityManager and starts a database transaction. A SELECT ... FOR UPDATE takes a row-level lock on the wallet; only after the lock is acquired does it check previous ledger transaction IDs. Distinct concurrent debits then re-evaluate the latest balance. The wallet update, version increment and ledger INSERT are committed together.

The integration suite verifies: two 80.00 debits from 100.00, 30 contending 1.00 debits against 10.00, twenty duplicate requests with the same transaction ID, conflicting duplicate payloads, ledger immutability and DB balance constraints.

## Boundaries / unfinished
- Idempotency currently covers **committed successful movements** per wallet and transaction ID. Durable recording of rejected requests, external events, replay windows, SQS Inbox/Outbox, and mapping request identifiers into an end-to-end API remain pending.
- The trigger protects ledger history against accidental UPDATE/DELETE via normal DML. Database administrators with DDL privileges can bypass or disable a trigger, so least-privilege roles and audit logging still matter.
- A lock serializes transactions on **one wallet**. High contention on the same wallet has a throughput ceiling. Global throughput can increase with many independent wallets, but no throughput claim is made before measurement.
- Persisting opening CREDIT means a database restored from an older snapshot without matching ledger rows needs reconciliation, not blind backfilling.
- Run actual DB tests only on a disposable database named with the suffix `_test`.

## Run with a local test DB
Run Docker Compose as usual. Create the disposable database once:

```bash
docker compose up -d postgres
docker compose exec -T postgres psql -U jungle -d postgres -tc "SELECT 1 FROM pg_database WHERE datname = 'jungle_wagering_test'" | grep -q 1 || docker compose exec -T postgres psql -U jungle -d postgres -c "CREATE DATABASE jungle_wagering_test"
DB_NAME=jungle_wagering_test bun run db:migrate
DB_NAME=jungle_wagering_test RUN_DB_TESTS=1 bun test test/integration
```

The test database intentionally retains append-only ledger rows; drop the whole disposable database to reset it. These tests require a real Postgres server, not an in-memory mock.
