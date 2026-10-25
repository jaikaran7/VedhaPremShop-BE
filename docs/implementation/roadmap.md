# Implementation Roadmap

Status as of 2026-10-25 (session 3). "Done" means implemented, migrated, tested on a real Postgres (local 17 for tests, Neon dev 18.6
for the app), and exercised from the frontend where a screen exists. Handover detail: `docs/handover/`.

| Phase | Scope | Status | Evidence |
|---|---|---|---|
| 0 | Frontend audit, domain, architecture, contracts | Done | `docs/architecture/*` |
| 1 | NestJS foundation, env validation, Prisma 7.10.1 + migrations, error filter, request ids, health, lint/typecheck/tests | Done | `npm run lint`, `typecheck`, `build`, migrations applied to a fresh DB |
| 2 | Login/refresh/logout/me/change-password, rotation + reuse detection, roles, org scoping, user management, bootstrap script, rate limits | Done | `test/auth.e2e.spec.ts` (13 tests) |
| 3 | Settings masters (company, sale charges, marks, products), customers (+ ledger, credit-term permissions, safe delete), vendors | Done | e2e + browser (customers list) |
| 4 | Lots, stock movements ledger, adjustments, opening stock, reconciliation | Done | e2e + browser (stock screen) |
| 5 | New Sale: pricing, charges, settlement, counter sales, gap-free numbers, atomic stock, receivable, idempotency, cancellation | Done | `test/sales.e2e.spec.ts` + bill VPN-INV-1085 posted from the UI |
| 6 | Receipts: allocation (named bill → oldest → opening), overpayment guard, idempotency | Done (API); receipts screen not clicked through in the browser | e2e |
| 7 | Purchases, receiving (port of `utils/receiving.ts` + `utils/costing.ts`), vendor payables, costing settings, `/reports` snapshot | **Done (session 3)** | `test/purchases.e2e.spec.ts` (14), `receiving.calc.spec.ts` (8), frontend-vs-server parity script, Neon dev migrated |
| 8 | Dashboard/report aggregates in SQL, paginated history, metric definitions from `business-domain.md` | Planned | — |
| 9 | Hardening: RLS, APM, load test, backup drill, dependency overrides, production deploy | Planned | — |
| 6b | Backdated-bill approvals, cancel/rebill, advances, Prisma + Neon switch | Done (session 2); new frontend screens typechecked, not browser-tested | `test/sales.e2e.spec.ts` |
| 8a | Expenses, expense categories, cash accounts, vendor payments (Collections screen) | **Done (session 4)** | `test/expenses.e2e.spec.ts` (8), `test/business-flow.e2e.spec.ts` (1), Neon dev migrated |

## Acceptance criteria for Phase 7 (met, except as noted)

1. `POST /purchases` stores the vendor bill (items, typed expenses) without stock; `receiptStatus = PENDING_RECEIPT`.
2. `POST /purchases/:id/receive` evaluates receiving server-side with the same rules as `utils/receiving.ts`
   (accepted/defective bags, expense allocation by kg/bags/group, landed cost, rounding `CEIL_WHOLE_RUPEE`,
   override reason), creates/extends the lot, writes PURCHASE_IN movements, freezes the rate snapshot.
3. Vendor payables derived from purchases minus vendor payments (met in session 4 via Purchase Payments expenses); `Vendor.totalPurchases/payableAmount` real.
4. New Sale blocks lots whose purchase is still pending receipt (frontend already checks `receiptStatus`).
5. Reconciliation extended (`purchaseDrift`); e2e for receive-twice, partial acceptance and 10 concurrent receives. Payables need no separate
   reconciliation: they are a sum over purchases.

## Frontend changes made so far (repo `vedhapremshop`, branch `badri-fe`)

- `src/api/client.ts`: cookies (`credentials: include`), `X-Requested-With`, one shared silent refresh on 401,
  server error messages surfaced, `idempotencyHeaders()`.
- `src/api/auth.api.ts`: `login`, `logout`, `getSessionUser`; persona-switch is a no-op against the API.
- `src/api/sales.api.ts`, `payments.api.ts`: Idempotency-Key per submission.
- Login: real sign-in in API mode, demo personas only in mock mode. Session restored from `/auth/me`.
  Header persona menu disabled and Sign Out revokes the session in API mode.
- `TRADING_SESSION_DATE`: today in Asia/Kolkata in API mode (mock mode unchanged); dashboards, Today's Sales,
  Salesperson Home and the header use it instead of hard-coded `2026-10-01`.
- Types: `SALE_REVERSAL` movement, `ADJUSTMENT` ledger entry; stock screen shows `+` for every inbound type.
