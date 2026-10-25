# Requirements Reconciliation

Compares the two earlier prompts (P1 = architecture/implementation master prompt, P2 = the owner's answers) with the code as it stands.

## Implemented as asked

NestJS modular monolith · versioned REST (`/api/v1`) · Swagger · DTO validation · JWT + refresh rotation + cookies · org-scoped RBAC ·
money in paise / weight in grams, never floats · immutable stock and ledger history (DB triggers) · stock ledger with reconciliation ·
sales / payments / receivables as separate entities · atomic stock deduction under concurrency · idempotency on sales and receipts ·
audit log inside the business transaction · migrations only (no schema sync) · no mock fallback in API mode (`isMockApi()` is explicit).

## Implemented differently

| Asked | Actual | Why it is acceptable |
|---|---|---|
| Folder layout `application/ domain/ infrastructure/` per module | Flat per module: `*.controller`, `*.service`, `*.dto`, `*.calc.ts` (pure rules) | P1 called its structure "a starting proposal"; pure `*.calc.ts` files carry the testable rules |
| Customer and supplier as roles on a shared party | Done (`parties` + `customers` + `vendors`) | — |
| Drizzle (session 1's pick) | **Prisma 7.10.1** | Owner's instruction in P2 |
| Postgres 17 local | Neon dev is **PG 18.6**; local test DB is 17 | Owner chose 18; tests use a disposable local DB. Different majors — see risk R5 |
| Dashboard metrics computed in SQL | Frontend computes from list endpoints; `/reports` snapshot | SQL aggregation is Phase 8 |
| Vendor payables = purchases − vendor payments | Done (session 4): vendor payments are Purchase Payments expenses naming a vendor | Advance / opening balance open |

## Not implemented

| Item | Source | Note |
|---|---|---|
| Distributor-as-organization linking | P2 | Schema column only; needs an invite/link flow and cross-org read rules |
| Row-level security | P1 §7.1 | Phase 9 |
| Server-side search/pagination for customers, sales | P1 §9 | Lists are bounded (default 1000, max 5000) |
| Redis, queues, object storage, materialized views | P1 §4 | Deliberately not added; no measured need |
| Production deployment, monitoring, backup drill | P1 §16 Phase 9 | Documented, not done |
| Purchase attachments (`attachmentUrl`) | Frontend type | No object storage; field not stored |
| Per-user permission overrides | — | Roles only |

## Attempted and failing
None known. The "Uncaught SyntaxError" noted in session 1 was never reproduced or traced.

## Conflicts between prompts and business reality
- P1 asks to prevent negative stock "unless authorised"; the sale rules (D7: sell below floor) are unrelated, but D4 lets blocked customers be
  billed, so the **credit-control safeguards are warnings, not gates** — intentional per the owner.
- P1 says higher-level distributors must not see downstream data by default; P2 says distributors are parties only. Consistent today (no
  cross-org reads exist). If D9 grows into shared books, this needs an explicit access model first.

## Duplicated work
The receiving math exists twice by design: frontend `utils/costing.ts` + `utils/receiving.ts` (live preview) and backend
`modules/purchases/receiving.calc.ts` (authoritative). A parity check passed (see `implementation-status.md`); keep them in step or move the
preview to call a server dry-run endpoint.
