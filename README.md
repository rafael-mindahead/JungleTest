# JungleTest — Distributed Wagering Processor

Transactional wagering backend for the Jungle Gaming engineering challenge.
**Status: prototype / code under review, not safe for deployment to the public internet.**

**Stack:** Bun 1.4.4, NestJS 12, TypeScript, MikroORM 7, PostgreSQL 17 and local AWS SQS emulation with MiniStack.

## Implemented

- Monetary `Money` value object and `Wallet` domain rules with an immutable ledger.
- Atomic PostgreSQL wallet/ledger transactions with row locks, versioning, constraints and append-only trigger.
- Wagering transactions: BET, WIN, LOSS, REFUND, ROLLBACK; provider/external transaction keys; persistent rejection and idempotency outcomes.
- Out-of-order reference handling: `PENDING_REFERENCE`, retry/backoff and rejection after exhaustion.
- HTTP: create/read wallets, paginate ledger, reconcile wallet; submit/get wagering transactions.
- SQS FIFO consumer, durable Inbox, SQL Outbox, event publisher with lease and retry, DLQ configuration.
- GitHub Actions CI running Bun unit tests, real Postgres migrations, HTTP/database integrations, and MiniStack SQS end-to-end test.

## Verified in GitHub Actions

See [financial correctness workflow](.github/workflows/financial-correctness.yml). At commit
`79934ab5103c0986c543bcf1414996b9cb6e9a79`, the CI runner verified:

- **39** Bun domain unit tests pass.
- **12** PostgreSQL integration tests pass (including six HTTP API/inbox scenarios).
- **1** SQS end-to-end test passes against MiniStack: FIFO input -> DB Inbox -> ledger -> DB Outbox -> FIFO events.
- Three PostgreSQL migrations applied successfully; TypeScript typecheck passed.

[Verified GitHub Actions run](https://github.com/rafael-mindahead/JungleTest/actions/runs/42498113971).

The CI does **not** verify production readiness, third-party SQS delivery, high availability or 100k/200k-user capacity.

## Local development

```bash
bun install --frozen-lockfile
docker compose up -d
bun run sqs:setup
bun run db:migrate
bun run typecheck
bun run test:domain
bun run dev
```

Endpoints:

- `GET /health/live`, `GET /health/ready`
- `POST /wallets`, `GET /wallets/:walletId`
- `GET /wallets/:walletId/ledger`, `POST /wallets/:walletId/reconciliation`
- `POST /wagering/transactions` (requires `Idempotency-Key`)
- `GET /wagering/transactions/:transactionId`
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId`

**Important:** development wallet creation grants an initial balance. There is no authentication or authorization yet. Do not expose these endpoints publicly.

## Real integration tests

Use a disposable database to avoid modifying development balances.

```bash
docker compose up -d
docker compose exec -T postgres psql -U jungle -d postgres -c "CREATE DATABASE jungle_wagering_test"
DB_NAME=jungle_wagering_test bun run db:migrate
DB_NAME=jungle_wagering_test bun run test:integration
DB_NAME=jungle_wagering_test SQS_ENDPOINT=http://127.0.0.1:4566 RUN_SQS_TESTS=1 bun test test/integration/financial-sqs.test.ts
```

The create-database command is needed only once. Run `bun run sqs:setup` before the SQS test if its queues do not exist.

The SQS worker loops are **opt-in**: set `SQS_WORKER_ENABLED=1`, `OUTBOX_PUBLISHER_ENABLED=1` and `REFERENCE_WORKER_ENABLED=1` when running worker processes. Do not run multiple publisher processes until deployment/lease behavior is independently reviewed.

## Engineering documentation

- [Transactional invariants and limitations](docs/TRANSACTIONAL-INVARIANTS.md)
- [Performance methodology](docs/PERFORMANCE.md)
- [Benchmarking the HTTP stack](scripts/bench/http-health.js)

The k6 script currently measures `/health/live` only. Performance at 100k or 200k virtual users is **not yet measured or claimed**.
