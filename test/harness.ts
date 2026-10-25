import { execFileSync } from 'node:child_process';
import type { INestApplication } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { createApp } from '../src/app';
import { loadEnv, type Env } from '../src/config/env';
import { PrismaClient } from '../src/generated/prisma/client';
import { seedDevData } from '../src/database/seed';

export const PASSWORD = 'test-pass-123';
const URL = process.env.DATABASE_URL_TEST ?? 'postgres://postgres@localhost:5432/vedhaprem_test';
if (!/test/.test(URL)) throw new Error('DATABASE_URL_TEST must point at a disposable *test* database');

export interface Harness {
  app: INestApplication;
  db: PrismaClient;
  http: () => ReturnType<typeof request>;
  reset: () => Promise<void>;
  token: (username: 'owner' | 'manager' | 'salesperson') => Promise<string>;
  close: () => Promise<void>;
}

let migrated = false;

export async function startHarness(overrides: Partial<Env> = {}): Promise<Harness> {
  if (!migrated) {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DIRECT_DATABASE_URL: URL, DATABASE_URL: URL }, stdio: 'pipe' });
    migrated = true;
  }
  const env = { ...loadEnv({ NODE_ENV: 'test', DATABASE_URL: URL, JWT_ACCESS_SECRET: 'e2e-secret-'.repeat(4), CORS_ORIGINS: 'http://localhost:3000' }), ...overrides };
  const app = await createApp(env, { logger: false });
  await app.init();
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: URL, max: 4 }) });
  const tokens = new Map<string, string>();
  return {
    app,
    db,
    http: () => request(app.getHttpServer()),
    reset: async () => {
      tokens.clear();
      const tables = await db.$queryRaw<{ name: string }[]>`
        SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
      const quoted = tables.map((t) => `"${t.name}"`).join(', ');
      await db.$executeRawUnsafe(`TRUNCATE ${quoted} CASCADE`);
      await seedDevData(db, PASSWORD);
    },
    token: async (username) => {
      const cached = tokens.get(username);
      if (cached) return cached;
      const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ username, password: PASSWORD }).expect(200);
      tokens.set(username, res.body.accessToken);
      return res.body.accessToken as string;
    },
    close: async () => {
      await app.close();
      await db.$disconnect();
    },
  };
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
