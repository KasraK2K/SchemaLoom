import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * Every error leaves the API in ONE shape — `{ error: { code, message, details? } }` —
 * which is what `apps/web/src/lib/api-client.ts` parses. Without this filter Nest sent
 * each exception's raw body (`{ code: 'EMAIL_TAKEN' }`), the client's envelope parse
 * failed, and every refusal rendered as "Request failed with status 409".
 *
 * Codes are lower-cased: the throw sites mix `EMAIL_TAKEN` and `not_found`, and the
 * client should match one spelling. Any other field a throw site attached (`atom`,
 * `conflicts`, a validation `errors` list) travels in `details`.
 *
 * A non-HTTP exception is a bug, not a refusal: it is logged with its stack and answered
 * as a bare 500, so nothing about the failure (a Prisma message, a SQL fragment) leaks.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const [status, error] = toEnvelope(exception);
    if (status >= 500) this.logger.error(exception);
    if (res.headersSent) return;
    res.status(status).json({ error });
  }
}

export interface ErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Pure, so the mapping is testable without an HTTP stack. */
export function toEnvelope(exception: unknown): [number, ErrorBody] {
  if (!(exception instanceof HttpException)) {
    return [
      HttpStatus.INTERNAL_SERVER_ERROR,
      { code: 'internal', message: 'Something went wrong on our side.' },
    ];
  }

  const status = exception.getStatus();
  const raw = exception.getResponse();
  const body: Record<string, unknown> = typeof raw === 'object' ? { ...raw } : { message: raw };

  const { code, message, statusCode: _statusCode, error: _error, ...rest } = body;
  const text = Array.isArray(message) ? message.join('; ') : message;
  const envelope: ErrorBody = {
    code: typeof code === 'string' ? code.toLowerCase() : defaultCode(status),
    message: typeof text === 'string' && text !== '' ? text : exception.message,
  };
  if (Object.keys(rest).length > 0) envelope.details = rest;
  return [status, envelope];
}

function defaultCode(status: number): string {
  return (HttpStatus[status] ?? 'error').toLowerCase();
}
