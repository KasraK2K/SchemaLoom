import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptSecret } from '../auth/totp';
import { PrismaClient } from '../generated/prisma/client';
import { LAG_MS, STREAM_SELECT, deliverStream } from './audit-stream.core';

/**
 * Roadmap 14d §5 against a real Postgres (`DATABASE_URL_TEST`) and a fake receiver on
 * 127.0.0.1: every row arrives once and in order, a 500 leaves the cursor so the next run
 * resends the same ids, and a private address is refused without the opt-in.
 */

const url = process.env.DATABASE_URL_TEST;
const TAG = 'audit-stream-spec';
const KEY = randomBytes(32).toString('base64');
const SECRET = 'signing-secret';
const START = new Date('2026-10-10T10:00:00Z');
const NOW = new Date('2026-10-10T12:00:00Z');
const at = (minutes: number): Date => new Date(START.getTime() + minutes * 60_000);

interface Received {
  readonly ids: string[];
  readonly signature: string | undefined;
  readonly body: string;
}

describe.skipIf(url === undefined)('audit stream delivery (roadmap 14d)', () => {
  const db = new PrismaClient({ datasourceUrl: url });
  const orgId = `org_${TAG}`;
  const received: Received[] = [];
  let answer = 200;
  let server: Server;
  let endpoint = '';

  const stream = () =>
    db.auditStream.findUniqueOrThrow({ where: { organizationId: orgId }, select: STREAM_SELECT });
  const run = async (allowPrivate = true) =>
    deliverStream(db, await stream(), { key: KEY, allowPrivate }, NOW);
  const sentIds = () => received.flatMap((r) => r.ids);

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        const parsed = JSON.parse(body) as { events: { id: string }[] };
        received.push({
          ids: parsed.events.map((e) => e.id),
          signature: req.headers['x-schemaloom-signature'] as string | undefined,
          body,
        });
        res.statusCode = answer;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/hook`;
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.organization.create({ data: { id: orgId, name: TAG, slug: TAG } });
  });

  beforeEach(async () => {
    received.length = 0;
    answer = 200;
    // The spec's rows all have `r-` ids (a cuid has no dash); deleting the org keeps them.
    await db.auditLog.deleteMany({ where: { id: { startsWith: 'r-' } } });
    await db.auditStream.deleteMany({ where: { organizationId: orgId } });
    await db.auditStream.create({
      data: {
        organizationId: orgId,
        url: endpoint,
        format: 'json',
        signingSecretEnc: encryptSecret(Buffer.from(SECRET), KEY),
        cursorAt: START,
      },
    });
  });

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { id: { startsWith: 'r-' } } });
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.$disconnect();
    await new Promise((resolve) => server.close(resolve));
  });

  it('sends every row after the cursor exactly once, in (createdAt, id) order', async () => {
    const tie = at(5);
    await db.auditLog.createMany({
      data: [
        { id: 'r-before', organizationId: orgId, action: 'x.before', createdAt: at(-1) },
        // Three rows share a timestamp: id breaks the tie, and the batch boundary falls inside.
        { id: 'r-tie-c', organizationId: orgId, action: 'x.tie', createdAt: tie },
        { id: 'r-tie-a', organizationId: orgId, action: 'x.tie', createdAt: tie },
        { id: 'r-tie-b', organizationId: orgId, action: 'x.tie', createdAt: tie },
        // 500 more, so the run needs a second batch.
        ...Array.from({ length: 500 }, (_, i) => ({
          id: `r-bulk-${String(i).padStart(3, '0')}`,
          organizationId: orgId,
          action: 'x.bulk',
          createdAt: at(10 + i / 100),
        })),
        // Inside the 2-minute lag: not yet.
        {
          id: 'r-too-new',
          organizationId: orgId,
          action: 'x.new',
          createdAt: new Date(NOW.getTime() - LAG_MS / 2),
        },
        // Another org's row never leaves through this stream.
        { id: 'r-other-org', action: 'x.other', createdAt: at(6) },
      ],
    });

    expect(await run()).toBeNull();

    const expected = [
      'r-tie-a',
      'r-tie-b',
      'r-tie-c',
      ...Array.from({ length: 500 }, (_, i) => `r-bulk-${String(i).padStart(3, '0')}`),
    ];
    expect(received.map((r) => r.ids.length)).toEqual([500, 3]);
    expect(sentIds()).toEqual(expected);
    for (const r of received)
      expect(r.signature).toBe(
        `sha256=${createHmac('sha256', SECRET).update(r.body).digest('hex')}`,
      );

    const after = await db.auditStream.findUniqueOrThrow({ where: { organizationId: orgId } });
    expect(after).toMatchObject({ cursorId: 'r-bulk-499', status: 'ok', failures: 0 });
    expect(after.lastDeliveredAt).toEqual(NOW);

    // Nothing new: the next run sends nothing.
    await run();
    expect(received).toHaveLength(2);
  });

  it('a 500 leaves the cursor, and the next run resends the same ids', async () => {
    await db.auditLog.createMany({
      data: ['a', 'b', 'c'].map((id, i) => ({
        id: `r-${id}`,
        organizationId: orgId,
        action: 'x.retry',
        createdAt: at(i + 1),
      })),
    });

    answer = 500;
    expect(await run()).toBe('audit_stream.failing');
    const failing = await db.auditStream.findUniqueOrThrow({ where: { organizationId: orgId } });
    expect(failing).toMatchObject({
      cursorAt: START,
      cursorId: null,
      status: 'failing',
      failures: 1,
      lastError: '500 from the endpoint',
      failingSince: NOW,
      nextAttemptAt: new Date(NOW.getTime() + 30_000),
    });

    answer = 200;
    expect(await run()).toBe('audit_stream.recovered');
    expect(received.map((r) => r.ids)).toEqual([
      ['r-a', 'r-b', 'r-c'],
      ['r-a', 'r-b', 'r-c'],
    ]);
    expect(
      await db.auditStream.findUniqueOrThrow({ where: { organizationId: orgId } }),
    ).toMatchObject({
      cursorId: 'r-c',
      status: 'ok',
      failures: 0,
      lastError: null,
      nextAttemptAt: null,
    });
  });

  it('refuses a private address without AUDIT_STREAM_ALLOW_PRIVATE_HOSTS', async () => {
    await db.auditLog.create({
      data: { id: 'r-private', organizationId: orgId, action: 'x.private', createdAt: at(1) },
    });

    expect(await run(false)).toBe('audit_stream.failing');
    expect(received).toEqual([]);
    const refused = await db.auditStream.findUniqueOrThrow({ where: { organizationId: orgId } });
    expect(refused.cursorId).toBeNull();
    expect(refused.lastError).toContain('AUDIT_STREAM_ALLOW_PRIVATE_HOSTS');
  });
});
