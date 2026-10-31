# Scanner — reconciliation engine

Code: `src/modules/consignment-scans/reconciliation.calc.ts` (pure, integer paise/grams) with
`reconciliation.calc.spec.ts` built on the reference consignment.

## Matching order (a line, once assigned, is not reconsidered)
1. **Manual** — a person's `assignedMarkId` always wins.
2. **Exact** — single-rate mark ↔ one line with the same bags and rate. Several marks with the same (bags, rate) are paired
   in order and flagged `AMBIGUOUS_MATCH` (reference: HB/EG, 5 bags @ 300).
3. **Grouped** — several lines at the mark's rate whose bags add up exactly (subset sum, earlier lines preferred).
4. **Range** — lines whose rate lies inside a written range (e.g. 460–470); a line inside two open ranges is left to a
   person. If in-range lines exceed the mark, a subset that fits is taken and flagged; otherwise `RANGE_OVERFLOW`.
   **Rates are never averaged.**
5. **Suggestions** — each unmatched line gets the nearest mark still short of bags (distance 0 inside its range). Never
   applied automatically; the UI offers "Assign N unmatched to the suggested marks".

## Checks (CRITICAL blocks confirm)
| Code | Severity |
|---|---|
| `MISSING_FIELD` (vendor, product, lot, bill no., bill date), `NO_BILL_LINES`, `NO_MARKS` | CRITICAL |
| `RATE_UNIT_UNKNOWN` (with evidence), `RATE_UNIT_PER_BAG_UNSUPPORTED`, `RATE_PRECISION` | CRITICAL |
| `LINE_AMOUNT_MISMATCH` — printed amount ≠ weight × rate under the chosen convention | CRITICAL |
| `BILL_BAGS/WEIGHT/GROSS/EXPENSES/NET_MISMATCH`, `SHEET_BAGS_MISMATCH`, `BILL_SHEET_BAGS_MISMATCH` | CRITICAL (`*_NOT_READ` WARNING) |
| `LINE_UNMATCHED`, `MARK_SHORT`, `MARK_OVER`, `RANGE_OVERFLOW` | CRITICAL |
| `DUPLICATE_MARK`, `MARK_CODE_MISSING`, `MARK_CODE_TOO_LONG`, `MARK_CODE_CLASH`, `TOO_MANY_PURCHASE_LINES` | CRITICAL |
| `AMBIGUOUS_MATCH`, `LOW_CONFIDENCE`, `DATE_MISMATCH`, `ROUNDING_DIFFERENCE` | WARNING |
| `DRIVER_ADVANCE` | INFO |

## Rate convention
`expectedAmountPaise`: per kg = grams × rate / 1000; per 10 kg = grams × rate / 10 000; per bag = bags × rate (half-up to
the paisa). `rateUnitEvidence` counts lines each convention explains and suggests one only at ≥ 80% (reference: per 10 kg,
53/53).

## Outputs
Line matches (method, suggestion), per-mark summary (matched bags, grams, amount, rates, status), totals, purchase lines
(one per mark, or per printed rate for a multi-rate mark: `OK460`), rounding difference, issues, `canConfirm`.
The server re-runs it inside the confirm transaction; the stored copy is only for display and reporting.
