# Performance engineering laboratory

## Priorities

Financial correctness is a release gate. Zero duplicate posted debits, zero negative wallet balances, and consistent wallet/ledger snapshots must hold **before** accepting any throughput result. A benchmark on `/health/live` proves HTTP stack overhead only, never wagering capacity.

## Performance target (internal, not an official Jungle Gaming threshold)

- Sustained 5-minute steady-state measurement at each load level.
- Request latency: **p95 below 500 ms**, **p99 below 1000 ms**.
- Technical error rate **below 1%**, measured separately from valid business rejections.
- CPU: record total process CPU normalized by available cores, monitor throttling and event-loop stalls; investigate >85% sustained utilization as a risk, not an automatic failure without hardware details.
- Memory: record RSS/heap, GC, and growth at constant traffic. Investigate >10% steady-state RSS growth over the final 3 minutes after warm-up.
- Descriptors: record file descriptors, connections to Postgres/SQS, and operating-system ulimit. Investigate growth with stable traffic and warn if descriptor use exceeds 70% of configured limit.
- Durability: do not disable PostgreSQL WAL or synchronous commits merely to increase performance scores.

## Reproducible stages

1. `smoke`: 5 virtual users, basic connectivity.
2. `baseline`: 100 VUs for 5 minutes, resource baseline.
3. `ramp`: 1,000 VUs, bottleneck discovery (no premature performance target).
4. `peak100k`: 100,000 VUs, five-minute steady state (requires explicit opt-in and adequate distributed generation).
5. `peak200k`: 200,000 VUs, five-minute steady state (requires explicit opt-in and adequate distributed generation).

Virtual users are not simultaneously executing HTTP requests. With a 5-second think time and negligible latency, 100k VUs may yield roughly 20k requests/second; 200k VUs roughly 40k. Real RPS depends on latency, client resources, think time, and the workload. If the client load generator saturates, results are invalid and the generators must be distributed.

## Run today: HTTP-only baseline

Start the API locally, then install k6 (e.g. `brew install k6`) and run:

```bash
PROFILE=smoke k6 run scripts/bench/http-health.js
PROFILE=baseline BASE_URL=http://127.0.0.1:3000 k6 run scripts/bench/http-health.js
```

Sample server process CPU, RSS (KiB), and FD count in a separate terminal:

```bash
pgrep -fl bun
bash scripts/bench/sample-process.sh <BUN_SERVER_PID> 300 artifacts/bench/process.csv
```

Do not execute `peak100k` or `peak200k` on an unprepared machine. They are disabled unless `CONFIRM_PEAK=yes`, which is still **not** a resource guarantee. Use only controlled infrastructure with permission to load test it. Docker-based k6 runners can use `host.docker.internal` as the target on Docker Desktop.

## Financial workload: not implemented yet

After authenticated wager endpoints and durable SQS Inbox/Outbox exist, add a separate k6 workload with deterministic actors, different-wallet traffic, same-wallet contention, BET/WIN/LOSS/REFUND/ROLLBACK distribution, duplicate events, and business-rejection classification. Snapshot balance invariants and ledger reconciliation **after** the load run. Do not represent the existing health benchmark as financial capacity.

## Benchmark report checklist

Record commit SHA, Bun version, PostgreSQL version/settings, kernel/OS, CPU and RAM limits, app instance count, DB pool, DB WAL settings, k6 generator topology, test data volume, warm-up time, precise request mix, p50/p95/p99, RPS, errors, CPU per core, peak/steady RSS, GC, FD counts, DB lock wait times, connection counts, and invariant checks. Attach raw CSV/JSON traces where possible, and explicitly distinguish observed vs target metrics.
