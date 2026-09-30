import { IntrospectError, type EngineDefinition } from '@schemaloom/engine-sdk';
import { describe, expect, it, vi } from 'vitest';
import { ENGINE_MANIFEST } from '../engines/engines.manifest';
import type { SnapshotContext } from '../snapshots';
import { validateConnection } from './connection';
import { IntrospectService } from './introspect.service';

const postgresEngine = ENGINE_MANIFEST[0]!;
const FIELDS = postgresEngine.capabilities.connectionFields;

/** The `field` a validation error names, or undefined when nothing was thrown. */
const refusedField = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return (error as { response?: { field?: string } }).response?.field;
  }
  return undefined;
};

describe('validateConnection', () => {
  const ok = { host: ' db.example.com ', database: 'shop', user: 'reader', password: 'pw' };

  it('fills defaults and trims the host', () => {
    expect(validateConnection(FIELDS, ok, false)).toMatchObject({
      host: 'db.example.com',
      port: 5432,
      sslmode: 'require',
    });
  });

  it.each([
    [{ ...ok, extra: 'x' }, 'extra'],
    [{ ...ok, host: '' }, 'host'],
    [{ ...ok, port: 70_000 }, 'port'],
    [{ ...ok, port: 'abc' }, 'port'],
    [{ ...ok, sslmode: 'maybe' }, 'sslmode'],
    [{ ...ok, schemas: 'public' }, 'schemas'],
    [{ ...ok, user: { $ne: '' } }, 'user'],
  ])('refuses %j at %s', (input, field) => {
    expect(refusedField(() => validateConnection(FIELDS, input, true))).toBe(field);
  });

  it('allows sslmode=disable only with the private-hosts flag', () => {
    const plain = { ...ok, sslmode: 'disable' };
    expect(() => validateConnection(FIELDS, plain, false)).toThrow();
    expect(validateConnection(FIELDS, plain, true).sslmode).toBe('disable');
  });
});

const ctx: SnapshotContext = {
  projectId: 'p1',
  subject: { kind: 'user', userId: 'u1' },
  actorUserId: 'u1',
  map: {},
  skel: {},
} as unknown as SnapshotContext;

function build(opts: {
  engine?: Partial<EngineDefinition>;
  fullView?: boolean;
  allowPrivate?: boolean;
}) {
  const introspect = vi.fn().mockResolvedValue({
    source: 'CREATE TABLE t (id int);',
    format: 'ddl',
    serverVersion: '16.4',
  });
  const engine = { ...postgresEngine, introspector: { introspect }, ...opts.engine };
  const cache = new Map<string, string>();
  const deps = {
    config: {
      get: (key: string) => (key === 'INTROSPECTION_ENABLED' ? true : (opts.allowPrivate ?? true)),
    },
    registry: { tryGet: () => engine },
    prisma: {
      project: {
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ engineId: 'postgresql', organizationId: 'o1' }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    },
    snapshots: {
      assertFullView: vi.fn(() => {
        if (opts.fullView === false) throw new Error('partial view');
      }),
      preview: vi.fn().mockResolvedValue({ creates: ['t'], existing: [], renameCandidates: [] }),
      drift: vi.fn(),
    },
    jobs: { enqueueImport: vi.fn().mockResolvedValue('job1') },
    storage: { put: vi.fn().mockResolvedValue(undefined) },
    rateLimit: { incr: vi.fn().mockResolvedValue(1), expire: vi.fn(), ttl: vi.fn() },
    cache: {
      set: vi.fn((k: string, v: string) => {
        cache.set(k, v);
        return Promise.resolve('OK');
      }),
      getdel: vi.fn((k: string) => {
        const v = cache.get(k) ?? null;
        cache.delete(k);
        return Promise.resolve(v);
      }),
    },
  };
  const service = new IntrospectService(
    deps.config as never,
    deps.registry as never,
    deps.prisma as never,
    deps.snapshots as never,
    deps.jobs as never,
    deps.storage as never,
    deps.rateLimit as never,
    deps.cache as never,
  );
  return { service, deps, introspect };
}

const connection = { host: '127.0.0.1', database: 'shop', user: 'reader', password: 'pw' };

describe('IntrospectService', () => {
  it('previews, stores the source, and keeps credentials out of storage, Redis and audit', async () => {
    const { service, deps, introspect } = build({});
    const result = await service.preview(ctx, connection);
    expect(result.preview.creates).toEqual(['t']);
    expect(introspect).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedAddress: '127.0.0.1' }),
    );
    const written = JSON.stringify([
      deps.storage.put.mock.calls,
      deps.cache.set.mock.calls,
      deps.prisma.auditLog.create.mock.calls,
    ]);
    expect(written).not.toContain('"pw"');
    expect(written).not.toContain('reader');
  });

  it('checks the full view before connecting anywhere', async () => {
    const { service, introspect } = build({ fullView: false });
    await expect(service.preview(ctx, connection)).rejects.toThrow('partial view');
    expect(introspect).not.toHaveBeenCalled();
  });

  it('refuses a private host without the flag, before connecting', async () => {
    const { service, introspect } = build({ allowPrivate: false });
    await expect(service.preview(ctx, { ...connection, sslmode: 'require' })).rejects.toMatchObject(
      { response: { code: 'introspect.private_host' } },
    );
    expect(introspect).not.toHaveBeenCalled();
  });

  it('maps an engine error to its HTTP status and audits the failure', async () => {
    const { service, deps, introspect } = build({});
    introspect.mockRejectedValueOnce(new IntrospectError('auth_failed', 'Refused.'));
    await expect(service.preview(ctx, connection)).rejects.toMatchObject({
      status: 422,
      response: { code: 'introspect.auth_failed' },
    });
    expect(deps.prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({ ok: false }),
        }),
      }),
    );
  });

  it('applies a source once, for its own user and project only', async () => {
    const { service, deps } = build({});
    const { sourceId } = await service.preview(ctx, connection);
    const other = { ...ctx, subject: { kind: 'user', userId: 'u2' } } as SnapshotContext;
    await expect(service.apply(other, sourceId, [])).rejects.toMatchObject({ status: 404 });

    const again = await service.preview(ctx, connection);
    await expect(service.apply(ctx, again.sourceId, [])).resolves.toEqual({ id: 'job1' });
    expect(deps.jobs.enqueueImport).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        storageKey: expect.stringContaining('imports/p1/'),
      }),
    );
    await expect(service.apply(ctx, again.sourceId, [])).rejects.toMatchObject({ status: 404 });
  });

  it('refuses an engine without an introspector', async () => {
    const { service } = build({ engine: { introspector: undefined } });
    await expect(service.preview(ctx, connection)).rejects.toMatchObject({
      response: { code: 'engine.introspection_unavailable' },
    });
  });
});
