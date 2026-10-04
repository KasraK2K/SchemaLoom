import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntrospectError, type EngineDefinition } from '@schemaloom/engine-sdk';
import { describe, expect, it, vi } from 'vitest';
import { ENGINE_MANIFEST } from '../engines/engines.manifest';
import type { SnapshotContext } from '../snapshots';
import { validateConnection } from './connection';
import { IntrospectService } from './introspect.service';
import { openTunnel } from './ssh-tunnel';

const postgresEngine = ENGINE_MANIFEST[0]!;
const sqliteEngine = ENGINE_MANIFEST.find((e) => e.id === 'sqlite')!;
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

  // §10.1 / §10.3
  const tunnel = { ...ok, ssh: 'ssh', ssh_host: 'bastion.example.com', ssh_user: 'jump' };

  it('drops hidden fields and requires visible ones', () => {
    const off = validateConnection(FIELDS, { ...ok, ssh_host: 'x', sslrootcert: 'y' }, false);
    expect(off).not.toHaveProperty('ssh_host');
    expect(off).not.toHaveProperty('sslrootcert');
    expect(refusedField(() => validateConnection(FIELDS, tunnel, false))).toBe('ssh_private_key');
    expect(
      validateConnection(FIELDS, { ...tunnel, ssh_auth: 'password', ssh_password: 'p' }, false),
    ).toMatchObject({ ssh_port: 22, ssh_password: 'p' });
  });

  it('takes certificate fields only as PEM text', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    const verify = { ...ok, sslmode: 'verify-ca' };
    expect(validateConnection(FIELDS, { ...verify, sslrootcert: pem }, false).sslrootcert).toBe(
      pem,
    );
    expect(
      refusedField(() => validateConnection(FIELDS, { ...verify, sslrootcert: 'nope' }, false)),
    ).toBe('sslrootcert');
  });

  it('allows sslmode=disable through a tunnel without the flag', () => {
    const plain = { ...tunnel, ssh_auth: 'password', ssh_password: 'p', sslmode: 'disable' };
    expect(validateConnection(FIELDS, plain, false).sslmode).toBe('disable');
  });

  it('refuses whatever value an engine declares insecure, whatever the field is called', () => {
    // A MySQL-shaped field: core knows nothing about `ssl_mode` or `DISABLED`.
    const fields = [
      { id: 'host', label: 'Host', kind: 'text', required: true },
      {
        id: 'ssl_mode',
        label: 'TLS',
        kind: 'select',
        required: true,
        options: ['REQUIRED', 'VERIFY_IDENTITY', 'DISABLED'],
        default: 'REQUIRED',
        insecureValues: ['DISABLED'],
      },
    ] as const;
    expect(
      refusedField(() => validateConnection(fields, { host: 'h', ssl_mode: 'DISABLED' }, false)),
    ).toBe('ssl_mode');
    expect(validateConnection(fields, { host: 'h', ssl_mode: 'DISABLED' }, true).ssl_mode).toBe(
      'DISABLED',
    );
    expect(validateConnection(fields, { host: 'h' }, false).ssl_mode).toBe('REQUIRED');
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
  nodeEnv?: 'development' | 'production';
  /** what the saved-connection store hands back for `{ saved: true }` */
  saved?: Record<string, unknown>;
  uploadMax?: number;
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
      get: (key: string) =>
        key === 'NODE_ENV'
          ? (opts.nodeEnv ?? 'production')
          : key === 'INTROSPECTION_ENABLED'
            ? true
            : key === 'INTROSPECT_UPLOAD_MAX_BYTES'
              ? (opts.uploadMax ?? 1_000_000)
              : (opts.allowPrivate ?? true),
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
    savedConnections: {
      load: vi.fn().mockResolvedValue({ ...opts.saved }),
      touch: vi.fn().mockResolvedValue(undefined),
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
    deps.savedConnections as never,
  );
  return { service, deps, introspect };
}

const connection = { host: '127.0.0.1', database: 'shop', user: 'reader', password: 'pw' };

describe('IntrospectService', () => {
  it('previews, stores the source, and keeps credentials out of storage, Redis and audit', async () => {
    const { service, deps, introspect } = build({});
    const result = await service.preview(ctx, { connection });
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
    await expect(service.preview(ctx, { connection })).rejects.toThrow('partial view');
    expect(introspect).not.toHaveBeenCalled();
  });

  it('refuses a private host without the flag, before connecting', async () => {
    const { service, introspect } = build({ allowPrivate: false });
    await expect(
      service.preview(ctx, { connection: { ...connection, sslmode: 'require' } }),
    ).rejects.toMatchObject({ response: { code: 'introspect.private_host' } });
    expect(introspect).not.toHaveBeenCalled();
  });

  it('maps an engine error to its HTTP status and audits the failure', async () => {
    const { service, deps, introspect } = build({});
    introspect.mockRejectedValueOnce(new IntrospectError('auth_failed', 'Refused.'));
    await expect(service.preview(ctx, { connection })).rejects.toMatchObject({
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

  it('a missing pg_dump points at the Docker app in development only', async () => {
    const missing = () => new IntrospectError('not_available', 'Needs pg_dump.');
    const dev = build({ nodeEnv: 'development' });
    dev.introspect.mockRejectedValueOnce(missing());
    await expect(dev.service.preview(ctx, { connection })).rejects.toMatchObject({
      status: 503,
      response: { message: expect.stringContaining('pnpm app:up') },
    });

    const prod = build({});
    prod.introspect.mockRejectedValueOnce(missing());
    await expect(prod.service.preview(ctx, { connection })).rejects.toMatchObject({
      response: { message: 'Needs pg_dump.' },
    });
  });

  it('applies a source once, for its own user and project only', async () => {
    const { service, deps } = build({});
    const { sourceId } = await service.preview(ctx, { connection });
    const other = { ...ctx, subject: { kind: 'user', userId: 'u2' } } as SnapshotContext;
    await expect(service.apply(other, sourceId, [])).rejects.toMatchObject({ status: 404 });

    const again = await service.preview(ctx, { connection });
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
    await expect(service.preview(ctx, { connection })).rejects.toMatchObject({
      response: { code: 'engine.introspection_unavailable' },
    });
  });
});

vi.mock('./ssh-tunnel', () => ({
  openTunnel: vi.fn(() =>
    Promise.resolve({ port: 40_123, hostKey: 'SHA256:bastion', close: tunnelClosed }),
  ),
}));
const tunnelClosed = vi.hoisted(() => vi.fn());

describe('IntrospectService through an SSH tunnel (§10.3)', () => {
  const viaSsh = {
    // Only the bastion can resolve this name; the guard must not try.
    host: 'db.internal.invalid',
    database: 'shop',
    user: 'reader',
    ssh: 'ssh',
    ssh_host: '127.0.0.1',
    ssh_user: 'jump',
    ssh_private_key: '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-key-body\n-----END',
  };

  it('guards the bastion, reads through the local end, and returns the host key', async () => {
    const { service, deps, introspect } = build({ allowPrivate: true });
    const result = await service.preview(ctx, { connection: viaSsh });

    expect(openTunnel).toHaveBeenCalledWith(
      expect.objectContaining({
        address: '127.0.0.1',
        dstHost: 'db.internal.invalid',
        dstPort: 5432,
      }),
    );
    expect(introspect).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedAddress: '127.0.0.1',
        connection: expect.objectContaining({ host: 'db.internal.invalid', port: 40_123 }),
      }),
    );
    expect(result.sshHostKey).toBe('SHA256:bastion');
    expect(tunnelClosed).toHaveBeenCalled();
    const audited = JSON.stringify(deps.prisma.auditLog.create.mock.calls);
    expect(audited).toContain('SHA256:bastion');
    expect(audited).not.toContain('secret-key-body');
  });
});

describe('IntrospectService with the saved connection (6c)', () => {
  it('reads with the saved values, validated again, and records the use', async () => {
    const saved = { host: '127.0.0.1', database: 'shop', user: 'reader', password: 'pw' };
    const { service, deps, introspect } = build({ saved });
    await service.preview(ctx, { saved: true });
    expect(deps.savedConnections.load).toHaveBeenCalledWith('p1', 'postgresql');
    expect(introspect).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({ password: 'pw', port: 5432 }),
      }),
    );
    expect(deps.savedConnections.touch).toHaveBeenCalledWith('p1');
    expect(JSON.stringify(deps.prisma.auditLog.create.mock.calls)).toContain('"saved":true');
  });

  it('still refuses saved values the engine no longer accepts', async () => {
    const { service, introspect } = build({ saved: { host: '127.0.0.1', removed: 'x' } });
    await expect(service.preview(ctx, { saved: true })).rejects.toMatchObject({
      response: { code: 'introspect.invalid_connection' },
    });
    expect(introspect).not.toHaveBeenCalled();
  });
});

describe('IntrospectService — an uploaded SQLite file (Phase 13 §5)', () => {
  async function sqliteFile(): Promise<Buffer> {
    const { DatabaseSync } = await import('node:sqlite');
    const dir = mkdtempSync(join(tmpdir(), 'sl-spec-'));
    const path = join(dir, 'app.db');
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT NOT NULL); INSERT INTO customers VALUES (1, 'secret-row@example.com');",
    );
    db.close();
    return readFileSync(path);
  }

  it('reads the schema and never a row, and leaves no file behind', async () => {
    let seenFile = '';
    const real = sqliteEngine.introspector;
    const { service, deps } = build({
      engine: {
        ...sqliteEngine,
        introspector: {
          introspect: (req) => {
            seenFile = req.file ?? '';
            if (real === undefined) throw new Error('no introspector');
            return real.introspect(req);
          },
        },
      },
    });
    await service.preview(ctx, { upload: await sqliteFile() });
    const source = String(deps.snapshots.preview.mock.calls[0]?.[1]);
    expect(source).toContain('CREATE TABLE customers');
    expect(source).not.toContain('secret-row');
    expect(seenFile).not.toBe('');
    expect(existsSync(seenFile)).toBe(false);
    expect(deps.prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({ upload: true, ok: true }),
        }),
      }),
    );
  });

  it('refuses a file that is not a database, a file too large, and the wrong kind of read', async () => {
    const sqlite = build({ engine: sqliteEngine });
    await expect(
      sqlite.service.preview(ctx, { upload: Buffer.from('CREATE TABLE t (id int);') }),
    ).rejects.toMatchObject({ status: 422, response: { code: 'introspect.failed' } });
    await expect(sqlite.service.preview(ctx, { connection })).rejects.toMatchObject({
      status: 422,
      response: { code: 'introspect.upload_required' },
    });
    const small = build({ engine: sqliteEngine, uploadMax: 10 });
    await expect(small.service.preview(ctx, { upload: await sqliteFile() })).rejects.toMatchObject({
      status: 413,
    });
    const postgres = build({});
    await expect(postgres.service.preview(ctx, { upload: Buffer.from('x') })).rejects.toMatchObject(
      {
        status: 422,
        response: { code: 'introspect.upload_not_supported' },
      },
    );
  });
});
