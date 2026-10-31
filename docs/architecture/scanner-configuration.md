# Scanner — configuration

| Variable | Default | Notes |
|---|---|---|
| `GEMINI_API_KEY` | (empty) | Server side only. Empty: uploads, review and manual entry work; "Read documents" fails with a clear message recorded on the run |
| `GEMINI_PRINTED_BILL_MODEL` | `gemini-3.5-flash-lite` | Vendor bill |
| `GEMINI_HANDWRITING_MODEL` | `gemini-3.5-flash-lite` | Mark sheet |
| `GEMINI_ESCALATION_MODEL` | (empty: off) | Optional stronger model for the last Gemini retry. Set it only to a model the key can call — an unusable one hangs until the timeout (measured: 90 s) |
| `AI_MAX_RETRIES` | `2` | 0–5 extra attempts |
| `AI_REQUEST_TIMEOUT_MS` | `45000` | 5 000–300 000 per model call (Gemini and Groq) |
| `GROQ_API_KEY` | (empty) | Backup reader. Empty: no backup |
| `GROQ_VISION_MODEL` | `qwen/qwen3.8-27b` | Groq's Qwen vision model (JSON-schema output, ≤ 3 images per request). Needs a Groq tier whose output-token-per-minute limit is above ~16k (one bill is ~12k output tokens) |

Limits in code: 10 MB per file, 12 files per scan (`file-validation.ts`), 18 MB inline per model request, 300 rows per
document, 50 purchase lines per bill. Signed file links live 10 minutes (`scan-file-links.ts`).

Upload limits per scan stay 12 files; the Groq backup only reads documents of at most 3 photos.

Vercel: set the API function's max duration to at least 120 s (two pages took ~30 s on flash-lite); bodies above ~4.5 MB
are refused by the platform, so the UI uploads one file per request.
