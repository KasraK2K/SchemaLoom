import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BATCH_SIZE,
  LAG_MS,
  afterAttempt,
  backoffMs,
  batchQuery,
  envelope,
  signature,
  type StreamEvent,
} from './audit-stream.core';

const NOW = new Date('2026-10-10T12:00:00Z');

const event = (id: string, action = 'grant.created'): StreamEvent => ({
  id,
  time: '2026-10-10T11:50:00.000Z',
  action,
  actor: { id: 'u1', email: 'ana@example.com' },
  organization: { id: 'o1', name: 'Acme' },
  projectId: 'p1',
  resource: { type: 'grant', id: 'g1' },
  ip: '203.0.113.9',
  userAgent: 'test',
  metadata: { role: 'viewer' },
});

describe('batchQuery (§3)', () => {
  const cursor = { at: new Date('2026-10-10T11:00:00Z'), id: 'c5' };
  const q = batchQuery('o1', cursor, NOW);

  it('takes rows after the cursor, ties broken on id', () => {
    expect(q.where.organizationId).toBe('o1');
    expect(q.where.OR).toEqual([
      { createdAt: { gt: cursor.at } },
      { createdAt: cursor.at, id: { gt: 'c5' } },
    ]);
  });

  it('leaves the last two minutes alone', () => {
    expect(q.where.createdAt.lt.getTime()).toBe(NOW.getTime() - LAG_MS);
    expect(LAG_MS).toBe(120_000);
  });

  it('is oldest first on (createdAt, id), at most 500', () => {
    expect(q.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(q.take).toBe(BATCH_SIZE);
    expect(BATCH_SIZE).toBe(500);
  });

  it('a fresh stream (no cursor id) takes every row at its start instant', () => {
    const fresh = batchQuery('o1', { at: cursor.at, id: null }, NOW);
    expect(fresh.where.OR[1]).toEqual({ createdAt: cursor.at, id: { gt: '' } });
  });
});

describe('envelope (D5)', () => {
  const events = [event('a'), event('b')];

  it('json: one generic shape', () => {
    expect(JSON.parse(envelope('json', events))).toEqual({ events });
  });

  it('splunk_hec: one HEC event per row, epoch seconds', () => {
    const lines = envelope('splunk_hec', events)
      .split('\n')
      .map((l) => JSON.parse(l) as unknown);
    expect(lines).toEqual(
      events.map((e) => ({
        time: Date.parse(e.time) / 1000,
        source: 'schemaloom',
        sourcetype: 'schemaloom:audit',
        event: e,
      })),
    );
  });

  it('datadog: the logs-API array, the event as attributes', () => {
    const logs = JSON.parse(envelope('datadog', events)) as Record<string, unknown>[];
    expect(logs).toHaveLength(2);
    expect(logs[0]).toEqual({
      ddsource: 'schemaloom',
      service: 'schemaloom',
      date: events[0]?.time,
      message: 'grant.created',
      ...events[0],
    });
  });
});

describe('signature', () => {
  it('is sha256=<hex HMAC of the body>', () => {
    const body = '{"events":[]}';
    const expected = createHmac('sha256', 'shh').update(body).digest('hex');
    expect(signature('shh', body)).toBe(`sha256=${expected}`);
    expect(signature('other', body)).not.toBe(`sha256=${expected}`);
  });
});

describe('backoffMs', () => {
  it('starts at 30 s, doubles, stops at an hour', () => {
    expect([1, 2, 3, 4, 7, 8, 50].map(backoffMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 1_920_000, 3_600_000, 3_600_000,
    ]);
  });
});

describe('afterAttempt: failing and recovered', () => {
  const ok = { status: 'ok', failures: 0, failingSince: null };

  it('the first failure says so once, and schedules the retry', () => {
    const { data, notice } = afterAttempt(ok, { ok: false, error: '503 from the endpoint' }, NOW);
    expect(notice).toBe('audit_stream.failing');
    expect(data).toMatchObject({
      status: 'failing',
      failures: 1,
      failingSince: NOW,
      lastError: '503 from the endpoint',
      nextAttemptAt: new Date(NOW.getTime() + 30_000),
    });
  });

  it('later failures are quiet, back off, and keep failingSince', () => {
    const since = new Date('2026-10-10T10:42:00Z');
    const { data, notice } = afterAttempt(
      { status: 'failing', failures: 3, failingSince: since },
      { ok: false, error: 'timeout' },
      NOW,
    );
    expect(notice).toBeNull();
    expect(data).toMatchObject({
      failures: 4,
      failingSince: since,
      nextAttemptAt: new Date(NOW.getTime() + 240_000),
    });
  });

  it('a success after failing recovers once and clears the state', () => {
    const { data, notice } = afterAttempt(
      { status: 'failing', failures: 4, failingSince: NOW },
      { ok: true },
      NOW,
    );
    expect(notice).toBe('audit_stream.recovered');
    expect(data).toEqual({
      status: 'ok',
      failures: 0,
      failingSince: null,
      lastError: null,
      nextAttemptAt: null,
      lastDeliveredAt: NOW,
    });
  });

  it('a success while healthy says nothing', () => {
    expect(afterAttempt(ok, { ok: true }, NOW).notice).toBeNull();
  });
});
