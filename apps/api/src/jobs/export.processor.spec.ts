import type { EngineDefinition, EngineRegistry } from '@schemaloom/engine-sdk';
import {
  RawSchemaModel,
  assembleModel,
  type RedactedModel,
  type SchemaModel,
} from '@schemaloom/schema-model';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PermissionResolver, VisibilityFilter } from '../access';
import type { PrismaService } from '../prisma/prisma.service';
import { fakePrisma, type Store } from '../schema/fake-prisma';
import { PROJECT, baseStore, entityRow, fieldRow, redactFully } from '../schema/fixture';
import type { SchemaLoader } from '../schema';
import { readProjectRows } from '../schema/row-read';
import type { NotificationsService } from '../notifications';
import type { StorageService } from '../storage';
import { EXPORT_ARTIFACT_TTL_MS, ExportProcessor } from './export.processor';
import type { ExportJobData } from './queues';

/**
 * Docker is not a test dependency. Every rule this processor encodes — the model reaches
 * the renderer only through `VisibilityFilter`, the artifact is written before the row
 * claims `done`, a failure lands as `failed` with its message — is a rule about WHICH
 * calls it makes, and stubs that record them test exactly that.
 */

const STORE: Partial<Store> = baseStore({
  entity: [entityRow('ent_orders', { name: 'orders' })],
  field: [fieldRow('fld_id', 'ent_orders', { name: 'id', dataType: 'uuid' })],
});

const DATA: ExportJobData = {
  exportJobId: 'exj_1',
  projectId: PROJECT,
  subject: { kind: 'user', userId: 'usr_ana', orgId: 'org_acme' },
  format: 'ir-json',
};

let model: SchemaModel;

beforeAll(async () => {
  const rows = await readProjectRows(fakePrisma(STORE).client, PROJECT);
  model = assembleModel({ projectId: PROJECT, engineId: 'postgresql', engineVersion: '16', rows });
});

interface Harness {
  readonly processor: ExportProcessor;
  readonly updates: { where: { id: string }; data: Record<string, unknown> }[];
  readonly put: ReturnType<
    typeof vi.fn<(key: string, body: Buffer, type: string) => Promise<void>>
  >;
  readonly redactModel: ReturnType<typeof vi.fn>;
  readonly send: ReturnType<typeof vi.fn>;
}

function harness(over: { put?: () => Promise<void>; atoms?: string[] } = {}): Harness {
  const updates: Harness['updates'] = [];
  const prisma = {
    exportJob: {
      update: (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(args);
        return Promise.resolve(args.data);
      },
    },
    doc: { findMany: () => Promise.resolve([]) },
    project: { findFirst: () => Promise.resolve({ organizationId: 'org_acme' }) },
  } as unknown as PrismaService;

  // Named after the old one-call API; the processor now resolves the map itself and calls
  // `redactWith`, so the export:run re-check and the redaction share one resolution.
  const redactModel = vi.fn((): RedactedModel => redactFully(model));
  const visibility = {
    redactWith: redactModel,
    contextFrom: () => ({
      visibleEntityIds: new Set(['ent_orders']),
      totalEntityCount: 1,
      entitiesWithRestrictedFields: new Set(),
      restrictedOkEntityIds: new Set(),
    }),
  } as unknown as VisibilityFilter;
  const resolver = {
    resolveProject: () =>
      Promise.resolve({
        projectAtoms: new Set(over.atoms ?? ['schema:view', 'export:run']),
        areaAtoms: new Map(),
        entityOverrides: new Map(),
      }),
    skeleton: () => Promise.resolve({}),
  } as unknown as PermissionResolver;
  const loader = {
    load: () => Promise.resolve(new RawSchemaModel(model)),
  } as unknown as SchemaLoader;

  const engine = {
    id: 'postgresql',
    capabilities: { queryLanguage: { lineComment: '--' }, exportFormats: [] },
  } as unknown as EngineDefinition;
  const registry = { get: () => engine } as unknown as EngineRegistry;

  const put = vi.fn(over.put ?? (() => Promise.resolve()));
  const storage = { put } as unknown as StorageService;

  const send = vi.fn(() => Promise.resolve());
  const notifications = {
    send,
    projectUrl: () => Promise.resolve('/acme/p/prj'),
  } as unknown as NotificationsService;

  return {
    processor: new ExportProcessor(
      prisma,
      loader,
      visibility,
      resolver,
      registry,
      storage,
      notifications,
    ),
    updates,
    put,
    redactModel,
    send,
  };
}

describe('ExportProcessor', () => {
  it('goes through VisibilityFilter — the renderer never sees a raw model', async () => {
    const h = harness();
    await h.processor.run(DATA);

    expect(h.redactModel).toHaveBeenCalledTimes(1);
    const [, subject, projectId] = h.redactModel.mock.calls[0] ?? [];
    // Resolved from the payload AT RUN TIME, so a revoked grant is honoured.
    expect(subject).toEqual(DATA.subject);
    expect(projectId).toBe(PROJECT);
  });

  it('re-checks export:run when the job runs, so a grant revoked in the queue stops it', async () => {
    const h = harness({ atoms: ['schema:view'] });
    await expect(h.processor.run(DATA)).rejects.toThrow('export_access_revoked');
    expect(h.put).not.toHaveBeenCalled();
    expect(h.updates.at(-1)?.data).toMatchObject({ status: 'failed' });
  });

  it('writes the artifact to S3 under the job key and records the row', async () => {
    const h = harness();
    const result = await h.processor.run(DATA);

    const [key, body, contentType] = h.put.mock.calls[0] ?? [];
    expect(key).toBe(`exports/${PROJECT}/exj_1.json`);
    expect(contentType).toBe('application/json; charset=utf-8');
    expect(body).toBeInstanceOf(Buffer);

    expect(result).toMatchObject({ storageKey: key, sizeBytes: body?.byteLength });
    expect(h.updates.map((u) => u.data.status)).toEqual(['running', 'done']);
    expect(h.updates[1]?.where.id).toBe('exj_1');
    expect(h.updates[1]?.data).toMatchObject({ storageKey: key, error: null });
  });

  it('sets an expiry, so the bucket lifecycle rule can sweep the artifact', async () => {
    const before = Date.now();
    const h = harness();
    await h.processor.run(DATA);

    const expiresAt = h.updates[1]?.data.expiresAt;
    expect(expiresAt).toBeInstanceOf(Date);
    expect((expiresAt as Date).getTime()).toBeGreaterThanOrEqual(before + EXPORT_ARTIFACT_TTL_MS);
  });

  it('writes the object BEFORE the row says done', async () => {
    const h = harness({ put: () => Promise.reject(new Error('bucket gone')) });

    await expect(h.processor.run(DATA)).rejects.toThrow('bucket gone');
    expect(h.updates.map((u) => u.data.status)).toEqual(['running', 'failed']);
    expect(h.updates[1]?.data.error).toBe('bucket gone');
  });

  it('rethrows so BullMQ applies the retry policy', async () => {
    const h = harness({ put: () => Promise.reject(new Error('transient')) });
    await expect(h.processor.run(DATA)).rejects.toThrow('transient');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('tells the requester once the artifact is done — by format, never by schema name', async () => {
    const h = harness();
    await h.processor.run(DATA);

    expect(h.send).toHaveBeenCalledWith([
      expect.objectContaining({
        userId: 'usr_ana',
        organizationId: 'org_acme',
        type: 'export.ready',
        title: 'Your ir-json export is ready',
        data: { exportJobId: 'exj_1', format: 'ir-json' },
      }),
    ]);
  });
});
