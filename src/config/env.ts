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
  };
}
