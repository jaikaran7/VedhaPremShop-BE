import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI config (migrate, generate). Prisma 7 does not read .env itself; npm scripts pass --env-file.
 * Migrations run on the DIRECT (non-pooled) Neon URL: Neon's pooler is in transaction mode, which does not
 * keep the session advisory lock `prisma migrate` relies on. Falls back to DATABASE_URL for local Postgres.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL || '' },
});
