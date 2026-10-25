# Continuation Checkpoint

Read this first. It links to the other handover documents instead of repeating them:
[project-history](project-history.md) · [business-rules-and-decisions](business-rules-and-decisions.md) ·
[implementation-status](implementation-status.md) · [requirements-reconciliation](requirements-reconciliation.md).

## Where things stand (2026-10-25, end of session 4)

- **Done and verified:** foundation, auth, masters, customers, vendors, stock ledger, sales (backdate approval, cancel/rebill), payments
  (advances), purchases + receiving + costing, `/reports` snapshot, **expenses, cash accounts and vendor payments** (vendor payable =
  bills − payments). Backend 80/80 tests, frontend 44/44, lint and typecheck clean. Neon **dev** is migrated (4 migrations) and seeded.
- **Committed locally, not pushed:** backend `5d0e64e` on `badri-be`, frontend `b1bdad0` on `badri-fe`. **Session 4's own work (expenses,
  vendor payments, tally test, docs) is not yet committed** — run `git status` in both repos.
- **Never touched:** production (`ep-round-bar`, the commented `DATABASE_URL`). Keep it that way until a deliberate deploy.
- **Not browser-tested against the real API:** New Sale date picker/approval notice, rebill, Approvals as Owner/Salesperson, New Purchase, Receive
  Lot, costing settings, Customers advance line. Only Record Expense with vendor payment was clicked through (mock mode).

## START HERE NEXT SESSION

### 0. Housekeeping
1. Commit session 4's changes in both repos (no `.env`; use `-c user.name=Badrinath-04 -c user.email=badrinath8883@gmail.com` if no git identity;
   CLAUDE.md forbids a Co-Authored-By trailer). Push only when the owner says so.
2. The dev API on :4000 (not started by the agent) runs an older build. Restart it to get `/reports`, `/expenses`, `/cash-accounts`:
   `cd VedhaPremShop-BE && npm run build && npm start`.

### 1. Owner answers (see [questions-for-owner](questions-for-owner.md))
Apply each answer; most are small rules. The four with real impact on the numbers: #1 vendor advance, #2 vendor opening balances,
#4 correcting or returning a vendor bill, #11 opening cash/bank/UPI balances. Until answered, the safe defaults in that file apply.

### 2. Next implementation task — vendor bill correction (after question 4 is answered)
Today a saved purchase cannot be edited, cancelled or returned. Likely design (confirm first): *cancel before receipt* (flag the purchase
cancelled, remove it from the payable; blocked if payments would exceed the new payable) and *return to vendor after receipt* (negative PURCHASE
movement through `applyStockChange`, a credit against the payable). Files: `modules/purchases/*`, `prisma/schema.prisma` (+ migration), a
`purchaseDrift` update, tests in `test/purchases.e2e.spec.ts`.

### 3. Then
1. **Browser click-through in API mode** of everything listed above (use a throwaway local DB + second API on another port, as in
   `project-databases-and-safety` memory; never write experiments to Neon dev).
2. **Phase 8:** metric SQL per `docs/architecture/business-domain.md`, replacing client-side aggregation; remove the 5000-row cap in
   `reports.controller.ts`.
3. **Phase 9:** RLS, production migration rehearsal on a Neon branch, deploy, monitoring, backup drill.

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
| R4 | Vendor payable has no advance, opening balance or return handling yet | questions 1, 2, 4 |
| R5 | Tests run on PG 17, Neon is PG 18 | No version-specific SQL used so far; add a PG 18 test branch before production |
| R6 | `/reports` snapshot is capped at 5000 rows and cost-bearing | Owner/Manager only; Phase 8 replaces it |
| R7 | In-memory rate limiter is per instance | Move to a shared store before running more than one instance |
