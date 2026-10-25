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
  constructor(@Inject(ENV) env: Env) {
    super({ adapter: new PrismaPg({ connectionString: env.databaseUrl, max: env.dbPoolMax, idleTimeoutMillis: 30_000 }) });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class DbModule {}
