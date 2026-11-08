# Financial performance benchmark

## What the tests mean

There are two separate workload scripts:
- `scripts/bench/http-health.js`: measures **only HTTP transport** through `/health/live`.
- `scripts/bench/financial.js`: exercises **real PostgreSQL financial transactions** (BET, WIN, LOSS, REFUND, ROLLBACK plus idempotent replays) through the NestJS API.

The Jungle Gaming challenge has **no official minimum RPS or 100k/200k-VU goal**. The 5-minute p95 under 500 ms, p99 under 1000 ms and technical error rate under 1% are our **internal** budgets. Correctness, idempotency and consistency always outweigh throughput.

## Local preparation (disposable test database)

Start PostgreSQL (and optional MiniStack), create the test DB once, run migrations, start a dedicated API using `DB_NAME=jungle_wagering_test` and leave it running. Do NOT point scripts at production.

```bash
docker compose up -d
docker compose exec -T postgres psql -U jungle -d postgres -c "CREATE DATABASE jungle_wagering_test"
DB_NAME=jungle_wagering_test bun run db:migrate
DB_NAME=jungle_wagering_test bun run src/main.ts
```

In a second terminal:

```bash
DB_NAME=jungle_wagering_test BENCH_WALLETS=12 bun scripts/bench/seed-financial.ts
PROFILE=smoke k6 run scripts/bench/financial.js
DB_NAME=jungle_wagering_test bun scripts/bench/reconcile-financial.ts
```

`bun run test:load` invokes the same k6 script (requires k6 installed). The seed tool generates unique wallets with opening balance `1000.00 BRL`, creates `artifacts/bench/wallets.json`, and restricts seeding to a local `*_test` database. The reconciliation tool queries the financial API after load and fails if even one stored wallet balance differs from the append-only ledger reconstruction.

The financial script has `smoke` (3 VUs), `baseline` (100 VUs), `ramp` (1000 VUs), and gated `peak100k`/`peak200k` profiles. `CONFIRM_PEAK=yes` is necessary but not proof the load generator can sustain those users. Many wallets may share a small number of VUs; the fixture must be sized for meaningful wallet concurrency. `HOT_WALLET` is not implied by this script; to test a hot wallet, seed one wallet explicitly and use that fixture.

The k6 mix is one BET per iteration followed by WIN, LOSS, REFUND or ROLLBACK and a periodic duplicate. Business rejections (HTTP 422) are counted separately from transport/technical failures. Successful operations are tracked by the `financial_processed_operations` counter. See emitted k6 metrics for p50/p95/p99 and requests/s, and collect CPU/RSS/file descriptors separately using `scripts/bench/sample-process.sh`.

**Limitations:** This benchmark exercises financial HTTP and PostgreSQL; the asynchronous SQS worker and publication of Outbox messages are validated by separate integration tests, not measured for throughput in the load script. The test database must be isolated and the API must have worker loops disabled unless a specific all-components experiment is intended.

## Reproducible measurements

Use the workflow in `.github/workflows/financial-correctness.yml` for the short financial smoke; GitHub Actions uploads the k6 summary and wallet reconciliation report as artifacts. **A successful smoke is evidence of request correctness under a small load, not a 5-minute baseline, not a production throughput claim, and not 100k/200k VUs.**

For larger experiments record commit SHA, Bun/runtime/kernel version, CPU/RAM, PostgreSQL/WAL settings, connection pool, k6 generator topology, wallets seeded, traffic mix, warm-up, exact VU and RPS, p50/p95/p99, technical and business failure rates, CPU/RSS/GC/FD, DB contention and Outbox lag. Reconcile all wallets after the run. Do not suppress PostgreSQL WAL or synchronous commits for speed.
