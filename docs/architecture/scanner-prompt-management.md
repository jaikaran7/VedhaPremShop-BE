# Scanner — prompt management

- Prompts live in code: `src/modules/consignment-scans/extraction/prompts.ts` — `SHARED_RULES` + `VENDOR_BILL` +
  `MARK_SHEET`, plus `pageGuide()` (the per-request "user template" naming pages in order).
- `PROMPT_VERSION` (currently `scan-2026-10-31.1`) is stored on every run. **Any wording change bumps it.**
- Before shipping a change: `npm run scanner:eval` (real calls; needs `GEMINI_API_KEY`) and compare field accuracy with
  [evaluation](scanner-evaluation.md). Record the new numbers there.
- The JSON schema is part of the contract: change `extraction.schema.ts` (schema + validator) together and keep the
  model schema free of keywords Gemini rejects (`maxItems`).
- No per-vendor prompt text yet; vendor-specific behaviour (rate convention) is data, not prompt.
