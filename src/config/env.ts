export interface Env {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  dbPoolMax: number;
  jwtAccessSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  corsOrigins: string[];
  cookieCrossSite: boolean;
  /** AI consignment scanner. An empty apiKey disables extraction (uploads and manual entry still work). */
  gemini: {
    apiKey: string;
    printedBillModel: string;
    handwritingModel: string;
    escalationModel: string;
    maxRetries: number;
    timeoutMs: number;
  };
  /** Backup reader when Gemini fails: Groq's vision model. Empty apiKey disables the backup. */
  groq: {
    apiKey: string;
    visionModel: string;
  };
}

export const ENV = Symbol('ENV');

function int(source: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = source[key];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer in [${min}, ${max}]`);
  return value;
}

/** Fails fast at boot so a misconfigured deploy never serves traffic. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const nodeEnv = (source.NODE_ENV ?? 'development') as Env['nodeEnv'];
  if (!['development', 'test', 'production'].includes(nodeEnv)) throw new Error('NODE_ENV must be development, test or production');
  const databaseUrl = source.DATABASE_URL ?? '';
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error('DATABASE_URL must be a postgres:// URL');
  const jwtAccessSecret = source.JWT_ACCESS_SECRET ?? '';
  if (jwtAccessSecret.length < 32) throw new Error('JWT_ACCESS_SECRET must be at least 32 characters');
  const corsOrigins = (source.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  if (nodeEnv === 'production' && corsOrigins.length === 0) throw new Error('CORS_ORIGINS is required in production');
  return {
    nodeEnv,
    port: int(source, 'PORT', 4000, 1, 65535),
    databaseUrl,
    dbPoolMax: int(source, 'DB_POOL_MAX', 10, 1, 100),
    jwtAccessSecret,
    accessTokenTtlSeconds: int(source, 'ACCESS_TOKEN_TTL_SECONDS', 900, 60, 3600),
    refreshTokenTtlDays: int(source, 'REFRESH_TOKEN_TTL_DAYS', 30, 1, 90),
    corsOrigins,
    cookieCrossSite: source.COOKIE_CROSS_SITE === 'true',
    gemini: {
      apiKey: source.GEMINI_API_KEY?.trim() ?? '',
      // Stable models (ai.google.dev/gemini-api/docs/models, 2026-10-31). flash-lite measured 100% on the reference bill and
      // 98.6% on the mark sheet and works on a free-tier key; 3.8-flash needs a billed key. See docs/architecture/scanner-evaluation.md.
      printedBillModel: source.GEMINI_PRINTED_BILL_MODEL?.trim() || 'gemini-3.5-flash-lite',
      handwritingModel: source.GEMINI_HANDWRITING_MODEL?.trim() || 'gemini-3.5-flash-lite',
      // Off by default: an escalation model the key cannot use does not refuse, it hangs until the timeout (measured 90 s).
      escalationModel: source.GEMINI_ESCALATION_MODEL?.trim() ?? '',
      maxRetries: int(source, 'AI_MAX_RETRIES', 2, 0, 5),
      // A clean 2-page bill read takes 28–31 s; 45 s leaves room and lets a stuck call fall through to the next attempt.
      timeoutMs: int(source, 'AI_REQUEST_TIMEOUT_MS', 45_000, 5_000, 300_000),
    },
    groq: {
      apiKey: source.GROQ_API_KEY?.trim() ?? '',
      // console.groq.com/docs/vision (2026-10-31): Groq's Qwen vision model, JSON-schema output, ≤ 3 images per request.
      visionModel: source.GROQ_VISION_MODEL?.trim() || 'qwen/qwen3.8-27b',
    },
  };
}
