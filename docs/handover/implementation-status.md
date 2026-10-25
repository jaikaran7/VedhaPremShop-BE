# Implementation Status (2026-10-26, session 5)

Statuses: **Verified complete** · **Implemented, unverified** · **Partial** · **Not implemented** · **Blocked** · **N/A**.
"Verified" means a command was run in session 3 and passed (listed at the bottom), not that a previous session said so.

| Workstream | Status | Evidence (files) | What works | Gap / next action | Done when |
|---|---|---|---|---|---|
| Repository setup | Partial | `package.json`, `prisma.config.ts`, `.env.example` | Scripts build/lint/test/migrate/seed; env validated | **Nothing is committed in either repo.** Commit and push after review | `git log` shows the work |
| Frontend inventory | Verified complete | `docs/architecture/frontend-screen-inventory.md` | Every route, form and mock rule recorded | Keep in step with new screens | — |
| Backend foundation | Verified complete | `src/app.ts`, `src/config/env.ts`, `common/http/*`, `health/` | Global validation (whitelist), one error shape, request ids, throttling, Swagger | — | — |
| Database | Verified complete (dev) | `prisma/schema.prisma`, 3 migrations | Neon **dev** is PG 18.6, all 3 migrations applied; CHECKs + append-only triggers | **Production (`ep-round-bar`) has no migrations applied** — run `db:migrate` against it deliberately at deploy | `db:status` on prod is up to date |
| Authentication | Verified complete | `modules/auth`, `test/auth.e2e.spec.ts` | Login, rotating refresh with reuse detection, logout, CSRF header, change password | — | — |
| Authorization | Verified complete (RBAC + tenancy) | `common/auth`, e2e | Roles enforced server-side; other orgs get 404 | Postgres RLS **not implemented** (Phase 9, defence in depth) | RLS policies + test |
| Customers | Verified complete | `modules/customers` | CRUD, credit terms by role, ledger, advance, safe delete | Search/pagination are client-side; fine at current size | — |
| Suppliers (vendors) | Verified complete (core) | `modules/vendors` | CRUD; payable = bills − vendor payments | Advance / opening balance / returns (questions 1, 2, 4); distributor link has no endpoints (D9) | Owner answers |
| Inventory / lots | Verified complete | `modules/inventory`, `stock-ledger.ts` | Lots derived from marks; atomic conditional stock change | — | — |
| Stock movements | Verified complete | `StockMovement`, `reconciliation.ts` | Ledger + `stockDrift`; PURCHASE_IN now included | — | — |
| New Sale | Verified complete (API) | `modules/sales`, `test/sales.e2e.spec.ts` | Server totals, idempotency, atomic stock, bills on any date post at once, cancel/rebill with Owner approval | New FE parts (date picker, rebill mode, credit warning) are **typechecked only**, not browser-tested | Click-through of the five flows |
| Sales & invoices | Verified complete (API) | same | List/detail, statuses, printable data | — | — |
| Payments | Verified complete (API) | `modules/payments` | Allocation, advance, refund on counter cancel | Receipt screens not browser-tested | Click-through |
| Receivables | Verified complete | `receivables.ts`, `receivableDrift` | Signed balance from the ledger | — | — |
| Purchases | **Verified complete (new)** | `modules/purchases/*`, `test/purchases.e2e.spec.ts` | Create bill, receive once, partial acceptance, rate snapshot, immutability, tenancy; **frontend draft/preview matches server on every field** | UI click-through of New Purchase and Receive Lot | Browser run |
| Costing masters | **Verified complete (new)** | `modules/settings/costing.*` | Default margin, expense types, per-kg margins; Owner writes | — | — |
| Dashboard / reports | Partial | `modules/reports` | **Lot breakdown (differential) computed on the server** by the frontend's own functions (ported verbatim; its tests pass unchanged), cached. `/reports` snapshot for the other reports | Other reports (outstanding, total sales, stock report, statements) still compute in the browser; the dashboard "Average Floor Rate" is hard-coded text | Owner picks the formula |
| Expenses / cash accounts / vendor payments | **Verified complete (new, session 4)** | `modules/expenses/*`, `modules/vendors/payables.ts`, `test/expenses.e2e.spec.ts`, `test/business-flow.e2e.spec.ts` | Accounts, categories, immutable expenses; Purchase Payments name a vendor and reduce the payable (409 above what is owed, 10 parallel payments cannot overspend); Record Expense checked in a browser in mock mode | Real-API browser click-through; owner questions #1–#4, #11–#12 | Browser run against API |
| Frontend integration | Mostly complete | `src/api/*` | sales, payments, customers, vendors, lots, stock, purchases, approvals, costing, reports, expenses, accounts wired | `settings/reset` (demo only), `sales/:id/edit-requests` (superseded by rebill) | Browser click-through in API mode |
| Validation | Verified complete | DTOs | Bounds, decimals, UUIDs, whitelist | — | — |
| Reliability | Verified complete | tests | Transactions, idempotency (sales, payments), row locks; 5 parallel sales and 10 parallel receives tested | Purchase create has no idempotency key (unique bill number guards it) | — |
| Testing | Partial | 80 backend + 44 frontend tests | Unit + e2e on real Postgres | No browser/UI e2e, no load test, no prod-migration rehearsal | Phase 9 |
| Security | Partial | `docs/architecture/security-model.md` | Hashing, rotation, rate limits, RBAC, tenancy | RLS; two transitive advisories (multer, js-yaml) documented | Phase 9 |
| Deployment | Not implemented | `docs/operations/deployment.md` | Documented only | No hosting chosen; CORS/cookie settings for cross-site not exercised | Staging deploy |
| Documentation | Verified complete | `docs/` | Updated this session | — | — |

## Verification run in session 3 (all observed)

| Command | Result |
|---|---|
| `npm run typecheck` · `npm run lint` (backend) | pass, no output |
| `npm test` (backend, `--runInBand`, local Postgres 17 test DB) | **80 passed / 80**, 8 suites (session 4) |
| `npm run build` (backend) | no errors |
| `npx tsc --noEmit` · `npm test` (frontend) | pass · **44 / 44** |
| `prisma migrate deploy` on a scratch DB, then `migrate diff --exit-code` | applied; "No difference detected" |
| `npm run db:migrate` on Neon **dev**, `db:status` | applied; "Database schema is up to date" |
| Read-only API smoke against Neon dev | purchases 9, vendors 3, costing + 10 expense types, 9/9 lots linked; salesperson gets 403 on purchases and costing |
| FE-vs-server parity script (frontend's own `draftGroupsFromPurchase` + `evaluateReceiving`) | all fields equal to 1e-9, including warning text |

**Not run:** frontend `next build` (a dev server on :3000 shares `.next`); any browser click-through; frontend lint (baseline of 121 warnings
from session 2 not re-measured); anything against production.

## Session 5 additions (verified)

| Area | Status | Evidence |
|---|---|---|
| Vendor opening balance, previous / new due, advance, account statement | Verified complete | `test/vendors.e2e.spec.ts`, `vendor-ledger.calc.spec.ts`; browser (mock mode) |
| Vendor bill correction with previous → current history; staff access | Verified complete | `test/purchase-edit.e2e.spec.ts`, `purchase-diff.spec.ts`; browser (mock mode); FE-shaped payload contract script against a real API |
| Optional charges, any-date vendor bills | Verified complete | tests; New Purchase screen |
| Optional GST on bills | Verified complete | `sales.calc.spec.ts`, `test/bill-tax.e2e.spec.ts`; FE and server totals agree to the rupee |
| Cash book, opening balances, staff expenses, daily collections | Verified complete | `test/cash-book.e2e.spec.ts`, FE `cash-book.test.ts`; browser (mock mode) |
| Lot breakdown on the server; stock movement filters + `X-Total-Count` | Verified complete | `reports/calc/*.spec.ts` (frontend's tests), `test/lot-reports.e2e.spec.ts` |
| Caching (per organization, in memory, no Redis) | Verified complete | `common/cache.ts`; read-after-write tests |
| **No N+1** | Verified | `test/lot-reports.e2e.spec.ts` (11 endpoints), `vendors`, `cash-book` specs: query count identical before and after growing the data |
| Not browser-tested against the real API | — | Only mock mode was clicked through; the real-API path is covered by the contract script and e2e tests |

Totals: backend **148** tests (jest, real Postgres), frontend **54** (node:test); typecheck, lint, build clean; Neon dev migrated (5 migrations).
