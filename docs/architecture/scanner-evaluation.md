# Scanner — evaluation

`npm run scanner:eval` (or `GEMINI_API_KEY= npm run scanner:eval` to measure the Groq backup alone) reads the reference photos in `test/fixtures/consignment/` (git-ignored, kept on the developer machine — they show bank details) with the configured models and compares every field with
the human transcription in `test/fixtures/consignment/reference.ts`. It makes real (billable) calls.

## Results (2026-10-31, prompt `scan-2026-10-31.1`)

| Model | Document | Field accuracy | Time | Tokens (in+out) |
|---|---|---|---|---|
| `gemini-3.5-flash-lite` | Vendor bill, 2 pages, 53 lines (bags, kg, rate, amount) | **212/212 (100%)** | 26–34 s | 2,855 + 11,959 |
| `gemini-3.5-flash-lite` | Bill charges (5) and header/totals (7) | **5/5, 7/7** | — | — |
| `gemini-3.5-flash-lite` | Handwritten mark sheet, 18 rows (bags, rate min, rate max, mark) | **71/72 (98.6%)** — row 17 mark "EG" read as "EB" with HIGH confidence | 8–15 s | 1,735 + ~3,300 |
| `groq:qwen/qwen3.8-27b` (backup) | — | **not measured**: this Groq account (on_demand tier) allows 1,000 output tokens per minute for the model; one bill needs ~12,000 and the sheet ~3,300, so Groq refuses the request ("Request too large"). The fallback path itself is tested with Groq mocked | — | — |
| `gemini-3.8-flash`, `gemini-4-argon` | — | **not measured**: this project's key returned 503 (overloaded) then 429 with a free-tier quota of 0 for these models | — | — |

Two runs of flash-lite gave the same field results. One reference consignment is a small sample; measure again on more
consignments before trusting these numbers broadly.

## Performance test (2026-10-31 11:00, prompt `scan-2026-10-31.1`, free-tier keys)

How a scan is processed: the two document kinds run **in parallel** (`Promise.all`: vendor bill ‖ mark sheet); inside a
kind, all its pages go to the model **in one request** (the 2 bill pages are one call), not one call per image. Retries
and the Groq backup are serial within a job. Uploads are one file per request, in order. Reconciliation runs once both
jobs finish, in one database transaction.

### Model level — `SCANNER_EVAL_RUNS=5 npm run scanner:eval` (5 runs, 15 s apart)

| Run | Wall (parallel) | Vendor bill | Mark sheet | Serial would be | Bill read by |
|---|---|---|---|---|---|
| 1 | 114.0 s | 114.0 s | 15.9 s | 129.8 s | Groq Qwen after Gemini 503 ×2 + escalation timeout |
| 2 | 30.8 s | 30.8 s | 14.4 s | 45.2 s | gemini-3.5-flash-lite, 1st attempt |
| 3 | 33.3 s | 33.3 s | 12.8 s | 46.1 s | flash-lite, 2nd attempt (one 503) |
| 4 | 28.7 s | 28.7 s | 12.9 s | 41.7 s | flash-lite, 1st attempt |
| 5 | 36.3 s | 36.3 s | 18.0 s | 54.3 s | flash-lite, 2nd attempt (one 503) |

Tokens per scan ≈ 19,850 (bill ≈ 2,860 in + ≈ 12,000 out; sheet ≈ 1,740 in + ≈ 3,300 out).

### End to end through the API — local test DB, real Gemini (`api-local-ui-test`), 3 runs

| Step | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Create scan | 7 ms | 6 ms | 4 ms |
| Upload 3 photos (3 requests) | 22 ms | 25 ms | 25 ms |
| Read documents (AI + store + reconcile) | 28.8 s | 28.5 s | 102.6 s — bill failed (Gemini 503s, escalation timed out at 90 s; this local config had no Groq key) |
| Open review (GET) | 4 ms | 5 ms | 5 ms |
| Save corrections + recalculate | 34 ms | 29 ms | 14 ms |
| Owner confirm (purchase, 30 lines, receipt, stock) | blocked — sheet misread, see below | **59 ms** | — |

Database work per step is milliseconds locally; on Neon (network round trips) expect it to be slower, not measured here.

### Latency summary (successful Gemini reads, 8 reads of each document)

| | min | median | max | Notes |
|---|---|---|---|---|
| Vendor bill (2 pages, 53 lines) | 28.5 s | 30 s | 36.3 s | clean reads 28.5–30.8 s; +3–6 s when one 503 is retried |
| Mark sheet (1 page, 18 rows) | 11.9 s | 13.6 s | 18.0 s | |
| Whole scan (parallel) | 28.5 s | 30 s | 36.3 s | = the bill; parallel saves 13–18 s versus serial |
| Worst case seen | 102–114 s | | | 503s → escalation to `gemini-3.8-flash`, which this key cannot use and which only fails at the 90 s timeout |

### Accuracy on the reference photos

| Reader | Document | Field accuracy | Notes |
|---|---|---|---|
| gemini-3.5-flash-lite | Vendor bill lines (6 reads × 212 fields) | **1272/1272 (100%)** | every bags/kg/rate/amount exact |
| gemini-3.5-flash-lite | Bill charges, header and printed totals (4 reads) | **20/20, 28/28 (100%)** | |
| gemini-3.5-flash-lite | Mark sheet (7 reads × 72 fields) | **495/504 (98.2%)**; rows 118/126 (93.7%) | row 17 "EG" read EB (6×) / EQ (1×) every time; once mark 18's rate read 440 instead of 445 (HIGH confidence) — reconciliation blocked confirm |
| groq:qwen/qwen3.8-27b (backup) | Vendor bill lines (1 read) | **23/212 (10.8%)** | columns swapped and rows shifted by one from row 4; charges 0/5; header/totals 7/7. The per-line amount check and totals would block such a read |

Conclusions: the printed bill is reliable; the handwritten sheet needs a person to check flagged rows (all misreads seen
were caught by reconciliation or are visible in the mark column). Qwen on Groq is a last-resort reader, not an equal
substitute. The latency outliers came from the escalation model this key cannot use. **Fixed 2026-10-31:** escalation is
off by default and the per-call timeout is 45 s (was 90 s), so a stuck call falls through to the next attempt or the Groq
backup in at most 45 s.

Re-run after the fix (3 runs, no Gemini errors that time): whole scan 21.9 / 22.8 / 26.0 s (bill), sheet 7.1–10.5 s; bill
636/636, charges 15/15, header 21/21, sheet 213/216 (98.6%, the same EG row).

## What the tests prove without the network
- `reconciliation.calc.spec.ts` — every rule on the reference data (exact/grouped/range matching, HB/EG ambiguity, the 25
  out-of-range bags, suggestions, rate evidence, rounding difference).
- `test/consignment-scans.e2e.spec.ts` — upload checks, signed links, both runs, corrections, stale version, blocked and
  owner-only confirm, idempotent re-confirm, frozen confirmed scan, AI failure with retries + escalation, organization
  isolation, Groq backup after Gemini quota errors and after a refused Gemini request, backup skipped for > 3 photos —
  with the Gemini and Groq calls replaced by the reference transcription.
