import { GoogleGenAI, type Part } from '@google/genai';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../../../config/env';
import { MARK_SHEET_JSON_SCHEMA, type MarkSheetOut, parseMarkSheet, parseVendorBill, VENDOR_BILL_JSON_SCHEMA, type VendorBillOut } from './extraction.schema';
import { pageGuide, PROMPT_VERSION, PROMPTS } from './prompts';

export type ExtractionJob = 'VENDOR_BILL' | 'MARK_SHEET';

export interface ExtractionPage {
  pageNo: number;
  fileName: string;
  mimeType: string;
  /** Image or PDF bytes sent inline; Office files are sent as their text instead. */
  data?: Buffer;
  text?: string;
}

export interface ModelAnswer {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ExtractionResult<T> {
  model: string;
  promptVersion: string;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  raw: unknown;
  parsed: T;
}

/** Thrown when extraction cannot produce a valid answer; `attempts` and token use are kept for the run record. */
export class ExtractionError extends Error {
  constructor(message: string, readonly model: string, readonly attempts: number, readonly raw: unknown = null) {
    super(message);
  }
}

/** Gemini allows about 20 MB of inline data per request. */
const MAX_INLINE_BYTES = 18 * 1024 * 1024;
/** Groq vision limits (console.groq.com/docs/vision, 2026-10-31): 3 images per request; no PDF; no HEIC. */
const GROQ_MAX_IMAGES = 3;
const GROQ_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MAX_OUTPUT_TOKENS = 16_384;

type Provider = 'gemini' | 'groq';
interface Step { provider: Provider; model: string }
const label = (step: Step) => (step.provider === 'groq' ? `groq:${step.model}` : step.model);
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const SPEC = {
  VENDOR_BILL: { schema: VENDOR_BILL_JSON_SCHEMA, parse: parseVendorBill },
  MARK_SHEET: { schema: MARK_SHEET_JSON_SCHEMA, parse: parseMarkSheet },
} as const;

/** Groq strict mode needs every object closed (`additionalProperties: false`); Gemini's schema stays as it is. */
function closed(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(closed);
  if (!schema || typeof schema !== 'object') return schema;
  const copy = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, closed(v)]));
  return copy.type === 'object' ? { ...copy, additionalProperties: false } : copy;
}

/** API key problems, bad requests, refused content and a request above the account's token limit will not improve on retry. */
function isRetryable(error: unknown): boolean {
  if (error instanceof Error && /Request too large/i.test(error.message)) return false;
  if (error instanceof SyntaxError || (error instanceof Error && error.name === 'ExtractionShapeError')) return true;
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return true;
  const status = (error as { status?: number })?.status;
  return status === undefined || RETRYABLE_STATUS.has(status);
}

/** Groq's OpenAI-style answer, only the fields read. */
interface GroqResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/**
 * Reads one document kind: Gemini first (structured JSON, bounded retries, the last attempt on the escalation model),
 * then Groq's Qwen vision model as a backup when Gemini cannot produce a valid answer for any reason (no key, quota,
 * outage, invalid output). Every answer passes the same strict validator. It only transcribes; reconciliation is code.
 */
@Injectable()
export class DocumentExtractor {
  private readonly logger = new Logger(DocumentExtractor.name);
  private client: GoogleGenAI | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  get configured(): boolean {
    return this.env.gemini.apiKey.length > 0;
  }

  /** Groq can take this request: a key, at most 3 images, and only JPEG/PNG/WEBP (Office files go as text). */
  private groqCan(pages: ExtractionPage[]): string | null {
    if (!this.env.groq.apiKey) return 'GROQ_API_KEY is not set';
    const images = pages.filter((p) => p.text === undefined);
    if (images.some((p) => !GROQ_IMAGE_TYPES.has(p.mimeType))) return 'the backup reads only JPG, PNG and WEBP photos';
    if (images.length > GROQ_MAX_IMAGES) return `the backup reads at most ${GROQ_MAX_IMAGES} photos at a time`;
    return null;
  }

  /** Gemini attempts (escalation last), then the Groq backup with the same number of attempts when it can take the pages. */
  private steps(job: ExtractionJob, pages: ExtractionPage[]): Step[] {
    const cfg = this.env.gemini;
    const primary = job === 'VENDOR_BILL' ? cfg.printedBillModel : cfg.handwritingModel;
    const tries = cfg.maxRetries + 1;
    const gemini = Array.from({ length: tries }, (_, i): Step => ({ provider: 'gemini', model: i > 0 && i === tries - 1 && cfg.escalationModel ? cfg.escalationModel : primary }));
    const groq = this.groqCan(pages) === null ? Array.from({ length: tries }, (): Step => ({ provider: 'groq', model: this.env.groq.visionModel })) : [];
    return [...gemini, ...groq];
  }

  extract(job: 'VENDOR_BILL', pages: ExtractionPage[]): Promise<ExtractionResult<VendorBillOut>>;
  extract(job: 'MARK_SHEET', pages: ExtractionPage[]): Promise<ExtractionResult<MarkSheetOut>>;
  async extract(job: ExtractionJob, pages: ExtractionPage[]): Promise<ExtractionResult<VendorBillOut | MarkSheetOut>> {
    const parts = this.parts(job, pages);
    const steps = this.steps(job, pages);
    const started = Date.now();
    const tokens = { input: 0, output: 0 };
    let failure: { error: unknown; raw: unknown } = { error: null, raw: null };
    let skip: Provider | null = null;
    for (const [index, step] of steps.entries()) {
      if (step.provider === skip) continue;
      try {
        const { raw, parsed } = await this.attempt(job, step, parts, tokens);
        return { model: label(step), promptVersion: PROMPT_VERSION, attempts: index + 1, inputTokens: tokens.input, outputTokens: tokens.output, latencyMs: Date.now() - started, raw, parsed };
      } catch (error) {
        failure = { error, raw: (error as { raw?: unknown }).raw ?? failure.raw };
        this.logger.warn(JSON.stringify({ event: 'ai_extraction_attempt_failed', job, model: label(step), attempt: index + 1, reason: this.describe(error).slice(0, 300) }));
        // A key, request or content problem will not improve on retry: move on to the other provider.
        if (!isRetryable(error)) skip = step.provider;
        else if (steps[index + 1]?.provider === step.provider) await new Promise((resolve) => setTimeout(resolve, 500 * (index + 1)));
      }
    }
    const backup = this.groqCan(pages);
    const note = backup ? ` (Groq backup not used: ${backup})` : '';
    throw new ExtractionError(this.describe(failure.error) + note, label(steps.at(-1) as Step), steps.length, failure.raw);
  }

  /** One call to one provider, parsed and validated; a bad answer is rethrown with its raw text for the run record. */
  private async attempt(job: ExtractionJob, step: Step, parts: Part[], tokens: { input: number; output: number }) {
    const answer = step.provider === 'groq' ? await this.callGroq(step.model, parts, SPEC[job].schema) : await this.callModel(step.model, parts, SPEC[job].schema);
    tokens.input += answer.inputTokens;
    tokens.output += answer.outputTokens;
    try {
      const raw: unknown = JSON.parse(answer.text);
      return { raw, parsed: SPEC[job].parse(raw) };
    } catch (error) {
      throw Object.assign(error as Error, { raw: answer.text });
    }
  }

  /** One Gemini call. Replaced by a fake in tests; the only place that talks to Gemini. */
  async callModel(model: string, parts: Part[], schema: unknown): Promise<ModelAnswer> {
    if (!this.configured) throw Object.assign(new Error('AI extraction is not configured on the server (GEMINI_API_KEY is not set).'), { status: 401 });
    this.client ??= new GoogleGenAI({ apiKey: this.env.gemini.apiKey });
    const response = await this.client.models.generateContent({
      model,
      contents: [{ role: 'user', parts }],
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: schema,
        temperature: 0,
        abortSignal: AbortSignal.timeout(this.env.gemini.timeoutMs),
        httpOptions: { timeout: this.env.gemini.timeoutMs },
      },
    });
    const text = response.text;
    if (!text) throw Object.assign(new Error(`The model returned no answer (${response.candidates?.[0]?.finishReason ?? 'no candidate'}).`), { status: 422 });
    return { text, inputTokens: response.usageMetadata?.promptTokenCount ?? 0, outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0 };
  }

  /** One Groq call (OpenAI-compatible chat completions, JSON schema output). Replaced by a fake in tests. */
  async callGroq(model: string, parts: Part[], schema: unknown): Promise<ModelAnswer> {
    const messageContent = parts.map((p) => (p.inlineData
      ? { type: 'image_url', image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` } }
      : { type: 'text', text: p.text ?? '' }));
    const response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.env.groq.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, temperature: 0, messages: [{ role: 'user', content: messageContent }],
        // A 53-line bill with raw text and confidence per value is ~12k output tokens; Groq's default (2048) truncates it.
        max_completion_tokens: GROQ_MAX_OUTPUT_TOKENS,
        response_format: { type: 'json_schema', json_schema: { name: 'extraction', schema: closed(schema), strict: true } },
      }),
      signal: AbortSignal.timeout(this.env.gemini.timeoutMs),
    });
    const body = (await response.json().catch(() => ({}))) as GroqResponse;
    if (!response.ok) throw Object.assign(new Error(`Groq ${response.status}: ${body.error?.message ?? response.statusText}`), { status: response.status });
    // Some Qwen builds prefix their reasoning; only the JSON after it is the answer.
    const content = body.choices?.[0]?.message?.content ?? '';
    const thinkEnd = content.lastIndexOf('</think>');
    const text = (thinkEnd < 0 ? content : content.slice(thinkEnd + '</think>'.length)).trim();
    if (!text) throw Object.assign(new Error(`The backup model returned no answer (${body.choices?.[0]?.finish_reason ?? 'no choice'}).`), { status: 422 });
    return { text, inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 };
  }

  private parts(job: ExtractionJob, pages: ExtractionPage[]): Part[] {
    const inline = pages.reduce((t, p) => t + (p.data?.length ?? 0), 0);
    if (inline > MAX_INLINE_BYTES) throw new ExtractionError('The pages are too large to read in one request. Upload smaller photos.', '', 0);
    return [
      { text: PROMPTS[job] },
      { text: pageGuide(pages) },
      ...pages.flatMap((p): Part[] => [
        { text: `--- page ${p.pageNo} ---` },
        p.text === undefined ? { inlineData: { mimeType: p.mimeType, data: (p.data ?? Buffer.alloc(0)).toString('base64') } } : { text: p.text.slice(0, 200_000) },
      ]),
    ];
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message.slice(0, 500) : 'AI extraction failed';
  }
}
