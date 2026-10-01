import { UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { driftFingerprint } from '../snapshots/snapshots.service';
import { DriftCheckService, dueCutoffs, noticeFor } from './drift-check.service';

/** Phase 6d — docs/phase6/SCHEDULED-DRIFT.md §5. */

describe('noticeFor (D4)', () => {
  const ok = (status: 'in_sync' | 'drift', fingerprint: string | null = null) => ({
    status,
    fingerprint,
  });
  it.each([
    ['in sync → new drift', ok('in_sync'), ok('drift', 'a'), 'drift.detected'],
    ['first check, drift', { status: null, fingerprint: null }, ok('drift', 'a'), 'drift.detected'],
    ['the same drift again', ok('drift', 'a'), ok('drift', 'a'), null],
    ['different drift', ok('drift', 'a'), ok('drift', 'b'), 'drift.detected'],
    ['drift resolved', ok('drift', 'a'), ok('in_sync'), null],
    [
      'starts failing',
      ok('drift', 'a'),
      { status: 'failed', fingerprint: null },
      'drift.check_failed',
    ],
    [
      'keeps failing',
      { status: 'failed', fingerprint: 'a' },
      { status: 'failed', fingerprint: null },
      null,
    ],
    ['recovers', { status: 'failed', fingerprint: 'a' }, ok('drift', 'a'), 'drift.check_recovered'],
  ] as const)('%s', (_name, previous, next, expected) => {
    expect(noticeFor(previous, next)).toBe(expected);
  });
});

describe('dueCutoffs', () => {
  it('is a day and a week back', () => {
    const now = new Date('2026-10-08T12:00:00Z');
    expect(dueCutoffs(now)).toEqual({
      daily: new Date('2026-10-07T12:00:00Z'),
      weekly: new Date('2026-10-01T12:00:00Z'),
    });
  });
});

describe('driftFingerprint', () => {
  const entry = (logicalKey: string, after: unknown) => ({
    change: 'changed',
    objectType: 'field',
    logicalKey,
    properties: [{ path: ['type', 'name'], after }],
  });
  const diff = (entries: unknown[]) => ({ entries }) as never;

  it('ignores entry order, and is null when in sync', () => {
    const a = entry('public.t.a', 'int');
    const b = entry('public.t.b', 'text');
    expect(driftFingerprint(diff([a, b]))).toBe(driftFingerprint(diff([b, a])));
    expect(driftFingerprint(diff([]))).toBeNull();
  });

  it('changes when a changed value changes again', () => {
    expect(driftFingerprint(diff([entry('public.t.a', 'bigint')]))).not.toBe(
      driftFingerprint(diff([entry('public.t.a', 'text')])),
    );
  });
});

describe('DriftCheckService.check', () => {
  function build(read: () => Promise<unknown>, fingerprint: string | null = 'f1') {
    const deps = {
      config: { get: () => true },
      prisma: {
        projectConnection: { update: vi.fn().mockResolvedValue({}) },
        orgMember: { findMany: vi.fn().mockResolvedValue([]) },
      },
      introspect: { readScheduled: vi.fn(read) },
      snapshots: {
        driftSummary: vi
          .fn()
          .mockResolvedValue({ counts: { added: 2, removed: 1, changed: 0 }, fingerprint }),
      },
      notifications: {
        projectUrl: vi.fn().mockResolvedValue('/acme/p/p1'),
        send: vi.fn().mockResolvedValue(undefined),
      },
      resolver: {
        resolveResource: vi.fn().mockResolvedValue(
          new Map([
            ['user:m1', new Set(['schema:view', 'sharing:manage'])],
            ['user:e1', new Set(['schema:view', 'schema:edit'])],
          ]),
        ),
      },
    };
    const service = new DriftCheckService(
      deps.config as never,
      deps.prisma as never,
      deps.introspect as never,
      deps.snapshots as never,
      deps.notifications as never,
      deps.resolver as never,
    );
    return { service, deps };
  }
  const row = (lastCheckStatus: string | null, driftFingerprint: string | null) => ({
    projectId: 'p1',
    lastCheckStatus,
    driftFingerprint,
    project: { organizationId: 'o1', name: 'Storefront' },
  });
  const now = new Date('2026-10-01T03:07:00Z');

  it('tells managers only, with counts and a link to Compare', async () => {
    const { service, deps } = build(() => Promise.resolve({ source: 'CREATE TABLE secret_t ();' }));
    expect(await service.check(row('in_sync', null), now)).toBe('drift');
    const [items] = deps.notifications.send.mock.calls[0] as [Record<string, unknown>[]];
    expect(items.map((i) => i.userId)).toEqual(['m1']);
    expect(items[0]).toMatchObject({
      type: 'drift.detected',
      url: '/acme/p/p1/history?compare=saved',
      data: { added: 2, removed: 1, changed: 0 },
    });
    expect(JSON.stringify(items)).not.toContain('secret_t');
    // database → design: `added` is missing from the database, `removed` exists only there.
    expect(items[0]?.title).toBe(
      'Storefront: the database differs from the design (2 only in the design, 1 only in the database)',
    );
    expect(deps.prisma.projectConnection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastCheckStatus: 'drift', driftFingerprint: 'f1' }),
      }),
    );
  });

  it('stays quiet when the drift is the same as last time', async () => {
    const { service, deps } = build(() => Promise.resolve({ source: '' }));
    await service.check(row('drift', 'f1'), now);
    expect(deps.notifications.send).not.toHaveBeenCalled();
  });

  it('records a failure once with its reason, and keeps the last good fingerprint', async () => {
    const failing = () =>
      Promise.reject(
        new UnprocessableEntityException({
          code: 'introspect.ssh_auth_failed',
          message: 'The SSH server refused the user, key or password.',
        }),
      );
    const { service, deps } = build(failing);
    expect(await service.check(row('drift', 'f1'), now)).toBe('failed');
    const update = deps.prisma.projectConnection.update.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(update.data).not.toHaveProperty('driftFingerprint');
    expect(update.data.lastCheckSummary).toEqual({
      error: 'The SSH server refused the user, key or password.',
    });
    const [items] = deps.notifications.send.mock.calls[0] as [{ type: string; title: string }[]];
    expect(items[0]?.type).toBe('drift.check_failed');
    expect(items[0]?.title).toContain('refused');
  });
});
