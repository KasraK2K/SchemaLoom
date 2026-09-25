import { z } from 'zod';
import { clientEnv } from '@/env.client';

/**
 * The browser talks to the API directly — no Next rewrite proxy, no route handlers
 * (doc 01 §5.4). That makes two things this module's responsibility:
 *
 *  1. `credentials: 'include'`, or none of the session cookies are sent and every
 *     request is anonymous.
 *  2. The CSRF double-submit echo. `sl_csrf` is deliberately NOT httpOnly precisely so
 *     this file can read it and mirror it into `X-CSRF-Token`. The API rejects any
 *     unsafe request whose header does not match the cookie with a 403, so without
 *     this echo nothing in the app can write.
 */
export const CSRF_COOKIE = 'sl_csrf';
export const CSRF_HEADER = 'X-CSRF-Token';

/** Methods the API demands a CSRF echo for. GET/HEAD/OPTIONS are exempt. */
const UNSAFE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/** The API's error envelope. Parsed rather than trusted — it is a network payload. */
const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiRequestInit extends Omit<RequestInit, 'body'> {
  /** Serialised as JSON. Pass a `BodyInit` through `fetch` directly if you need one. */
  body?: unknown;
}

export async function apiFetch<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const { body, headers, method = 'GET', ...rest } = init;
  const upperMethod = method.toUpperCase();

  const requestHeaders = new Headers(headers);
  requestHeaders.set('Accept', 'application/json');
  if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');

  if (UNSAFE_METHODS.has(upperMethod)) {
    const csrfToken = readCookie(CSRF_COOKIE);
    if (csrfToken !== undefined) requestHeaders.set(CSRF_HEADER, csrfToken);
  }

  const response = await fetch(`${clientEnv.NEXT_PUBLIC_API_URL}${path}`, {
    ...rest,
    method: upperMethod,
    headers: requestHeaders,
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw toApiError(response.status, payload);
  return payload as T;
}

function toApiError(status: number, payload: unknown): ApiError {
  const parsed = ErrorEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    return new ApiError(status, 'unknown', `Request failed with status ${String(status)}`);
  }
  const { code, message, details } = parsed.data.error;
  return new ApiError(status, code, message, details);
}
