import { HttpException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { decryptSecret } from '../auth/totp';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { resolveCheckedAddress } from '../introspect/address-guard';

/**
 * Roadmap 14d (`docs/phase14/AUDIT-STREAMING.md` §3) — the delivery itself, on a bare client
 * so the integration spec runs it without Nest. `AuditStreamService` wraps it with the
 * owner routes and the notifications.
 */

export const AUDIT_STREAM_FORMATS = ['json', 'splunk_hec', 'datadog'] as const;
export type AuditStreamFormat = (typeof AUDIT_STREAM_FORMATS)[number];

/** At most this many rows per POST. */
export const BATCH_SIZE = 500;
/** At most this many batches per stream per run, so one busy org can't hold the worker. */
export const BATCHES_PER_RUN = 10;
/**
 * ponytail: rows younger than this aren't sent yet. It covers transactions that commit after
 * a later row's timestamp; a transaction open longer than this would be skipped. A
 * commit-ordered sequence column is the upgrade if that ever shows up.
 */
export const LAG_MS = 2 * 60_000;
export const TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 3_600_000;

/** 30 s after the first failure, doubling, at most an hour. No cap on attempts. */
export function backoffMs(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

export interface Cursor {
  readonly at: Date;
  readonly id: string | null;
}

/** The next batch: after the cursor on `(created_at, id)`, older than the lag, oldest first. */
export function batchQuery(organizationId: string, cursor: Cursor, now: Date) {
  return {
    where: {
      organizationId,
      createdAt: { lt: new Date(now.getTime() - LAG_MS) },
      OR: [{ createdAt: { gt: cursor.at } }, { createdAt: cursor.at, id: { gt: cursor.id ?? '' } }],
    },
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    take: BATCH_SIZE,
    select: EVENT_SELECT,
  } satisfies Prisma.AuditLogFindManyArgs;
}

const EVENT_SELECT = {
  id: true,
  createdAt: true,
  action: true,
  actorUserId: true,
  actorEmail: true,
  organizationId: true,
  organizationName: true,
  projectId: true,
  resourceType: true,
  resourceId: true,
  ip: true,
  userAgent: true,
  metadata: true,
  actor: { select: { email: true } },
  organization: { select: { name: true } },
} satisfies Prisma.AuditLogSelect;

export type EventRow = Prisma.AuditLogGetPayload<{ select: typeof EVENT_SELECT }>;

/** §3's one event shape; every format carries it. */
export interface StreamEvent {
  readonly id: string;
  readonly time: string;
  readonly action: string;
  readonly actor: { readonly id: string | null; readonly email: string | null } | null;
  readonly organization: { readonly id: string | null; readonly name: string | null };
  readonly projectId: string | null;
  readonly resource: { readonly type: string | null; readonly id: string | null };
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly metadata: Prisma.JsonValue;
}

export function toEvent(r: EventRow): StreamEvent {
  return {
    id: r.id,
    time: r.createdAt.toISOString(),
    action: r.action,
    actor:
      r.actorUserId === null && r.actorEmail === null
        ? null
        : { id: r.actorUserId, email: r.actor?.email ?? r.actorEmail },
    organization: { id: r.organizationId, name: r.organization?.name ?? r.organizationName },
    projectId: r.projectId,
    resource: { type: r.resourceType, id: r.resourceId },
    ip: r.ip,
    userAgent: r.userAgent,
    metadata: r.metadata,
  };
}

/** The request body for a format: §3's `json`, Splunk HEC's events, Datadog's logs array. */
export function envelope(format: AuditStreamFormat, events: readonly StreamEvent[]): string {
  switch (format) {
    case 'splunk_hec':
      // HEC takes concatenated event objects in one request.
      return events
        .map((e) =>
          JSON.stringify({
            time: Date.parse(e.time) / 1000,
            source: 'schemaloom',
            sourcetype: 'schemaloom:audit',
            event: e,
          }),
        )
        .join('\n');
    case 'datadog':
      return JSON.stringify(
        events.map((e) => ({
          ddsource: 'schemaloom',
          service: 'schemaloom',
          date: e.time,
          message: e.action,
          ...e,
        })),
      );
    default:
      return JSON.stringify({ events });
  }
}

/** `X-SchemaLoom-Signature`: the HMAC-SHA256 of the body under the stream's secret. */
export function signature(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export type PostResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface PostRequest {
  readonly url: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly allowPrivate: boolean;
}

/**
 * One POST through the SSRF guard: the host is resolved and checked once, and the socket
 * connects to that address (no rebinding). 10 s, no redirects; anything but a 2xx fails.
 */
export async function postBatch(req: PostRequest): Promise<PostResult> {
  const target = new URL(req.url);
  let address: string;
  try {
    address = await resolveCheckedAddress(
      target.hostname.replace(/^\[|\]$/g, ''),
      req.allowPrivate,
    );
  } catch (error) {
    return { ok: false, error: guardMessage(error) };
  }
  const family = isIP(address);
  const lookup = ((_host, options, callback) => {
    if (options.all === true) callback(null, [{ address, family }]);
    else callback(null, address, family);
  }) as LookupFunction;

  return new Promise((resolve) => {
    const request = (target.protocol === 'http:' ? http : https).request(
      target,
      {
        method: 'POST',
        lookup,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { ...req.headers, 'content-length': String(Buffer.byteLength(req.body)) },
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) resolve({ ok: true });
        else if (status >= 300 && status < 400)
          resolve({
            ok: false,
            error: `${String(status)} redirect from the endpoint (not followed)`,
          });
        else resolve({ ok: false, error: `${String(status)} from the endpoint` });
      },
    );
    request.on('error', (error) => {
      resolve({
        ok: false,
        error:
          error.name === 'TimeoutError' || error.name === 'AbortError'
            ? `no answer within ${String(TIMEOUT_MS / 1000)} s`
            : error.message,
      });
    });
    request.end(req.body);
  });
}

function guardMessage(error: unknown): string {
  if (error instanceof HttpException) {
    const { code } = error.getResponse() as { code?: unknown };
    if (code === 'introspect.private_host')
      return 'the endpoint is on a private network; a self-hosted install can allow it with AUDIT_STREAM_ALLOW_PRIVATE_HOSTS=true';
    if (code === 'introspect.unreachable') return 'could not find the endpoint’s host';
  }
  return 'unexpected error';
}

export interface StreamState {
  readonly status: string;
  readonly failures: number;
  readonly failingSince: Date | null;
}

export type Notice = 'audit_stream.failing' | 'audit_stream.recovered';

/**
 * The failing/recovered state machine (the scheduled-drift pattern, D4): owners hear once
 * when delivery starts failing and once when it recovers.
 */
export function afterAttempt(
  prev: StreamState,
  result: PostResult,
  now: Date,
): { data: Prisma.AuditStreamUpdateManyMutationInput & StreamState; notice: Notice | null } {
  if (result.ok) {
    return {
      data: {
        status: 'ok',
        failures: 0,
        failingSince: null,
        lastError: null,
        nextAttemptAt: null,
        lastDeliveredAt: now,
      },
      notice: prev.status === 'failing' ? 'audit_stream.recovered' : null,
    };
  }
  const failures = prev.failures + 1;
  return {
    data: {
      status: 'failing',
      failures,
      failingSince: prev.failingSince ?? now,
      lastError: result.error.slice(0, 500),
      nextAttemptAt: new Date(now.getTime() + backoffMs(failures)),
    },
    notice: prev.status === 'failing' ? null : 'audit_stream.failing',
  };
}

/** The columns a run reads. */
export const STREAM_SELECT = {
  id: true,
  organizationId: true,
  url: true,
  format: true,
  authHeaderName: true,
  authHeaderEnc: true,
  signingSecretEnc: true,
  cursorAt: true,
  cursorId: true,
  status: true,
  failures: true,
  failingSince: true,
} satisfies Prisma.AuditStreamSelect;

export type StreamRow = Prisma.AuditStreamGetPayload<{ select: typeof STREAM_SELECT }>;

export interface DeliverDeps {
  /** `SECRETS_ENCRYPTION_KEY` */
  readonly key: string;
  readonly allowPrivate: boolean;
  readonly post?: (req: PostRequest) => Promise<PostResult>;
}

/** The headers every request carries: format, signature, timestamp, the owner's auth header. */
export function requestHeaders(stream: StreamRow, key: string, body: string, now: Date) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'SchemaLoom-AuditStream/1',
    'x-schemaloom-timestamp': String(Math.floor(now.getTime() / 1000)),
    'x-schemaloom-signature': signature(
      decryptSecret(stream.signingSecretEnc, key).toString(),
      body,
    ),
  };
  if (stream.authHeaderName !== null && stream.authHeaderEnc !== null)
    headers[stream.authHeaderName.toLowerCase()] = decryptSecret(
      stream.authHeaderEnc,
      key,
    ).toString();
  return headers;
}

type Db = Pick<PrismaClient, 'auditLog' | 'auditStream'>;

/**
 * One stream's run: batches after the cursor until one comes back short. A 2xx advances the
 * cursor to the batch's last row; anything else leaves it and schedules the retry, so the
 * next run resends the same ids (at least once, in order, D3).
 */
export async function deliverStream(
  db: Db,
  stream: StreamRow,
  deps: DeliverDeps,
  now: Date,
): Promise<Notice | null> {
  const post = deps.post ?? postBatch;
  let cursor: Cursor = { at: stream.cursorAt, id: stream.cursorId };
  let state: StreamState = stream;
  let notice: Notice | null = null;
  for (let i = 0; i < BATCHES_PER_RUN; i++) {
    const rows = await db.auditLog.findMany(batchQuery(stream.organizationId, cursor, now));
    const last = rows.at(-1);
    if (last === undefined) break;
    const body = envelope(stream.format as AuditStreamFormat, rows.map(toEvent));
    const result = await post({
      url: stream.url,
      body,
      headers: requestHeaders(stream, deps.key, body, now),
      allowPrivate: deps.allowPrivate,
    });
    const next = afterAttempt(state, result, now);
    notice = next.notice ?? notice;
    const advance = result.ok ? { cursorAt: last.createdAt, cursorId: last.id } : {};
    // Only from the cursor this run read: a second worker on the same stream can't move it back.
    const { count } = await db.auditStream.updateMany({
      where: { id: stream.id, cursorAt: cursor.at, cursorId: cursor.id },
      data: { ...next.data, ...advance },
    });
    if (count === 0 || !result.ok) break;
    state = next.data;
    cursor = { at: last.createdAt, id: last.id };
    if (rows.length < BATCH_SIZE) break;
  }
  return notice;
}

/** The streams due now: unpaused, and past their retry time if they are failing. */
export function dueStreams(db: Db, now: Date): Promise<StreamRow[]> {
  return db.auditStream.findMany({
    where: {
      paused: false,
      organization: { deletedAt: null },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    select: STREAM_SELECT,
  });
}
