# Transactional guarantees and current limitations

## Confirmed by real PostgreSQL integration tests

- `wallets` enforces unique (player, currency), nonnegative balance and positive version.
- `wallet_ledger_entries` enforces foreign keys, positive amounts, arithmetic equality, unique (wallet_id, transaction_id) and rejects UPDATE/DELETE through a trigger.
- Each movement locks its wallet row using `SELECT ... FOR UPDATE`, then commits wallet, ledger, wagering outcome and Outbox events atomically.
- Same-wallet competing debits are serialized; a failed debit never overdraws the wallet.
- An initial nonzero wallet balance creates an opening CREDIT ledger row as part of wallet creation.
- `wager_transactions` stores provider/external transaction IDs, payload hashes, idempotency keys and terminal outcomes.
- Duplicate HTTP wagers with the same key and canonical payload return the committed outcome; conflicting payloads fail with 409.
- SQS Inbox consumes a request before the ledger update in the *same transaction*, then SQS message acknowledgment happens after commit.
- Out-of-order REFUND can wait for a referenced BET; the reference worker retries using persistent due dates.
- Outbox writes are committed in the same transaction and an independent publisher pushes messages into a FIFO queue.

## Test evidence

See [the CI workflow](../.github/workflows/financial-correctness.yml): 39 unit tests, 12 PostgreSQL integration tests and one MiniStack SQS e2e test passed in the recorded run. **These are correctness tests, not load benchmarks.**

## Important boundaries

- **Not production-safe:** no authentication, provider signatures, permission checks, rate limiting, or trusted balance-funding controls. The wallet-creation endpoint accepts an initial balance solely for development.
- The FIFO queue and Outbox are **at least once**, not exactly once. A crash after publishing but before marking the Outbox row can cause duplicate messages. Consumers need Inbox/idempotency checks.
- The idempotency model should be reviewed with the official API contract, including whether keys must be scoped per provider and how replay windows are defined.
- Cross-wallet distributed atomicity, full SQS DLQ redrive testing, poison messages and worker crash-recovery have not been exhaustively tested.
- A ledger trigger prevents ordinary accidental DML edits but a sufficiently privileged database operator can disable the trigger.
- The retry worker has a finite attempt policy; long-delayed referenced transactions need a documented operational resolution policy.
- High contention on a *single wallet* serializes on that row, and could limit throughput. Horizontal scaling requires many wallets and production measurements.
- No benchmark has demonstrated 100k/200k financial virtual users. A health-endpoint load test cannot demonstrate financial throughput.

## Running tests without touching the development database

Use a database ending in `_test`. In CI, PostgreSQL and MiniStack start as disposable services.
```bash
DB_NAME=jungle_wagering_test bun run db:migrate
DB_NAME=jungle_wagering_test bun run test:integration
DB_NAME=jungle_wagering_test SQS_ENDPOINT=http://127.0.0.1:4566 RUN_SQS_TESTS=1 bun test test/integration/financial-sqs.test.ts
```
