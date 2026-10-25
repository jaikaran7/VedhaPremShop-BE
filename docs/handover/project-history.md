# Project History — Vedhaprem Mandi ERP

Last updated 2026-10-25 (session 3, the recovery session). Each fact is tagged:
**[code]** seen in the repository this session · **[run]** a command was executed this session and its result observed ·
**[claimed]** stated in a previous AI session, not independently re-proven · **[open]** unresolved.

## Repositories

| Repo | Path | Branch | Remote | State |
|---|---|---|---|---|
| Frontend | `VedhaPremShop-FE` | `badri-fe` | `github.com/jaikaran7/vedhapremshop` | Last commit `9b27bf1`; **22 modified files + 2 more this session, none committed** [run: `git status`] |
| Backend | `VedhaPremShop-BE` | `badri-be` | `github.com/Badrinath-04/VedhaPremShop-BE` | One empty commit (`1fb5cf0 Initialize badri-be branch`); **the entire backend is untracked** [run] |

Consequence: nothing built in sessions 1–3 exists outside this machine's working tree. Committing is the first protective step; it was
not done because no commit was authorised.

## Chronology

### Session 1 — audit, design, Phases 0–6 (Drizzle, local Postgres 17)
- Audited the frontend (Next.js App Router, React 18, TanStack Query, mock repository) and wrote the ten `docs/` documents. **[code]** docs exist.
- Built NestJS 11 backend on **Drizzle**, local Postgres 17 (Homebrew). Auth, users, settings masters, customers, vendors, lots/stock ledger,
  sales, payments. **[claimed]** 43 tests passing; frontend wired to the API and a bill posted through the browser.
- Decisions taken by the AI, later reviewed by the user: money in integer paise, weights in grams, append-only ledgers via DB triggers,
  cookies + short-lived JWT with refresh rotation, one organization per business.

### Session 2 — Prisma, Neon, business decisions (user's second prompt)
User instructions: use **Prisma** (stable 7.x), use the **Neon** database (**Postgres 18**; uncommented `DATABASE_URL` = dev `ep-odd-flower`,
commented one = production `ep-round-bar`), and answers to the open business questions (see `business-rules-and-decisions.md`).
- Replaced Drizzle with Prisma **7.10.1**. **[code]** `package.json`, `prisma/schema.prisma`, no `drizzle` anywhere in `src/`.
- Added approvals (backdated bills, cancel, rebill), advances/refunds, rebill links, party→organization link. **[code]**
- Applied two migrations to the Neon **dev** branch and seeded it. **[run this session]** `migrate status`: up to date; DB is PostgreSQL 18.6.
- Frontend: bill date picker + approval notice, Owner-only approvals screen (staff read-only), Cancel/Edit-bill actions, red credit warning,
  advance note on New Sale. **[code]** present in `NewSaleWorkflow.tsx`, `SaleDetails.tsx`, `ApprovalsHub.tsx`; **[claimed]** worked in a browser.
- **Where it stopped:** the last transcript line is the frontend Sale Details actions + approvals screen. Both exist in source and
  type-check. Not evidenced: a browser run of those screens, and any commit.

### Session 3 — recovery + Phase 7 (this session)
- Re-verified the tree: backend typecheck/lint/49 tests and frontend typecheck/44 tests all passed on arrival. **[run]**
- Found the frontend calls endpoints the backend lacked: `/purchases*`, `/reports`, `/settings/costing*`, `/expenses`, `/expense-categories`,
  `/cash-accounts`. **[code]**
- Implemented **Phase 7**: costing masters, purchases, receiving, vendor payables; plus the `/reports` snapshot (see `implementation-status.md`).
- Migration `20261025120000_purchases` applied to Neon **dev**; dev seed backfilled with the nine legacy purchases and ten expense types
  (one-off script, deleted afterwards). **[run]**
- Added "Advance" lines to the Customers list/details (the user asked for advances to show as a positive number; only New Sale did).

### Session 4 — commit, expenses, vendor payments
- Owner approved committing; both repos committed locally (not pushed).
- The frontend's "Vendor Payments" tab turned out to be a filter on expenses in the category "Purchase Payments" with no vendor attached.
  Built `/expenses`, `/expense-categories`, `/cash-accounts`, and attached a vendor to those payments so the payable falls when a vendor is paid
  (provisional rule D11). Added a vendor picker to the Record Expense screen.
- Added a whole-cycle tally test (buy, receive, sell part-credit, collect, pay vendor) with hand-computed figures; wrote
  `questions-for-owner.md`. Backend 80/80 tests. Neon dev migrated (`20261025140000_expenses`) and backfilled with 3 accounts + 7 categories.

### Session 5 — owner's answers implemented
The owner answered the plain-language questions. Built: vendor opening balance and advance, previous/new due and account statement; vendor bill
corrections with history and staff access; optional charges; optional GST; cash book and opening balances; staff expenses; the lot breakdown
report on the server (ported verbatim, the frontend's own tests run unchanged); stock movement filters; per-organization cache; frontend
`staleTime` 30 s and targeted invalidation; query-count tests against N+1. Found that the dashboard's "Average Floor Rate" is hard-coded text.
Caught during verification: the screen echoes `receiptStatus: 'RECEIVED'` on a correction, which the server wrongly refused (fixed and tested).

### Session 6 — past-dated sales need no approval
The owner confirmed: staff can back-date sales bills with no approval; the Owner's approval stays for cancel and edit requests. `create` always
posts a bill at once; the Approvals screen text and the New Sale notice were updated; the backdate tests were rewritten.

## Bugs found and fixed along the way (session 1–2, from the transcript) [claimed]
Unqualified Drizzle SQL fragments broke a correlated subquery; Drizzle-wrapped Postgres errors hid unique-violation handling; test harness
ordering (supertest) and parallel e2e files against one DB. All moot after the Prisma switch except the lessons: run e2e with `--runInBand`,
unwrap driver errors in one place (`common/pg-error.ts`).

## Failed or reverted attempts
- Homebrew would not link Postgres 17 over the existing libpq; fixed with two manual links under `/opt/homebrew`. **[claimed]** The machine
  now has a local Postgres 17 (data in `~/.local/share/vedhaprem-pg`) used only for tests.

## Unresolved uncertainties
- An "Uncaught SyntaxError" in the browser console, never traced. **[open]**
- Whether session-2 frontend screens behave correctly in a browser. **[open]** (typecheck only)
- Vendor payments (see business rules Q10). **[open]**
