# JungleTest — Distributed Wagering Processor

Prototype of a transactionally safe wagering backend for the Jungle Gaming challenge. Bun 1.x, NestJS 12, MikroORM 7, PostgreSQL 17, and local SQS via MiniStack. **Work in progress; not production ready.**

## What is implemented

- NestJS, Bun runtime, PostgreSQL, SQS local configuration, liveness/readiness endpoints.
- Decimal-based `Money` value object with Bun unit tests.
- `Wallet` aggregate, immutable domain ledger entries, and unit tests.
- PostgreSQL migration with append-only ledger, unique wallet/transaction pair, accounting checks, and a balance >= 0 invariant.
- `PostgresWalletRepository` using a wallet row lock and a transaction for atomic balance, version, and ledger changes.
- Real PostgreSQL integration tests for concurrent debits and duplicate transaction IDs.
- A GitHub Actions workflow that is **configured** to run correctness tests (check the Actions tab for actual run status).

## Not implemented

Financial HTTP API, authorization, complete wagering state machine (BET/WIN/LOSS/REFUND/ROLLBACK), end-to-end durable idempotency of rejected events, SQS consumers, Inbox/Outbox, reconciliation, production observability, and a validated business-transaction load benchmark.

## Local setup (macOS + Docker)

```bash
bun install
docker compose up -d
bun run sqs:setup
bun run db:migrate
bun run typecheck
bun run test:domain
bun run dev
```

Test liveness: `curl http://localhost:3000/health/live`. Test readiness (requires Postgres + SQS): `curl http://localhost:3000/health/ready`.

## Real DB concurrency tests

Create a separate database so the tests cannot affect your development data:

```bash
docker compose exec -T postgres psql -U jungle -d postgres -c "CREATE DATABASE jungle_wagering_test"
DB_NAME=jungle_wagering_test bun run db:migrate
DB_NAME=jungle_wagering_test bun run test:integration
```

Create the test DB only once; if it already exists, skip the CREATE DATABASE command. The integration test refuses database names without the `_test` suffix. CI uses a dedicated PostgreSQL service.

## Performance engineering

See [performance methodology](docs/PERFORMANCE.md) for CPU, RSS/heap, file descriptors, durability, p95/p99 thresholds, and gated 100k/200k virtual-user test profiles. Today's k6 script exercises `/health/live` only. No claims of 100k/200k financial-user capacity are made.

For wallet invariants and durability design see [transactional guarantees](docs/TRANSACTIONAL-INVARIANTS.md).
