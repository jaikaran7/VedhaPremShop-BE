import { CallHandler, ExecutionContext, Global, Injectable, Module, NestInterceptor } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { type Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import type { AuthedRequest } from './auth/actor';

interface Entry {
  expires: number;
  value: Promise<unknown>;
}

/**
 * In-process cache for reads that are expensive and change rarely, kept per organization.
 * Concurrent misses share one load (single flight). Any successful or failed write request clears the whole
 * organization (CacheInvalidationInterceptor), so a user sees their own change at once.
 * shortcut: not shared between API instances (no Redis by decision): another instance serves data at most `ttlMs`
 * old. Fine for one instance; move to a shared store or lower the TTLs before running several.
 */
@Injectable()
export class OrgCache {
  private orgs = new Map<string, Map<string, Entry>>();

  get<T>(organizationId: string, key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    let entries = this.orgs.get(organizationId);
    if (!entries) {
      entries = new Map();
      this.orgs.set(organizationId, entries);
    }
    const hit = entries.get(key);
    if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;
    const value = load();
    entries.set(key, { expires: Date.now() + ttlMs, value });
    // A failed load must not be served again.
    void value.catch(() => entries.get(key)?.value === value && entries.delete(key));
    return value;
  }

  invalidate(organizationId: string): void {
    this.orgs.delete(organizationId);
  }
}

/** Clears the caller's organization after any write (POST/PUT/PATCH/DELETE), whether it succeeded or not. */
@Injectable()
export class CacheInvalidationInterceptor implements NestInterceptor {
  constructor(private readonly cache: OrgCache) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const writes = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    return next.handle().pipe(finalize(() => {
      if (writes && request.actor) this.cache.invalidate(request.actor.organizationId);
    }));
  }
}

@Global()
@Module({ providers: [OrgCache, { provide: APP_INTERCEPTOR, useClass: CacheInvalidationInterceptor }], exports: [OrgCache] })
export class CacheModule {}
