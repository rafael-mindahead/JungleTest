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
- `WageringService` currently combines orchestration with direct SQL. This **architectural compromise** protects the atomicity of wallet, ledger, transaction outcome, Inbox and Outbox, but should be refactored into domain model and persistence ports to improve maintainability.
- MikroORM manages connection pooling and transactions. Some financial persistence uses direct parameterized SQL inside a MikroORM transactional EntityManager because precise row locks and DML conditions are essential.

## Invariants and consistency

- **Concurrency unit:** wallet ID. `SELECT ... FOR UPDATE` serializes competing operations on the same wallet. Independently locked wallets can progress in parallel; there is no shared global lock.
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
| Process dies after Outbox commit but before publish | Another publisher can lease pending rows; **restart test remains required** |
| Process dies after publish but before Outbox marking | At-least-once delivery can duplicate events; downstream consumers must deduplicate |
| Multiple publishers | SQL `SKIP LOCKED` claims + per-row lease; **concurrent publisher test remains required** |
| Poison message | SQS queue has redrive policy to DLQ; **DLQ test remains required** |
| Three API/worker processes | Shared DB lock allows correctness; CI test runs three separate Bun/NestJS processes on one PostgreSQL service |
| Retry after reference not found | Stored backoff and attempt cap; terminal rejection is audited |

## Authentication and operational security

The official task **assigns zero points to authentication**. The current prototype intentionally has no identity provider; `/health/live` and `/health/ready` are public. **Do not expose the API to untrusted traffic**: `POST /wallets` allows creation with arbitrary positive funding, and provider/wallet ownership is unverified at the network boundary. For production, place an OIDC IdP (Keycloak/Zitadel), a provider identity adapter and admin-only funding guard at ingress. SQS remains an internal trusted transport, while provider identity carried by events must be checked against wallet scope.

## Observability

Liveness and readiness endpoints exist. Worker logs are structured JSON in most failure paths. Comprehensive business counters, Outbox lag, retry metrics and correlation across endpoints are **not yet implemented**.

## Test proof and unknowns

GitHub Actions runs real Postgres migrations, domain tests, HTTP integration tests, a three-process concurrent load test, and a real MiniStack FIFO SQS end-to-end integration test. The multi-process test sends 50 identical requests, disputes one wallet and drives separate wallets in parallel.

Proof still missing: worker crash precisely after commit/before ACK, crash after publish/before flag, DLQ redrive, 2+ simultaneous Outbox publishers and restart reconciliation. These gaps matter under sections 10-14 of the official rubric.

The health-endpoint-only k6 script is **not** a financial throughput benchmark. The official rubric assigns no fixed RPS target; 100k/200k VUs are an internal stretch goal, not a Jungle Gaming requirement. Do not claim those tests have run.
