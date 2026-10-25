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

    let status: HttpStatus = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Something went wrong. Try again.';
    const dbStatus = httpStatusForDbError(exception);
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      message = typeof body === 'string' ? body : ((body as { message?: string | string[] }).message ?? exception.message);
    } else if (dbStatus) {
      status = dbStatus;
      message = status === HttpStatus.NOT_FOUND ? 'Not found' : 'Conflicts with existing data. Refresh and try again.';
    }

    if (status >= 500) this.logger.error({ requestId, path: request.path, err: exception instanceof Error ? exception.stack : exception });
    else if (status >= 400) this.logger.warn(JSON.stringify({ requestId, method: request.method, path: request.path, status, message }));
    response.status(status).json({ statusCode: status, error: HttpStatus[status] ?? 'Error', message, requestId });
  }
}
