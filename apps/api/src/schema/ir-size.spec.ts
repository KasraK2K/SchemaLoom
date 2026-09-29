import type { Request } from 'express';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  VisibilityFilter,
  type PermissionResolver,
  type ProjectPermissionMap,
  type ProjectSkeleton,
} from '../access';
import { fakePrisma, type Row } from './fake-prisma';
import {
  PROJECT,
  baseStore,
  constraintColumnRow,
  constraintRow,
  entityRow,
  fieldRow,
  indexColumnRow,
  indexRow,
  linkEndpointRow,
  linkRow,
} from './fixture';
import type { GeometryWriter } from './geometry.service';
import { SchemaController } from './schema.controller';
import { SchemaLoader } from './schema-loader.service';
import type { SchemaWriter } from './schema-writer.service';

/**
 * Doc 00 Q23 / doc 01 OQ3: the IR payload for a 300-entity project, MEASURED rather than
 * estimated. Above ~1 MB gzipped the canvas query has to be paginated by area.
 *
 * The world is doc 04 §12's worst case: 300 tables, 3,000 columns, 400 links, 600 indexes
 * and constraints, and a doc on every table and column. Ids are random 25-char cuid-shaped
 * strings, because ids repeat across keys and references and sequential ones gzip far
 * better than real ones. The bytes measured are `JSON.stringify` of what the route returns.
 */

const TABLES = 300;
const COLUMNS_PER_TABLE = 10;
const LINKS = 400;
const GZIP_BUDGET = 1024 * 1024;

// Deterministic, so the numbers are comparable run to run.
// mulberry32: `Math.imul` keeps it in 32-bit integers, where a float LCG loses precision.
let seed = 42;
const rand = (): number => {
  let t = (seed = (seed + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
const cuid = (): string =>
  'c' + Array.from({ length: 24 }, () => Math.floor(rand() * 36).toString(36)).join('');

const WORDS = [
  'customer', 'order', 'invoice', 'shipment', 'payment', 'account', 'product', 'address',
  'status', 'created', 'updated', 'amount', 'currency', 'region', 'warehouse', 'supplier',
  'the', 'of', 'which', 'is', 'stored', 'when', 'a', 'record', 'changes', 'per', 'tenant',
];
const words = (n: number): string => Array.from({ length: n }, () => pick(WORDS)).join(' ');
const ident = (): string => `${pick(WORDS)}_${pick(WORDS)}_${String(Math.floor(rand() * 100))}`;
const TYPES: readonly [string, unknown[]][] = [
  ['bigint', []], ['text', []], ['varchar', [255]], ['numeric', [12, 2]],
  ['timestamptz', []], ['boolean', []], ['uuid', []], ['jsonb', []],
];

function worstCase(): { store: Record<string, Row[]>; entityIds: string[] } {
  const entity: Row[] = [];
  const field: Row[] = [];
  const constraint: Row[] = [];
  const constraintColumn: Row[] = [];
  const schemaIndex: Row[] = [];
  const schemaIndexColumn: Row[] = [];
  const link: Row[] = [];
  const linkEndpoint: Row[] = [];
  const doc: Row[] = [];
  const firstField: string[] = [];

  const docOn = (targetType: string, targetId: string): void => {
    // Longer than DOC_EXCERPT_CHARS, so the excerpt cap is what bounds it.
    doc.push({ id: cuid(), projectId: PROJECT, targetType, targetId, plainText: words(80) });
  };

  for (let t = 0; t < TABLES; t++) {
    const entityId = cuid();
    entity.push(
      entityRow(entityId, {
        name: `${ident()}_${String(t)}`,
        positionX: Math.round(rand() * 8000),
        positionY: Math.round(rand() * 6000),
      }),
    );
    docOn('entity', entityId);

    for (let c = 0; c < COLUMNS_PER_TABLE; c++) {
      const fieldId = cuid();
      const [dataType, typeArgs] = pick(TYPES);
      field.push(
        fieldRow(fieldId, entityId, {
          name: c === 0 ? 'id' : `${ident()}_${String(c)}`,
          dataType,
          typeArgs,
          position: c,
          isNullable: c !== 0,
          engineProps: c === 0 ? { identity: 'always' } : rand() < 0.3 ? { default: 'now()' } : {},
        }),
      );
      docOn('field', fieldId);
      if (c === 0) firstField.push(fieldId);
    }

    const pk = cuid();
    constraint.push(constraintRow(pk, entityId, { name: `${ident()}_pkey` }));
    constraintColumn.push(constraintColumnRow(pk, firstField[t]!));
    const ix = cuid();
    schemaIndex.push(indexRow(ix, entityId, { name: `${ident()}_idx` }));
    schemaIndexColumn.push(indexColumnRow(ix, firstField[t]!));
  }

  for (let l = 0; l < LINKS; l++) {
    const s = Math.floor(rand() * TABLES);
    const t = Math.floor(rand() * TABLES);
    const linkId = cuid();
    const source = entity[s]?.id as string;
    const target = entity[t]?.id as string;
    link.push(linkRow(linkId, source, target, { name: `${ident()}_fkey` }));
    linkEndpoint.push(linkEndpointRow(linkId, firstField[s]!, firstField[t]!));
  }

  return {
    store: baseStore({
      entity, field, constraint, constraintColumn, schemaIndex, schemaIndexColumn,
      link, linkEndpoint, doc,
    }) as Record<string, Row[]>,
    entityIds: entity.map((e) => String(e.id)),
  };
}

function controllerFor(store: Record<string, Row[]>, entityIds: string[]) {
  const skel: ProjectSkeleton = {
    generation: 1,
    areaIds: [],
    entities: entityIds.map((id) => ({ id, areaId: null })),
    entityById: new Map(entityIds.map((id) => [id, { id, areaId: null }])),
    entitiesWithRestrictedFields: new Set(),
  };
  const map: ProjectPermissionMap = {
    projectId: PROJECT,
    subjectKey: 'u:owner',
    orgRole: 'owner',
    projectAtoms: new Set(['schema:view']),
    areaAtoms: new Map(),
    entityOverrides: new Map(),
    restrictedFieldMode: 'mask',
    validUntil: Number.MAX_SAFE_INTEGER,
  };
  // The owner sees everything: the largest payload any caller can get.
  const resolver = {
    skeleton: vi.fn().mockResolvedValue(skel),
    visibleEntityIds: vi.fn().mockReturnValue(new Set(entityIds)),
    restrictedOkEntityIds: vi.fn().mockReturnValue(new Set(entityIds)),
    canOpenProject: vi.fn().mockReturnValue(true),
    atomsAt: vi.fn().mockReturnValue(new Set(['schema:view'])),
  };
  const controller = new SchemaController(
    new SchemaLoader(fakePrisma(store).client),
    new VisibilityFilter(resolver as unknown as PermissionResolver),
    resolver as unknown as PermissionResolver,
    {} as SchemaWriter,
    {} as GeometryWriter,
  );
  const req = {
    access: { projectId: PROJECT, map, skel: null },
    auth: { kind: 'user', userId: 'usr_owner', orgId: 'org_acme' },
  } as unknown as Request;
  return { controller, req };
}

describe('Q23 — IR payload size for a 300-entity project', () => {
  it(`stays under ${String(GZIP_BUDGET / 1024)} KB gzipped at doc 04 §12's worst case`, async () => {
    const { store, entityIds } = worstCase();
    const { controller, req } = controllerFor(store, entityIds);

    const model = await controller.ir(req, PROJECT);
    expect(Object.keys(model.objects.entity)).toHaveLength(TABLES);
    expect(Object.keys(model.objects.field)).toHaveLength(TABLES * COLUMNS_PER_TABLE);

    const json = Buffer.from(JSON.stringify(model));
    const gzipped = gzipSync(json).byteLength;
    const canvas = gzipSync(JSON.stringify(await controller.canvas(req, PROJECT))).byteLength;
    const kb = (n: number): string => `${(n / 1024).toFixed(0)} KB`;
    console.info(
      `Q23: /ir ${kb(json.byteLength)} raw, ${kb(gzipped)} gzipped; /ir/canvas ${kb(canvas)} gzipped`,
    );

    expect(gzipped).toBeLessThan(GZIP_BUDGET);
  });
});
