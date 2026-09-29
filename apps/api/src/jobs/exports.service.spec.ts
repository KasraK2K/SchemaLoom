import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { EngineRegistry } from '@schemaloom/engine-sdk';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionResolver } from '../access';
import type { PrismaService } from '../prisma/prisma.service';
import type { StorageService } from '../storage';
import { EXPORT_DOWNLOAD_TTL_SEC, ExportsService, IMAGE_EXPORT_MAX_BYTES } from './exports.service';
import type { JobsService } from './jobs.service';

/**
 * No database, no bucket: what this service decides is WHICH row a caller may touch and
 * whether an uploaded object is acceptable, and a stub per dependency records exactly that.
 */

const ANA = { kind: 'user', userId: 'usr_ana', orgId: 'org_acme' } as const;

interface Row {
  id: string;
  projectId: string;
  requestedById: string;
  format: string;
  status: string;
  storageKey: string | null;
  error: string | null;
  expiresAt: Date | null;
}

function harness(
  opts: {
    rows?: Row[];
    atoms?: string[];
    head?: { size: number; contentType: string } | null;
  } = {},
) {
  const rows = new Map((opts.rows ?? []).map((r) => [r.id, { ...r }]));
  let seq = 0;
  const prisma = {
    exportJob: {
      create: ({ data }: { data: Partial<Row> }) => {
        const row = {
          id: `exj_${String(++seq)}`,
          status: 'queued',
          storageKey: null,
          error: null,
          expiresAt: null,
          ...data,
        } as Row;
        rows.set(row.id, row);
        return Promise.resolve(row);
      },
      update: ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = Object.assign(rows.get(where.id)!, data);
        return Promise.resolve(row);
      },
      findFirst: ({ where }: { where: { id: string; requestedById: string } }) => {
        const row = rows.get(where.id);
        return Promise.resolve(row?.requestedById === where.requestedById ? row : null);
      },
    },
    project: { findFirst: () => Promise.resolve({ engineId: 'postgresql' }) },
  } as unknown as PrismaService;

  const enqueueExport = vi.fn(() => Promise.resolve('job'));
  const storage = {
    presignPut: vi.fn(() => Promise.resolve('https://s3/put')),
    presignGet: vi.fn(() => Promise.resolve('https://s3/get')),
    head: vi.fn(() => Promise.resolve(opts.head === undefined ? null : opts.head)),
    delete: vi.fn(() => Promise.resolve()),
  };
  const atoms = new Set(opts.atoms ?? ['schema:view', 'export:run']);
  const resolver = {
    resolveProject: () =>
      Promise.resolve({ projectAtoms: atoms, areaAtoms: new Map(), entityOverrides: new Map() }),
  } as unknown as PermissionResolver;
  const registry = {
    tryGet: () => ({ exporter: {}, capabilities: { exportFormats: [{ id: 'postgresql-ddl' }] } }),
  } as unknown as EngineRegistry;

  const service = new ExportsService(
    prisma,
    { enqueueExport } as unknown as JobsService,
    storage as unknown as StorageService,
    resolver,
    registry,
  );
  return { service, rows, enqueueExport, storage };
}

const uploadRow = (over: Partial<Row> = {}): Row => ({
  id: 'exj_img',
  projectId: 'prj',
  requestedById: 'usr_ana',
  format: 'png',
  status: 'running',
  storageKey: 'exports/prj/exj_img.png',
  error: null,
  expiresAt: null,
  ...over,
});

describe('ExportsService.create', () => {
  it('queues a server format with the requester as subject', async () => {
    const h = harness();
    const out = await h.service.create(ANA, 'prj', { format: 'pdf' });
    expect(out).toMatchObject({ format: 'pdf', status: 'queued' });
    expect(h.enqueueExport).toHaveBeenCalledWith({
      exportJobId: out.id,
      projectId: 'prj',
      subject: ANA,
      format: 'pdf',
    });
  });

  it('accepts an engine format the project engine declares, refuses anything else', async () => {
    const h = harness();
    await expect(h.service.create(ANA, 'prj', { format: 'postgresql-ddl' })).resolves.toBeDefined();
    await expect(h.service.create(ANA, 'prj', { format: 'mysql-ddl' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('gives an image export a presigned PUT signed for its declared size, and no job', async () => {
    const h = harness();
    const out = await h.service.create(ANA, 'prj', { format: 'svg', sizeBytes: 1234 });
    expect(out).toMatchObject({ status: 'running', uploadUrl: 'https://s3/put' });
    expect(h.storage.presignPut).toHaveBeenCalledWith(
      `exports/prj/${out.id}.svg`,
      'image/svg+xml',
      300,
      1234,
    );
    expect(h.enqueueExport).not.toHaveBeenCalled();
  });

  it('requires the size up front for an image', async () => {
    const h = harness();
    await expect(h.service.create(ANA, 'prj', { format: 'png' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('ExportsService.complete', () => {
  it('marks a well-formed upload done and hands back a download link', async () => {
    const h = harness({ rows: [uploadRow()], head: { size: 2048, contentType: 'image/png' } });
    const out = await h.service.complete(ANA, 'exj_img');
    expect(out).toMatchObject({ status: 'done', downloadUrl: 'https://s3/get' });
    expect(h.rows.get('exj_img')?.expiresAt).toBeInstanceOf(Date);
  });

  it.each([
    ['a wrong content type', { size: 2048, contentType: 'text/html' }],
    ['an oversized object', { size: IMAGE_EXPORT_MAX_BYTES + 1, contentType: 'image/png' }],
    ['an empty object', { size: 0, contentType: 'image/png' }],
  ])('deletes and fails %s', async (_label, head) => {
    const h = harness({ rows: [uploadRow()], head });
    await expect(h.service.complete(ANA, 'exj_img')).rejects.toBeInstanceOf(BadRequestException);
    expect(h.storage.delete).toHaveBeenCalledWith('exports/prj/exj_img.png');
    expect(h.rows.get('exj_img')?.status).toBe('failed');
  });

  it('refuses to complete a server-rendered job', async () => {
    const h = harness({ rows: [uploadRow({ format: 'pdf', status: 'queued' })] });
    await expect(h.service.complete(ANA, 'exj_img')).rejects.toMatchObject({ status: 409 });
  });
});

describe('ExportsService.get', () => {
  it('is 404 for another user’s job — the same body as a missing one', async () => {
    const h = harness({ rows: [uploadRow({ requestedById: 'usr_bob' })] });
    await expect(h.service.get(ANA, 'exj_img')).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.service.get(ANA, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is 404 once the artifact has expired', async () => {
    const h = harness({
      rows: [uploadRow({ status: 'done', expiresAt: new Date(Date.now() - 1) })],
    });
    await expect(h.service.get(ANA, 'exj_img')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('re-checks export:run, so a revoked grant revokes the download', async () => {
    const h = harness({ rows: [uploadRow({ status: 'done' })], atoms: ['schema:view'] });
    await expect(h.service.get(ANA, 'exj_img')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('is 404 when the project is no longer visible at all', async () => {
    const h = harness({ rows: [uploadRow({ status: 'done' })], atoms: [] });
    await expect(h.service.get(ANA, 'exj_img')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('signs a ten-minute download named after the format', async () => {
    const h = harness({ rows: [uploadRow({ status: 'done' })] });
    await h.service.get(ANA, 'exj_img');
    expect(h.storage.presignGet).toHaveBeenCalledWith(
      'exports/prj/exj_img.png',
      EXPORT_DOWNLOAD_TTL_SEC,
      'schema.png',
    );
    expect(EXPORT_DOWNLOAD_TTL_SEC).toBe(600);
  });
});
