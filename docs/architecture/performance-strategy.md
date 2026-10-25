# Performance and Cost Strategy

Principle: measure first; add infrastructure only for a demonstrated need.

## What is in place

| Area | Choice | Effect |
|---|---|---|
| Connections | One `pg.Pool` per process (`DB_POOL_MAX`, default 10), Neon **pooled** endpoint | No connection per request; many instances share few Postgres backends |
| Query shape | Lists: 2–3 queries regardless of page size (headers, then lines/tenders by `IN (...)`) | No N+1 |
| Aggregates | Outstanding, paid amount, lot totals computed in SQL / from already-fetched rows | No second copy of balances to keep in sync |
| Writes | One transaction per business action, short (no network calls inside), deterministic lock order | Low lock hold time, no deadlocks |
| Payload | 256 kB JSON limit; bounded lists (max 5000) | Protects memory |
| Timeouts | `query_timeout` 15 s on the pool | A stuck query fails instead of piling up |
| Cost | No Redis, queues, object storage or paid APIs | Neon + one small Node service |

## Known costs to watch

1. **The frontend fetches whole collections** (`/sales`, `/payments`, `/customers/ledger`) and computes dashboards
   and reports in the browser. Fine for one shop's first months; grows linearly. Phase 8 moves dashboard/report
   aggregates to SQL endpoints and pages the history screens.
2. Bill numbering locks one `document_sequences` row per organization, so bills in one shop post one at a time.
   A mandi counter posts a few bills per minute; each transaction is a few ms. Revisit only if measured contention
   appears.
3. `GET /customers` aggregates the ledger per request. Index `ledger_customer_idx` covers it; if it shows up in
   p95, add a per-customer balance table maintained in the same transactions (and reconcile it).
4. Neon autosuspend: first request after idle pays a cold start (~0.5–1 s). Keep autosuspend for cost, or disable
   it on the production branch during trading hours if the first-bill delay matters.

## Budgets (to confirm once deployed)

Targets for a single shop on a small instance in the same region as Neon:

| Endpoint | p50 | p95 |
|---|---|---|
| POST /sales (≤ 10 lines) | 60 ms | 200 ms |
| POST /payments | 40 ms | 150 ms |
| GET lists (≤ 1000 rows) | 80 ms | 300 ms |

These are **not measured yet**. Measure with request logs (`X-Request-Id` + duration) or an APM after deploy, and
check heavy queries with `EXPLAIN (ANALYZE, BUFFERS)` on a Neon branch loaded with realistic volume.

## Frontend caching

Every mutation invalidates every query (`useInvalidateMandi`). Correct but chatty: after a bill, ~10 lists refetch.
Narrowing invalidation per mutation is a cheap later win; it is deliberately unchanged now to avoid stale screens.
