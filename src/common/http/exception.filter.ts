import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { httpStatusForDbError } from '../pg-error';

/** One error shape for every failure: { statusCode, error, message, requestId }. Internals are logged, not returned. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();
    const requestId = String(request.headers['x-request-id'] ?? '');
    const described = describeException(exception);

    if (described.status >= 500) this.logger.error({ requestId, path: request.path, err: exception instanceof Error ? exception.stack : exception });
    else if (described.status >= 400) this.logger.warn(JSON.stringify({ requestId, method: request.method, path: request.path, status: described.status, message: described.message }));
    response.status(described.status).json({
      statusCode: described.status, error: HttpStatus[described.status] ?? 'Error', message: described.message, requestId,
      ...(described.code ? { code: described.code } : {}),
      ...(described.existingSale ? { existingSale: described.existingSale } : {}),
    });
  }
}

function describeException(exception: unknown): {
  status: HttpStatus;
  message: string | string[];
  code?: string;
  existingSale?: unknown;
} {
  if (exception instanceof HttpException) return describeHttpException(exception);
  const dbStatus = httpStatusForDbError(exception);
  if (!dbStatus) return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Something went wrong. Try again.' };
  return {
    status: dbStatus,
    message: dbStatus === HttpStatus.NOT_FOUND ? 'Not found' : 'Conflicts with existing data. Refresh and try again.',
  };
}

function describeHttpException(exception: HttpException): {
  status: HttpStatus;
  message: string | string[];
  code?: string;
  existingSale?: unknown;
} {
  const body = exception.getResponse();
  if (typeof body === 'string') return { status: exception.getStatus(), message: body };
  const shaped = body as { message?: string | string[]; code?: string; existingSale?: unknown };
  return {
    status: exception.getStatus(),
    message: shaped.message ?? exception.message,
    ...(typeof shaped.code === 'string' ? { code: shaped.code } : {}),
    ...(shaped.existingSale ? { existingSale: shaped.existingSale } : {}),
  };
}
