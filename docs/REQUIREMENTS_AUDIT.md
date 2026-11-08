# Official Jungle Gaming requirements audit

**Authority:** [junglegaming/backend-challenge README](https://github.com/junglegaming/backend-challenge/blob/main/README.md), especially sections 4–14. **Audit basis:** code on `feat/wallet-ledger-performance`; test counts refer to GitHub Actions and are not a performance score. This file is an explicit coverage map, not a substituted grading rubric.

| Official area (maximum) | Current evidence | Unverified / incomplete |
|---|---|---|
| Financial correctness (20) | Money + Wallet unit tests; ledger CHECKs and immutable trigger; API BET/WIN/LOSS/REFUND/ROLLBACK and reconciliation | WagerTransaction domain state machine is represented in service/SQL, not full encapsulated class; internal OPENING transaction record model needs review |
| Concurrency (20) | Postgres wallet lock; 2x80 same-wallet dispute; 30 concurrent debits; **50 identical HTTP wagers across 3 actual Bun processes** when CI is green | Worker crash/restart races and concurrent Outbox publishers still needed |
| Idempotency (15) | PostgreSQL uniqueness, canonical payload hash, Inbox dedup, same-key and conflict tests | Provider-scoped key semantics and extra failure-path replays to audit |
| Messaging and failures (15) | Real MiniStack FIFO receive, Inbox, Outbox, published events, retry workers | DLQ redrive, SIGTERM in-flight, after-commit crash, after-publish crash, concurrent publishers |
| Domain modeling and architecture (10) | Money, Wallet, ledger domain; `ARCHITECTURE.md`; no global lock | Extract business transitions from large service into explicit WagerTransaction aggregate and ports |
| Tests (10) | Unit, real PostgreSQL, HTTP, MiniStack e2e; multi-process test | Deterministic fault-injection and multiple publishers |
| Observability (5) | Health checks; some structured worker logs | Required counters: status, duplicate, retries, DLQ, lock conflicts, outbox lag, processing latency |
| Documentation (5) | README, architecture, trade-offs, performance goals, CI commands | Final performance report and benchmark method/results when executed |

## Important clarifications from the official rubric

1. The Jungle score is **100 points** across 8 weighted categories: 20/20/15/15/10/10/5/5. This is the *company's published weighting*, not our score.
2. **Authentication is worth 0 points**. It is acceptable to defer it **if** the decision and a proposed IdP integration are clearly documented in `ARCHITECTURE.md`. No homemade password table.
3. **Load tests are optional differentiators.** The company specifies **no RPS or 100k/200k-VU performance threshold**. Our 5-minute p95/p99 targets are internal and do not belong in the official acceptance column.
4. A passing CI run doesn't eliminate the company's disqualification risks. Especially important: correct operation with >=3 processes, no double debit/credit, no negative balance and Outbox after commit.
5. **No score prediction is guaranteed**. A credible final estimate needs explicit supporting evidence from all CI scenarios and any load report before PR merge/submission.

## Suggested release gates before marking the PR ready

- 50 replays and three processes tested together with `wallet.balance == ledger`.
- Crash after DB commit and before ACK; restart and repeat yield one ledger effect.
- 2 publishers, no lost event; forced duplicate publication harmless at receiver.
- Poison message reaches configured DLQ; graceful worker shutdown.
- Metrics include outbox lag, status/retry/duplicate/lock counts and processing latency.
- All migrations and reverse migrations tested on disposable database.
- README, ARCHITECTURE, CI results, assumptions and any optional benchmark evidence updated.
