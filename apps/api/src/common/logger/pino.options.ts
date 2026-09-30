import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';

/**
 * Doc 01 §3 — `common/logger/`: pino config plus the redaction list. Anything that
 * carries authority must never reach a log line, so the list is headers-and-body paths,
 * not a "remember to be careful" convention.
 */
const REDACT = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.newPassword',
  'req.body.token',
  'req.body.refreshToken',
  'req.body.totp',
  // Phase 6 §3.1 — database credentials for introspection
  'req.body.connection',
];

/** Honour an upstream request id when there is one; echo whatever we settle on. */
function genReqId(req: IncomingMessage, res: ServerResponse): string {
  const header = req.headers['x-request-id'];
  const inbound = Array.isArray(header) ? header[0] : header;
  const id = inbound && inbound.length > 0 ? inbound : randomUUID();
  res.setHeader('x-request-id', id);
  return id;
}

export function pinoOptions(level: string, pretty: boolean): Params {
  return {
    pinoHttp: {
      level,
      genReqId,
      redact: { paths: REDACT, censor: '[redacted]' },
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
      ...(pretty ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {}),
    },
  };
}
