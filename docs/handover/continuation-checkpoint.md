# Continuation Checkpoint

Read this first. It links to the other handover documents instead of repeating them:
[project-history](project-history.md) · [business-rules-and-decisions](business-rules-and-decisions.md) ·
[implementation-status](implementation-status.md) · [requirements-reconciliation](requirements-reconciliation.md).

## Latest: AI consignment scanner (2026-10-31)

- **Built and verified:** Purchases → Scan Consignment. Upload bill pages + mark sheet → two parallel Gemini runs →
  deterministic reconciliation → review/correct → Owner confirm (one transaction through `PurchasesService.createInTx` /
  `receiveInTx`, idempotent). Start at [ai-consignment-scanner](../architecture/ai-consignment-scanner.md).
- Backend **223** tests (12 reconciliation + 7 upload-validation unit, 8 scanner e2e with Gemini mocked), lint/typecheck/build clean.
- **Real Gemini measured** (`npm run scanner:eval`, key in `.env`): `gemini-3.5-flash-lite` 100% on the 53-line bill, 98.6% on
  the mark sheet (EG→EB). `gemini-3.8-flash` / `gemini-4-argon` have 0 free-tier quota on this key → defaults are flash-lite.
- Browser click-through done on a **local throwaway DB** (`vedhaprem_ui_test`, launch config `api-local-ui-test`): upload,
  failed read without key, review, accept suggestions, save, confirm → purchase with 513 bags; and a real-Gemini read.
- **Neon dev migrated** (`20261031000000_consignment_scanner`); no scans or purchases were written to dev. Production untouched.
- **Follow-up (same day):** phone camera **Scan** + bulk **Upload** + drag-and-drop on each document box (browser-verified:
  4 dropped files → 3 added, 1 refused, rest continued; phone width fixed). **Groq Qwen backup** (`qwen/qwen3.8-27b`) after
  Gemini fails — tested with Groq mocked (10 scanner e2e). Live: this Groq key's tier allows 1,000 output tokens/min, below
  one bill (~12k), so the backup cannot read real documents until the Groq plan is upgraded.
- **Performance (same day):** ~30 s per scan (bill and sheet in parallel; all pages of a document in one AI request);
  bill 100%, sheet 98.2% — see [scanner-evaluation](../architecture/scanner-evaluation.md). Escalation now off by default
  and AI timeout 45 s, after 90 s hangs on a model the key cannot use.
- **Not committed.** Owner questions 8–10 (paise rounding, landed-cost defaults, EG/EB) in [questions-for-owner](questions-for-owner.md).
- Found, not fixed (pre-existing): CORS `allowedHeaders` lacks `Authorization`, so a browser that keeps a Bearer token
  cross-origin (FE :3000 → API :4000) is blocked after login.

## Where things stood (2026-10-26, end of session 5)

- **Done and verified:** everything in earlier sessions plus the owner's session-5 decisions: vendor opening balance / previous due / new due /
  advance / account statement; vendor bill corrections with previous→current history (staff can correct); optional charges; any-date vendor
  bills; optional GST on sale bills; cash book with owner-set openings and day-to-day carry-forward; staff expenses incl. past dates; the lot
  breakdown report computed on the server; stock movement filters; per-organization cache; query-count (no N+1) tests.
  Backend 148 tests, frontend 54, lint/typecheck/build clean, Neon **dev** migrated (5 migrations).
- **Coding standards (session 6):** `VedhaPremShop-BE/CLAUDE.md` holds the owner's mandatory backend standards (SOLID, Sonar rules, validation,
  logging, Swagger, N+1) plus how this project already does each. `npm run lint` now includes `eslint-plugin-sonarjs` and is clean; the verbatim
  frontend port in `src/modules/reports/calc/**` and the supertest-based tests have documented lint overrides in `eslint.config.mjs`. Added:
  `@IsIsoDate()` (real calendar dates), `RequestLogInterceptor` (INFO per write), 4xx WARN logs, `@ApiEndpoint`/`@ApiStandardErrors` on every
  endpoint (a test fails if one is undocumented). Backend now **165** tests. Finish every task with `npm run typecheck && npm run lint && npm test && npm run build`.
- **Committed locally, not pushed.** Run `git log` in both repos; commit anything new first.
- **Never touched:** production (`ep-round-bar`).
- **Not clicked through against the real API in a browser:** only mock mode was driven in a browser (vendor payment/advance/statement, bill
  correction + history, cash book, salesperson view). The real-API path is covered by e2e tests and a contract script using the screens' own
  payloads and the frontend's own util code.

## START HERE NEXT SESSION

### 0. Housekeeping
1. Restart the API on :4000 (not started by the agent; it runs an older build): `cd VedhaPremShop-BE && npm run build && npm start`.
2. Check `git status` in both repos.

### 1. Owner confirmations ([questions-for-owner](questions-for-owner.md), Part 2)
Past-dated sales bills are decided: no approval (session 6). Remaining: the dashboard "Average Floor Rate" is hard-coded text in
`OwnerDashboard.tsx`; the owner must pick simple / stock-weighted / sales-weighted before it is made real.

### 2. Next implementation candidates (after the owner answers)
1. Make "Average Floor Rate" real (small).
2. "Cancel" for an unreceived vendor bill and "Return to vendor" after receipt (question 6) — negative PURCHASE movement + credit against the payable.
3. Move the remaining browser-side reports (outstanding, total sales, stock report, customer statement, opening balances) to the server the same
   way the lot breakdown was moved (port the pure functions, add a cached endpoint, point the screen at it).
4. Browser click-through in **API mode** (throwaway local DB + second API; never write experiments to Neon dev).
5. Phase 9: RLS, production migration rehearsal on a Neon branch, deploy, monitoring.

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
