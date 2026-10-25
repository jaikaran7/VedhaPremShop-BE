import { HttpStatus } from '@nestjs/common';

interface KnownError {
  code?: string;
  message?: string;
}

/**
 * Prisma error codes → HTTP. Unique (P2002) → 409, FK (P2003) → 422, missing row (P2025) → 404.
 * Raw-query failures (P2010) carry the Postgres error in the message; CHECK violations → 422,
 * append-only trigger → 409.
 */
export function httpStatusForDbError(error: unknown): HttpStatus | undefined {
  const known = error as KnownError;
  const message = known?.message ?? '';
  if (message.includes('append-only')) return HttpStatus.CONFLICT;
  switch (known?.code) {
    case 'P2002': return HttpStatus.CONFLICT;
    case 'P2003': return HttpStatus.UNPROCESSABLE_ENTITY;
    case 'P2025': return HttpStatus.NOT_FOUND;
    default:
      return /check constraint|violates check/i.test(message) ? HttpStatus.UNPROCESSABLE_ENTITY : undefined;
  }
}

export const isUniqueViolation = (error: unknown): boolean => (error as KnownError)?.code === 'P2002';
