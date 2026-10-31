# Scanner — API

Base `/api/v1/consignment-scans`. Errors use the standard `{ statusCode, error, message, requestId }`. Money in rupees,
weight in kg (as everywhere in this API). Swagger: `/api/docs` (non-production).

| Method & path | Who | Notes |
|---|---|---|
| `GET /` | staff | Newest first, `limit`/`offset` |
| `POST /` | staff | 201, empty scan |
| `GET /:id` | staff | Full view: documents (signed `url`, 10 min), runs, lines/marks/expenses with source + confidence + provenance, reconciliation |
| `GET /:id/versions` | staff | Draft history |
| `POST /:id/documents` | staff | multipart: `kind` (`VENDOR_BILL`/`MARK_SHEET`), `files[]` (≤ 12 per scan, ≤ 10 MB each). Type by magic bytes and must match the declared MIME; macro Office files, scripted PDFs and anything else → 422; same file twice → 409 |
| `DELETE /:id/documents/:documentId` | staff | Before confirm |
| `POST /:id/process` | staff | Reads both kinds in parallel; returns the scan when done. 409 if already reading or confirmed; 422 with no documents |
| `PATCH /:id` | staff | `SaveScanDraftDto`: `version` (409 if stale), header fields (null clears), full `lines`/`marks`/`expenses` lists (rows keep `id`). Recalculates |
| `POST /:id/confirm` | **Owner** | Header `Idempotency-Key` (required), body `{ version }`. 422 while CRITICAL issues exist; 409 stale version. Returns `{ purchaseId, replayed, scan }`; a repeat returns the same purchase with `replayed: true` |
| `GET /files/:documentId?exp&sig` | public, signed | Serves the bytes with `nosniff`, `sandbox` CSP; 403 when expired or tampered |

Another organization's scan is 404 everywhere.
