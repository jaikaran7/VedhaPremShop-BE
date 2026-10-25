# Continuation Checkpoint

Read this first. It links to the other handover documents instead of repeating them:
[project-history](project-history.md) · [business-rules-and-decisions](business-rules-and-decisions.md) ·
[implementation-status](implementation-status.md) · [requirements-reconciliation](requirements-reconciliation.md).

## Where things stand (2026-10-25)

- **Done and verified:** foundation, auth, masters, customers, vendors, stock ledger, sales (backdate approval, cancel/rebill), payments
  (advances), **Phase 7: costing, purchases, receiving, vendor payables, `/reports` snapshot**. Backend 71/71 tests, frontend 44/44, lint and
  typecheck clean, migrations applied to Neon **dev**.
- **Stopping point of the previous session:** frontend Sale Details actions and Approvals screen (present in source, type-checked, not
  browser-tested, not committed).
- **Not committed anywhere.** `VedhaPremShop-BE` has one empty commit; `VedhaPremShop-FE` has ~24 modified files.
- **Never touched:** production (`ep-round-bar`, the commented `DATABASE_URL` in `.env`). Keep it that way until a deliberate deploy.

## START HERE NEXT SESSION

### 0. Housekeeping (5 minutes, needs the owner's go-ahead)
1. Commit both repos (`badri-be`, `badri-fe`). Do not commit `.env` (it is gitignored).
2. The API on :4000 (PID may differ) was started before the `/reports` route existed. Restart it: `cd VedhaPremShop-BE && npm run build && npm start`.

### 1. Next implementation task — Expenses, expense categories, cash accounts
**Why:** the frontend Collections screen (`src/hooks/queries/use-collections-query.ts` → `use-expenses-query.ts`) and Record Expense page call
`/expenses`, `/expense-categories`, `/cash-accounts`; all return 404 in API mode.

**Contract (from `src/api/payments.api.ts` and `src/types/index.ts`):**

| Method & path | Roles | Body → Response |
|---|---|---|
| GET `/cash-accounts` | O, M | → `CashAccount[]` `{id, name, kind CASH/BANK/UPI, openingBalance}` (seeded; no create endpoint exists in the frontend) |
| GET `/expense-categories` · POST | O, M | `{name, trackingCategory: ONION_SALES/AMALI/OTHER_PRODUCT/MARKET_FEE/OTHER \| null}` → `ExpenseCategory`; POST of an existing name (case-insensitive) returns the existing row (mock behaviour) |
| GET `/expenses` · POST | O, M | `{categoryId, amount>0, date, paymentMethod, accountId, reference?, trackingCategory?}` → `Expense` (adds `categoryName`, `accountName`, `recordedBy`, `createdAt`) |

**Files to add** (follow `modules/purchases` and `modules/settings/costing.*`): `prisma/schema.prisma` models `CashAccount`,
`ExpenseCategory`, `Expense` + a new migration (generate with `prisma migrate diff` against a scratch DB, then append CHECKs:
`amount > 0`, expense append-only trigger via the existing `forbid_history_change()`); `src/modules/expenses/{expenses.module,controller,service,dto}.ts`;
register in `app.module.ts`; extend `database/seed.ts` + `seeds/dev-fixture.json` from `SEED_CASH_ACCOUNTS` / `SEED_EXPENSE_CATEGORIES` in the
frontend's `src/data/seed.ts`; add `/expenses` data to `ReportsController` only if the Reports screen needs it (check `use-reports-query`).

**Rules already defined by the frontend:** `validateExpense` in `src/utils/collection-ledger.ts:342`. Account balances are computed by the
frontend as opening + received − paid out (`collection-ledger.ts` ~line 320); the backend only stores rows. Money in paise, audit inside the
transaction, `organization_id` from the token only.

**Acceptance:** (a) e2e `test/expenses.e2e.spec.ts`: create category → record expense → list; bad amount/date/unknown category/account → 400/404;
salesperson 403; other org 404; expense row cannot be updated/deleted in SQL. (b) `npm run typecheck && npm run lint && npm test` green.
(c) Browser: Collections and Record Expense load against the API with no 404 (`read_network_requests`). (d) Update `implementation-status.md`.

### 2. After that (in order)
1. **Owner decisions** that unblock design: Q10 (vendor payments), Q11 (mandatory consignment charges), D9 (distributor linking). See business rules.
2. **Browser click-through** of everything session 2 and 3 added but only type-checked: New Sale date picker + approval notice, rebill, Approvals
   screen as Owner and as Salesperson, credit warning, New Purchase, Receive Lot, Costing settings, Customers advance line.
3. **Phase 8:** metric SQL per `docs/architecture/business-domain.md` (revenue, collections, receivables, stock), replacing client-side
   aggregation; remove the 5000-row snapshot cap in `reports.controller.ts`.
4. **Phase 9:** RLS, production migration rehearsal on a Neon branch, deploy, monitoring, backup drill.

## Environment facts a new session needs

| Item | Value |
|---|---|
| Backend | `VedhaPremShop-BE`, NestJS 11, Prisma **7.10.1** (`@prisma/adapter-pg`), Node ≥ 22, port 4000, prefix `/api/v1` |
| Dev DB | Neon `ep-odd-flower…`, PostgreSQL 18.6. `.env`: `DATABASE_URL` (pooled) + `DIRECT_DATABASE_URL` (migrations). Commented `ep-round-bar` = **production** |
| Test DB | local Postgres 17, `vedhaprem_test` (`DATABASE_URL_TEST`); tests `TRUNCATE` it. The harness refuses a URL without "test" |
| Local Postgres | `/opt/homebrew`, data in `~/.local/share/vedhaprem-pg`; `pg_isready -h localhost` |
| Seed users | `owner`, `manager`, `salesperson`; password = `SEED_USER_PASSWORD` in `.env` (never print it) |
| Frontend | `VedhaPremShop-FE`, Next 15, port 3000, API mode when `NEXT_PUBLIC_API_BASE_URL` is set (`.claude/launch.json` → `fe-api-mode`) |
| Run backend | `npm run build && npm start` (loads `.env`) |
| Sourcing `.env` in a shell | **Do not** — the URLs contain `&`. Use `node --env-file=.env` or read single keys |
| Migrations | `npm run db:migrate` (deploy), `db:status`. New migration: scratch DB → `prisma migrate deploy` → `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` |
| Tests | `npm test` (`--runInBand` is required: e2e files share one DB) |

## Risks to keep in view

| # | Risk | Mitigation |
|---|---|---|
| R1 | All work uncommitted | Commit (step 0) |
| R2 | Production DB has no schema | Intentional; run `db:migrate` against it only at deploy, after a Neon branch rehearsal |
| R3 | Receiving math duplicated in FE and BE | Parity script passed; keep `costing.ts`/`receiving.ts` and `receiving.calc.ts` in step |
| R4 | Vendor payable can only grow (no payments) | Q10 |
| R5 | Tests run on PG 17, Neon is PG 18 | No version-specific SQL used so far; add a PG 18 test branch before production |
| R6 | `/reports` snapshot is capped at 5000 rows and cost-bearing | Owner/Manager only; Phase 8 replaces it |
| R7 | In-memory rate limiter is per instance | Move to a shared store before running more than one instance |
