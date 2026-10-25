import { type CallHandler, type ExecutionContext, Injectable, Logger, type NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { type Observable, tap } from 'rxjs';
import type { AuthedRequest } from '../auth/actor';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * One structured INFO line per successful write request (create / update / delete / business action).
 * Only identifiers and timings are logged: never bodies, query strings, tokens or customer details.
 * Failures are logged by AllExceptionsFilter.
 */
@Injectable()
export class RequestLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Request');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthedRequest>();
    if (READ_METHODS.has(request.method)) return next.handle();
    const startedAt = Date.now();
    return next.handle().pipe(tap(() => {
      this.logger.log(JSON.stringify({
        requestId: String(request.headers['x-request-id'] ?? ''),
        method: request.method,
        path: request.path,
        status: http.getResponse<Response>().statusCode,
        userId: request.actor?.userId,
        organizationId: request.actor?.organizationId,
        durationMs: Date.now() - startedAt,
      }));
    }));
  }
}
