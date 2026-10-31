# Scanner — database design

Migration `20261031000000_consignment_scanner`. Every table carries `organization_id`; children cascade from the scan.
Amounts are `bigint` paise, weights `bigint` grams; JSONB only for raw AI payloads, evidence and snapshots.

| Table | Purpose | Integrity |
|---|---|---|
| `consignment_scans` | Session: status, optimistic `version`, chosen vendor/product/lot/rate unit, header values read, printed totals, last reconciliation, `purchase_id`, `confirm_key` | unique `(organization_id, confirm_key)`, unique `purchase_id`; CHECK `CONFIRMED ⇔ purchase_id and confirmed_at`; **trigger `consignment_scans_frozen`**: a confirmed scan cannot be updated or deleted |
| `consignment_scan_documents` | One uploaded file: kind, page no., name, MIME (detected), size, sha256 | unique `(scan_id, sha256)` (no duplicate upload); CHECK size > 0, page ≥ 1, hex sha256 |
| `consignment_scan_files` | The bytes (`bytea`), 1:1 with a document, never loaded by lists | — |
| `consignment_scan_runs` | One AI job: model, prompt version, attempts, tokens, latency, error, raw response | — |
| `consignment_scan_bill_lines` | Bill line as read/corrected: bags, grams, printed rate (paise), amount (paise), source page/row, confidence, raw text, origin AI/MANUAL, corrected, person's mark assignment | CHECK non-negative, origin |
| `consignment_scan_expenses` | Bill charges: category, amount, include-in-cost | CHECK non-negative |
| `consignment_scan_marks` | Mark sheet rows: code, bags, rate min/max | CHECK `rate_max ≥ rate_min` |
| `consignment_scan_issues` | Current issues (replaced on every recalculation) for querying | — |
| `consignment_scan_versions` | Snapshot of the editable draft at every save / read, with who and why | unique `(scan_id, version)` |
| `vendors.bill_rate_unit` | Vendor's remembered rate convention | enum `BillRateUnit` |

A document page table was not added: a photo is one page, and a PDF's pages are numbered by the model (`source_page`).
Audit rows: `CREATE_CONSIGNMENT_SCAN`, `UPLOAD_SCAN_DOCUMENTS`, `REMOVE_SCAN_DOCUMENT`, `READ_CONSIGNMENT_DOCUMENTS`,
`EDIT_CONSIGNMENT_SCAN`, `CONFIRM_CONSIGNMENT_SCAN` (+ the purchase's own `CREATE_PURCHASE`, `RECEIVE_LOT`).
