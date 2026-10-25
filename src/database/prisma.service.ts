import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { ENV, type Env } from '../config/env';
import { Prisma, PrismaClient } from '../generated/prisma/client';

export type Tx = Prisma.TransactionClient;
export type Db = PrismaClient | Tx;

/** Interactive transactions do several round trips to Neon; give them room but stay bounded. */
export const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

/**
 * One pg pool per process through the Prisma driver adapter. On Neon use the pooled (-pooler) URL here;
 * migrations use the direct URL (prisma.config.ts).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnApplicationShutdown {
  /** Queries issued so far. Only counted under NODE_ENV=test, so a test can prove a request's query count does not grow with the data. */
  queryCount = 0;

  constructor(@Inject(ENV) env: Env) {
    const adapter = new PrismaPg({ connectionString: env.databaseUrl, max: env.dbPoolMax, idleTimeoutMillis: 30_000 });
    super(env.nodeEnv === 'test' ? { adapter, log: [{ emit: 'event', level: 'query' }] } : { adapter });
    if (env.nodeEnv === 'test') (this as unknown as { $on(event: 'query', handler: () => void): void }).$on('query', () => { this.queryCount += 1; });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class DbModule {}
