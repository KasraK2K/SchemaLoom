import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { toEnvelope } from '../common/all-exceptions.filter';
import { SCHEMA } from './scim.protocol';

/**
 * RFC 7644 §3.12 — SCIM clients read `{ schemas, status, scimType?, detail }`, not the
 * product's `{ error }` envelope. Same mapping underneath (`toEnvelope`), so a 500 still
 * leaks nothing. Covers the guards too: a revoked token's 401 arrives in this shape.
 */
@Catch()
export class ScimExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ScimExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const [status, error] = toEnvelope(exception);
    if (status >= 500) this.logger.error(exception);
    if (res.headersSent) return;
    const raw = exception instanceof HttpException ? exception.getResponse() : null;
    const scimType =
      typeof raw === 'object' &&
      raw !== null &&
      'scimType' in raw &&
      typeof raw.scimType === 'string'
        ? raw.scimType
        : undefined;
    res
      .status(status)
      .type('application/scim+json')
      .json({
        schemas: [SCHEMA.error],
        status: String(status),
        ...(scimType === undefined ? {} : { scimType }),
        detail: error.message,
      });
  }
}
