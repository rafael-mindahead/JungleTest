# Architecture and engineering decisions

Source of acceptance criteria: [Jungle Gaming — Distributed Wagering Processor](https://github.com/junglegaming/backend-challenge/blob/main/README.md). This document describes the implementation on `feat/wallet-ledger-performance`; it is **not** a claim of production readiness.

## Design at a glance

```text
HTTP request                           FIFO SQS request
    |                                        |
WageringController                  WagerWorkers.consume
    |                                        |
    +-------------------+--------------------+
                        |
                WageringService
                        |
               PostgreSQL transaction
                (wallet row lock)
                        |
         +--------------+---------------+
         |              |               |
     wager tx        wallet +        Inbox row
    outcome          append-only     (SQS only)
                     ledger             |
         +--------------+---------------+
                        |
                    Outbox rows
                        |
                      COMMIT
                        |
               WagerWorkers.publish
                        |
                  FIFO SQS events
```

## Stack and boundaries

- **Bun 1.x, TypeScript strict, NestJS, PostgreSQL 17, MikroORM 7 and MiniStack FIFO SQS**. Docker Compose orchestrates local persistence and broker emulation.
- `Money` owns exact decimal amounts, currency and JSON serialization independently of Nest and the ORM. SQL uses `NUMERIC(20,2)`. Never use JS floating-point values for balances.
- `Wallet` is an aggregate root with private state and factories for opening and rehydration. The ledger domain entry is immutable.
- `WagerTransaction` now contains a **small, executable aggregate state machine** and reference-kind rules, directly exercised by the transactional settlement service and domain tests. The shared HTTP/SQS validation contract moved to `wager-input.ts`. `WageringService` still mixes orchestration with direct SQL instead of independent repository ports and Unit of Work: it preserves atomicity but remains less layered than the competitor.
- MikroORM manages connection pooling and transactions. Some financial persistence uses direct parameterized SQL inside a MikroORM transactional EntityManager because precise row locks and DML conditions are essential.

## Invariants and consistency

- **Concurrency unit:** wallet ID. The wagering transaction path uses `SELECT ... FOR NO KEY UPDATE` to serialize balance writes while remaining compatible with the FK `KEY SHARE` taken when inserting a new wager. The wallet repository also locks a row before standalone ledger writes. Independently locked wallets can progress in parallel; there is no shared global lock.
- **Ledger:** append-only trigger, uniqueness per wallet/transaction, arithmetic CHECK, positive amounts, nonnegative balance snapshots.
- **Wallet:** unique (player,currency), nonnegative balance constraint, version increment only for balance-changing movements.
- **Wagers:** external identity is `(provider_id, external_transaction_id)`; the current idempotency key is globally unique (stronger uniqueness, but less flexible than provider-scoped keys), and payload hash canonicalization sorts business-field keys.
- **Replay:** a processed/rejected transaction is returned without reapplying its wallet movement. Existing transaction status is durable in PostgreSQL.
- **Out-of-order references:** `PENDING_REFERENCE` is stored and retried by a polling worker with exponential backoff. A finite retry limit results in rejection.
- **Wagering result events:** generated and appended to Outbox *within the same SQL transaction*. Publication occurs only after commit.
- **SQS Inbox:** inserts deduplication record inside the financial transaction; SQS ACK is attempted only after commit. Redis or in-memory caches are not used as correctness guarantees.

## Trade-offs and failure handling

| Failure | Behavior / current limits |
|---|---|
| Two competing debits | One wallet row lock serializes both; no negative balance |
| Duplicate request | Unique keys + payload hash prevent duplicate financial effect |
| Process dies before SQL commit | DB transaction rolls back; SQS can redeliver |
| Process dies after commit but before SQS ACK | Inbox will recognize replay; **fault injection test remains required** |
| Process dies after Outbox commit but before publish | Another publisher can claim pending rows; recovery with concurrent publishers passed in MiniStack CI |
| Process dies after publish but before Outbox marking | At-least-once delivery can duplicate events; downstream consumers must deduplicate |
| Multiple publishers | SQL `SKIP LOCKED` claims + per-row lease; concurrent publisher test passed against MiniStack |
| Poison message | FIFO redrive to DLQ passed after configured retries in MiniStack CI |
| Three API/worker processes | Shared DB lock allows correctness; CI test runs three separate Bun/NestJS processes on one PostgreSQL service |
| Retry after reference not found | Stored backoff and attempt cap; terminal rejection is audited |

## Authentication and operational security

HTTP wallet routes require the `jungle-admin` role, including opening credits and reconciliation. Wager submission requires `jungle-provider` and an exact token `provider_id` match. Transaction lookup by provider is similarly scoped; internal-ID lookup is admin-only. Health endpoints are public. The token verifier accepts **RS256** with configured `iss`, `aud`, `exp`, `nbf`, signature and an external HTTPS JWKS endpoint (short-lived cache). There is **no local password database**. A controlled local test allows a loopback HTTP JWKS; never use this for a live IdP.

The only insecure bypass requires **all three** of `ALLOW_INSECURE_TEST_AUTH=1`, `NODE_ENV=test` and a `DB_NAME` ending in `_test`. It is used only by disposable CI correctness fixtures. Missing IdP configuration fails closed on protected endpoints. Production deployment requires a reachable external IdP, TLS, protected secrets and token issuance; the example three-node Compose stack intentionally does not claim to provide an IdP.

SQS is treated as an internal trusted transport per the challenge; it retains the same domain-level provider/reference checks as HTTP. Network/IAM boundary control remains an operational responsibility. Authentication is worth zero rubric points.

## Observability

`GET /health/live` and `GET /health/ready` separate liveness and dependency readiness. The `GET /internal/metrics` endpoint is protected by `METRICS_TOKEN` (min 12 characters), uses constant-time comparison and reports durable transaction status counts, Inbox volume, retry counts, pending Outbox/age, approximate DLQ state and process-local financial metrics. It intentionally omits player identities and monetary payloads. In addition, the protected Prometheus 0.0.4 endpoint exports counters, histograms and gauges. An opt-in native OTLP/HTTP JSON exporter follows W3C traceparent from HTTP into financial settlement, persisted Outbox context and SQS. This is not an OpenTelemetry JS SDK implementation, and production sampling/visualization are still external responsibilities. Express middleware now generates or safely accepts `X-Correlation-Id` and emits JSON access logs with route templates, status and latency. A global exception filter produces stable error codes and correlation IDs while hiding unhandled exception details. Correlation is request-level only: distributed trace propagation across SQS and Prometheus/OpenTelemetry remain gaps.

## Reconciliation and snapshots

Opening a wallet writes an initial ledger credit in the same SQL transaction. Reconciliation now reads the materialized balance and append-only ledger sum inside **one PostgreSQL REPEATABLE READ transaction**, avoiding false mismatches when concurrent wagers commit between the two reads. A real-Postgres HTTP concurrency regression guards this behavior. Migrations have `down()` methods and are exercised on a disposable empty database in the correctness workflow.

## Measured evidence and limitations

The successful correctness workflow verifies 39 Money/Wallet unit tests, financial HTTP/PostgreSQL integration, three independent Bun/NestJS processes including 50 duplicate BETs, RS256 JWT/role/provider access tests and MiniStack SQS Inbox/Outbox, crash/DLQ/publisher recovery. See [requirements audit](docs/REQUIREMENTS_AUDIT.md) for exact stage counts and current run links.

The optional **historical pre-authentication** 100-VU experiment ran on a GitHub-hosted runner (5-minute hold with ramps) at about **665.01 HTTP requests/s**, p95 **54.45 ms**, p99 **69.78 ms**, zero reported technical errors, and a passing final wallet/ledger reconciliation. Those figures apply only to the previous unauthenticated run and its particular environment. The JSON summary file failed to save due to a container permission problem, although the k6 text metrics are in the job log. The workflow is now manual-only and requires short-lived real tokens; we did **not** retest the load after authentication.

The new [Dockerfile](Dockerfile) and [three-instance Compose overlay](docker-compose.cluster.yml) permit a reproducible deployment demonstration after supplying an external IdP. The CI validates the configuration and builds the image, but this is **not** proof that a three-node Compose deployment with a real IdP has been exercised. The existing three-process integration test independently confirms financial concurrency.

Remaining non-eliminatory gaps: dedicated persistence ports for the WagerTransaction aggregate, full OpenTelemetry JS SDK instrumentation and hosted tracing, full SIGTERM interruption/restart matrix, and a deployment exercise against an external IdP. No claim of 100k/200k virtual users, production hardening or exactly-once transport delivery is made.
