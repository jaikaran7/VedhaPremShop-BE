# Scanner — extraction design

Code: `src/modules/consignment-scans/extraction/` (`document.extractor.ts`, `extraction.schema.ts`, `prompts.ts`) and
`consignment-scan-processing.service.ts`.

- **Two jobs in parallel**: `VENDOR_BILL` (all bill pages in one request, in page order) and `MARK_SHEET`. Each job is a
  `consignment_scan_runs` row: model, prompt version, attempts, tokens, latency, raw response, error.
- **Inputs**: images and PDFs go inline (≤ 18 MB per request); DOCX/XLSX are converted to text on the server
  (`officeText`: paragraphs / tab-separated rows) and sent as text.
- **Structured output**: `responseMimeType: application/json` + `responseJsonSchema`, `temperature: 0`. Every value is
  `{ value, raw, confidence: HIGH|MEDIUM|LOW }`; rows carry `page` and `row`. No `maxItems` in the model schema (Gemini
  returns 400 with it); limits are enforced by the validator.
- **Validation**: `parseVendorBill` / `parseMarkSheet` treat the answer as untrusted input (types, ranges, enums, lengths).
- **Retries**: up to `AI_MAX_RETRIES` more attempts on invalid JSON, schema failures, timeouts, 408/429/5xx; the last
  attempt uses `GEMINI_ESCALATION_MODEL` when one is set (off by default). 400/401/403 fail at once. Backoff 0.5 s × attempt.
- **Backup — Groq Qwen vision** (`callGroq`, `qwen/qwen3.8-27b`): after the Gemini attempts fail for any reason (no key,
  401/400 refusals skip straight to it; quota/outage after the retries; invalid answers), the same prompt and pages go to
  Groq's OpenAI-compatible chat completions with strict `json_schema` output (`additionalProperties: false` added for Groq
  only), `max_completion_tokens` 16 384, same retry count, same validator. Used only when the pages fit Groq: JPG/PNG/WEBP,
  at most 3 photos (PDF/HEIC or more pages → the run error says why the backup was not used). The run's `model` is stored as
  `groq:<model>`. A "Request too large" (account token limit) is not retried.
- **What the model must not do**: calculate, total, reconcile or correct (prompt rule 1). It never sees the mark sheet and
  the bill together, so it cannot "make them agree".
- **Storage of results**: typed rows (paise, grams, integer bags) with the raw text per field; a row whose value is missing
  or whose bags are not whole is LOW confidence. Re-reading replaces AI rows of that kind (the previous state is kept in
  `consignment_scan_versions`).
- **Prefill** (only when unambiguous): vendor whose name matches exactly (letters only, "M/s" dropped), the organization's
  only active product, the vendor's known rate convention, lot number `DDMMYYYY <code>` from the sheet's lot reference.
- **Prompt injection**: document text can only populate a draft that a person reviews and the server reconciles; the
  output is schema-validated; file names are stripped of quotes/newlines before being put in the prompt.
