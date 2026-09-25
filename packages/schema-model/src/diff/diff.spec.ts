import { describe, expect, it } from 'vitest';
import {
  area,
  byId,
  constraint,
  customType,
  entity,
  field,
  index,
  link,
  model,
  namespace,
} from '../fixtures.js';
import type { SchemaModel } from '../model.js';
import { diffModels } from './diff-models.js';
import { opsFromDiff, RedactedDiffError } from './ops-from-diff.js';
import { entriesByEntity, entriesOfType, isEmptyDiff } from './selectors.js';
import type { DiffEntry, SchemaDiff } from './types.js';

// ── a small model with one of every object type ──────────────────────────────────────

function base(): SchemaModel {
  return model({
    area: byId([area('ar1', 'Billing')]),
    namespace: byId([namespace('ns1', 'public')]),
    customType: byId([customType('ct1', 'order_status', 'ns1')]),
    entity: byId([entity('e1', 'orders', 'ns1'), entity('e2', 'customers', 'ns1')]),
    field: byId([
      field('f1', 'id', 'e1', { ordinal: 0 }),
      field('f2', 'customer_id', 'e1', { ordinal: 1 }),
      field('f3', 'id', 'e2', { ordinal: 0 }),
    ]),
    constraint: byId([constraint('c1', 'orders_pkey', 'e1', { kind: 'primaryKey', fieldIds: ['f1'] })]),
    index: byId([index('i1', 'idx_orders_customer', 'e1')]),
    link: byId([
      link('l1', 'fk_orders_customer', 'e1', 'e2', {
        from: { entityId: 'e1', fieldIds: ['f2'] },
        to: { entityId: 'e2', fieldIds: ['f3'] },
      }),
    ]),
  });
}

/** Rebuild a model with its collections' key insertion order reversed. */
function shuffled(m: SchemaModel): SchemaModel {
  const objects = Object.fromEntries(
    Object.entries(m.objects).map(([type, collection]) => [
      type,
      Object.fromEntries(Object.entries(collection).reverse()),
    ]),
  ) as SchemaModel['objects'];
  return { ...m, objects };
}

function entryFor(diff: SchemaDiff, id: string): DiffEntry {
  const found = diff.entries.find((e) => e.id === id);
  expect(found, `no entry for ${id}`).toBeDefined();
  return found!;
}

function pathsOf(entry: DiffEntry): string[] {
  return entry.change === 'changed' ? entry.properties.map((p) => p.path.join('.')) : [];
}

// ── the empty case ───────────────────────────────────────────────────────────────────

describe('diffModels — identical models', () => {
  it('produces no entries and an all-zero summary', () => {
    const diff = diffModels(base(), base());
    expect(diff.entries).toEqual([]);
    expect(diff.summary.added).toBe(0);
    expect(diff.summary.removed).toBe(0);
    expect(diff.summary.changed).toBe(0);
    expect(diff.summary.destructive).toBe(0);
    expect(diff.summary.byObjectType.entity).toEqual({ added: 0, removed: 0, changed: 0 });
  });

  it('isEmptyDiff agrees, with and without ignoreCosmetic', () => {
    const diff = diffModels(base(), base());
    expect(isEmptyDiff(diff)).toBe(true);
    expect(isEmptyDiff(diff, { ignoreCosmetic: true })).toBe(true);
  });

  it('carries the header fields §7.2 requires', () => {
    const diff = diffModels(base(), base(), {
      from: { kind: 'snapshot', id: 'snp1', label: 'v3', capturedAt: '2024-01-01T00:00:00.000Z' },
      to: { kind: 'live' },
    });
    expect(diff.irVersion).toBe(1);
    expect(diff.engineId).toBe('postgresql');
    expect(diff.from.label).toBe('v3');
    expect(diff.to.kind).toBe('live');
    expect(diff.redacted).toBe(false);
  });
});

// ── classification ───────────────────────────────────────────────────────────────────

describe('diffModels — classification per object type', () => {
  it('reports an added object', () => {
    const after = base();
    after.objects.field.f9 = field('f9', 'total', 'e1', { ordinal: 2 });
    const diff = diffModels(base(), after);

    expect(diff.summary.added).toBe(1);
    expect(diff.summary.byObjectType.field.added).toBe(1);
    const entry = entryFor(diff, 'f9');
    expect(entry.change).toBe('added');
    expect(entry.objectType).toBe('field');
    expect(entry.ownerEntityId).toBe('e1');
  });

  it('reports a removed object', () => {
    const after = base();
    delete after.objects.index.i1;
    const diff = diffModels(base(), after);

    expect(diff.summary.removed).toBe(1);
    expect(diff.summary.byObjectType.index.removed).toBe(1);
    expect(entryFor(diff, 'i1').change).toBe('removed');
  });

  it('reports a changed object with its property paths', () => {
    const after = base();
    after.objects.field.f2 = field('f2', 'customer_id', 'e1', {
      ordinal: 1,
      isNullable: true,
    });
    const diff = diffModels(base(), after);

    expect(diff.summary.changed).toBe(1);
    const entry = entryFor(diff, 'f2');
    expect(entry.change).toBe('changed');
    expect(pathsOf(entry)).toEqual(['isNullable']);
    if (entry.change === 'changed') {
      expect(entry.matchedBy).toBe('id');
      expect(entry.properties[0]?.severity).toBe('structural');
      expect(entry.properties[0]?.before).toBe(false);
      expect(entry.properties[0]?.after).toBe(true);
      expect(entry.properties[0]?.destructive).toBeUndefined();
    }
  });

  it('never diffs version, refs or the redaction marks', () => {
    const after = base();
    after.objects.entity.e1 = entity('e1', 'orders', 'ns1', {
      version: 99,
      refs: { entityIds: ['e2'], fieldIds: [] },
      propsRedacted: true,
    });
    expect(diffModels(base(), after).entries).toEqual([]);
  });

  it('an unpinned rename is a drop plus an add, never a rename guess', () => {
    const after = base();
    delete after.objects.entity.e1;
    after.objects.entity.e9 = entity('e9', 'purchase_orders', 'ns1');
    const diff = diffModels(base(), after, { matchStrategy: 'logical' });

    // 'orders' sorts before 'purchase_orders'; both entries are present, neither is a guess.
    expect(entriesOfType(diff, 'entity').map((e) => [e.id, e.change])).toEqual([
      ['e1', 'removed'],
      ['e9', 'added'],
    ]);
  });
});

// ── ordering and determinism ─────────────────────────────────────────────────────────

describe('diffModels — deterministic output', () => {
  it('orders entries by sortPath: type rank first, nested fields under their parent', () => {
    const before = model({ namespace: byId([namespace('ns1', 'public')]) });
    const after = model({
      namespace: byId([namespace('ns1', 'public')]),
      entity: byId([entity('e1', 'orders', 'ns1')]),
      field: byId([
        field('fb', 'b_root', 'e1', { ordinal: 1 }),
        field('fa', 'a_root', 'e1', { ordinal: 0 }),
        field('fc', 'child', 'e1', { ordinal: 0, parentFieldId: 'fb' }),
      ]),
    });
    const diff = diffModels(before, after);

    expect(diff.entries.map((e) => e.id)).toEqual(['e1', 'fa', 'fb', 'fc']);
    expect(diff.entries.map((e) => e.sortPath)).toEqual([
      '03/public///orders/e1',
      '04/public/orders/0000/a_root/fa',
      '04/public/orders/0001/b_root/fb',
      // A child must sort immediately UNDER its parent: `0001` is a strict prefix of
      // `00010000`, and the next byte is `/` (0x2F) against `0` (0x30).
      '04/public/orders/00010000/child/fc',
    ]);
  });

  it('is stable when the inputs are shuffled', () => {
    const after = base();
    after.objects.field.f9 = field('f9', 'total', 'e1', { ordinal: 2 });
    delete after.objects.index.i1;

    const straight = diffModels(base(), after);
    const jumbled = diffModels(shuffled(base()), shuffled(after));
    expect(JSON.stringify(jumbled)).toBe(JSON.stringify(straight));
  });

  it('is byte-identical across repeated runs', () => {
    const after = base();
    after.objects.entity.e1 = entity('e1', 'orders', 'ns1', {
      engineProps: { partitionBy: 'range', storage: { fillfactor: 70 } },
      position: { x: 40, y: 0 },
    });
    const once = JSON.stringify(diffModels(base(), after));
    for (let i = 0; i < 5; i++) {
      expect(JSON.stringify(diffModels(base(), after))).toBe(once);
    }
  });

  it('percent-encodes every segment so a name cannot forge a separator', () => {
    const after = model({
      namespace: byId([namespace('ns1', 'a/b')]),
      entity: byId([entity('e1', 'c/d', 'ns1')]),
    });
    const diff = diffModels(model(), after);
    expect(entryFor(diff, 'e1').sortPath).toBe('03/a%2Fb///c%2Fd/e1');
  });
});

// ── severity, and the governance guarantee ───────────────────────────────────────────

describe('severity', () => {
  it('classifies a geometry move as cosmetic and drops it under ignoreCosmetic', () => {
    const after = base();
    after.objects.entity.e1 = entity('e1', 'orders', 'ns1', { position: { x: 20, y: 0 } });

    const kept = diffModels(base(), after);
    expect(pathsOf(entryFor(kept, 'e1'))).toEqual(['position.x']);
    const entry = kept.entries[0];
    expect(entry?.change === 'changed' && entry.properties[0]?.severity).toBe('cosmetic');

    const filtered = diffModels(base(), after, { ignoreCosmetic: true });
    expect(filtered.entries).toEqual([]);
    expect(isEmptyDiff(kept, { ignoreCosmetic: true })).toBe(true);
  });

  it('a governance-only change SURVIVES ignoreCosmetic', () => {
    const after = base();
    after.objects.field.f2 = field('f2', 'customer_id', 'e1', {
      ordinal: 1,
      isRestricted: true,
      isPii: true,
    });
    after.objects.entity.e1 = entity('e1', 'orders', 'ns1', { areaId: 'ar1' });

    const diff = diffModels(base(), after, { ignoreCosmetic: true });
    expect(pathsOf(entryFor(diff, 'f2'))).toEqual(['isPii', 'isRestricted']);
    expect(pathsOf(entryFor(diff, 'e1'))).toEqual(['areaId']);
    const severities = diff.entries.flatMap((e) =>
      e.change === 'changed' ? e.properties.map((p) => p.severity) : [],
    );
    expect(severities).toEqual(['governance', 'governance', 'governance']);
  });

  it('separates the two ordinals: a field is structural, an area is cosmetic', () => {
    const after = base();
    after.objects.field.f2 = field('f2', 'customer_id', 'e1', { ordinal: 5 });
    after.objects.area.ar1 = area('ar1', 'Billing', { ordinal: 5 });

    const diff = diffModels(base(), after, { ignoreCosmetic: true });
    expect(diff.entries.map((e) => e.id)).toEqual(['f2']);
  });

  it('treats doc and isDeprecated as documentation', () => {
    const after = base();
    after.objects.field.f2 = field('f2', 'customer_id', 'e1', {
      ordinal: 1,
      isDeprecated: true,
    });
    const entry = entryFor(diffModels(base(), after), 'f2');
    expect(entry.change === 'changed' && entry.properties[0]?.severity).toBe('documentation');
  });
});

// ── engineProps and link endpoints ───────────────────────────────────────────────────

describe('engineProps and endpoints', () => {
  it('reports an engineProps change with its full path, as structural', () => {
    const after = base();
    after.objects.field.f1 = field('f1', 'id', 'e1', {
      ordinal: 0,
      engineProps: { identity: { always: true } },
    });
    const before = base();
    before.objects.field.f1 = field('f1', 'id', 'e1', {
      ordinal: 0,
      engineProps: { identity: { always: false } },
    });

    const entry = entryFor(diffModels(before, after), 'f1');
    expect(pathsOf(entry)).toEqual(['engineProps.identity.always']);
    if (entry.change === 'changed') {
      expect(entry.properties[0]?.severity).toBe('structural');
      expect(entry.properties[0]?.before).toBe(false);
      expect(entry.properties[0]?.after).toBe(true);
    }
  });

  it('treats a missing key and an undefined value as the same thing', () => {
    const before = base();
    before.objects.entity.e2 = entity('e2', 'customers', 'ns1', { engineProps: {} });
    const after = base();
    after.objects.entity.e2 = entity('e2', 'customers', 'ns1', {
      engineProps: { unlogged: undefined },
    });
    expect(diffModels(before, after).entries).toEqual([]);
  });

  it('detects a link endpoint change by position', () => {
    const after = base();
    after.objects.field.f4 = field('f4', 'tenant_id', 'e1', { ordinal: 2 });
    after.objects.field.f5 = field('f5', 'tenant_id', 'e2', { ordinal: 1 });
    after.objects.link.l1 = link('l1', 'fk_orders_customer', 'e1', 'e2', {
      from: { entityId: 'e1', fieldIds: ['f2', 'f4'] },
      to: { entityId: 'e2', fieldIds: ['f3', 'f5'] },
    });

    const entry = entryFor(diffModels(base(), after), 'l1');
    expect(pathsOf(entry)).toEqual(['from.fieldIds.1', 'to.fieldIds.1']);
    expect(entry.ownerEntityId).toBe('e1');
  });

  it('reports a re-pointed endpoint entity as structural', () => {
    const after = base();
    after.objects.link.l1 = link('l1', 'fk_orders_customer', 'e1', 'e1', {
      from: { entityId: 'e1', fieldIds: ['f2'] },
      to: { entityId: 'e1', fieldIds: ['f1'] },
    });
    expect(pathsOf(entryFor(diffModels(base(), after), 'l1'))).toEqual([
      'to.entityId',
      'to.fieldIds.0',
    ]);
  });

  it('groups entity-owned entries under their entity', () => {
    const after = base();
    after.objects.field.f2 = field('f2', 'customer_id', 'e1', { ordinal: 1, isNullable: true });
    after.objects.index.i1 = index('i1', 'idx_orders_customer', 'e1', { isUnique: true });

    const grouped = entriesByEntity(diffModels(base(), after));
    expect([...(grouped.get('e1') ?? [])].map((e) => e.id)).toEqual(['f2', 'i1']);
  });
});

// ── matching ─────────────────────────────────────────────────────────────────────────

describe('matching', () => {
  it('prefers id over logical key', () => {
    // Two entities swap names. Id matching pairs each with itself, so both report a
    // `name` change rather than pairing across by logical key.
    const after = base();
    after.objects.entity.e1 = entity('e1', 'customers', 'ns1');
    after.objects.entity.e2 = entity('e2', 'orders', 'ns1');

    const diff = diffModels(base(), after);
    const entries = entriesOfType(diff, 'entity');
    expect(entries.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
    for (const entry of entries) {
      expect(entry.change).toBe('changed');
      if (entry.change === 'changed') expect(entry.matchedBy).toBe('id');
      expect(pathsOf(entry)).toEqual(['name']);
    }
  });

  it('falls back to logical key when ids differ across snapshots', () => {
    // C8's hard delete minted a new cuid for the same logical entity.
    const after = base();
    delete after.objects.entity.e2;
    after.objects.entity.e9 = entity('e9', 'customers', 'ns1', { kind: 'view' });
    after.objects.field.f3 = field('f3', 'id', 'e9', { ordinal: 0 });
    after.objects.link.l1 = link('l1', 'fk_orders_customer', 'e1', 'e9', {
      from: { entityId: 'e1', fieldIds: ['f2'] },
      to: { entityId: 'e9', fieldIds: ['f3'] },
    });

    const entry = entryFor(diffModels(base(), after), 'e9');
    expect(entry.change).toBe('changed');
    if (entry.change === 'changed') expect(entry.matchedBy).toBe('logicalKey');
    expect(pathsOf(entry)).toEqual(['kind']);
  });

  it('leaves both sides unmatched when a logical key collides', () => {
    const before = model({
      namespace: byId([namespace('ns1', 'public')]),
      entity: byId([entity('a1', 'dup', 'ns1'), entity('a2', 'dup', 'ns1')]),
    });
    const after = model({
      namespace: byId([namespace('ns1', 'public')]),
      entity: byId([entity('b1', 'dup', 'ns1')]),
    });
    const changes = entriesOfType(diffModels(before, after), 'entity').map((e) => e.change);
    expect(changes.sort()).toEqual(['added', 'removed', 'removed']);
  });

  it('applies a pinned rename as exactly one changed entry, name change included', () => {
    const after = base();
    delete after.objects.entity.e1;
    after.objects.entity.e9 = entity('e9', 'purchase_orders', 'ns1', { kind: 'view' });

    const diff = diffModels(base(), after, {
      pinnedRenames: [{ objectType: 'entity', removedId: 'e1', addedId: 'e9' }],
    });
    const entries = entriesOfType(diff, 'entity');
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.change).toBe('changed');
    if (entry?.change === 'changed') {
      expect(entry.matchedBy).toBe('pinned');
      expect(entry.properties.map((p) => p.path.join('.'))).toEqual(['kind', 'name']);
    }
  });

  it('a pinned pair overrides a pairing pass 2 already made', () => {
    const before = model({
      namespace: byId([namespace('ns1', 'public')]),
      entity: byId([entity('e1', 'orders', 'ns1')]),
    });
    const after = model({
      namespace: byId([namespace('ns1', 'public')]),
      entity: byId([entity('e8', 'orders', 'ns1'), entity('e9', 'purchase_orders', 'ns1')]),
    });

    // Logical key would pair e1 with e8. The human said e1 became e9.
    const diff = diffModels(before, after, {
      matchStrategy: 'logical',
      pinnedRenames: [{ objectType: 'entity', removedId: 'e1', addedId: 'e9' }],
    });
    const entries = new Map(entriesOfType(diff, 'entity').map((e) => [e.id, e]));
    const pinned = entries.get('e9');
    expect(pinned?.change).toBe('changed');
    if (pinned?.change === 'changed') expect(pinned.matchedBy).toBe('pinned');
    expect(entries.get('e8')?.change).toBe('added');
    expect(entries.has('e1')).toBe(false);
  });

  it('folds identifiers through normalizeName', () => {
    const before = model({
      namespace: byId([namespace('ns1', 'public')]),
      entity: byId([entity('e1', 'Orders', 'ns1')]),
    });
    const after = model({
      namespace: byId([namespace('ns2', 'PUBLIC')]),
      entity: byId([entity('e2', 'orders', 'ns2')]),
    });
    const lower = (s: string): string => s.toLowerCase();

    expect(diffModels(before, after, { matchStrategy: 'logical' }).summary.changed).toBe(0);
    const folded = diffModels(before, after, {
      matchStrategy: 'logical',
      normalizeName: lower,
    });
    expect(folded.summary.changed).toBe(2);
    expect(folded.summary.added + folded.summary.removed).toBe(0);
  });
});

// ── the dangerous one ────────────────────────────────────────────────────────────────

describe('opsFromDiff', () => {
  it('THROWS on a redacted diff', () => {
    const before = { ...base(), redacted: true };
    const diff = diffModels(before, base());
    expect(diff.redacted).toBe(true);
    expect(() => opsFromDiff(diff, base())).toThrow(RedactedDiffError);
  });

  it('THROWS when the live model is redacted, even if the diff is not', () => {
    const diff = diffModels(base(), base());
    expect(diff.redacted).toBe(false);
    expect(() => opsFromDiff(diff, { ...base(), redacted: true })).toThrow(RedactedDiffError);
  });

  it('emits create / update / delete against the live versions', () => {
    const live = base();
    live.objects.index.i1 = index('i1', 'idx_orders_customer', 'e1', { version: 7 });
    const snapshot = base();
    snapshot.objects.index.i1 = index('i1', 'idx_orders_customer', 'e1', { isUnique: true });
    delete snapshot.objects.constraint.c1;
    snapshot.objects.field.f9 = field('f9', 'total', 'e1', { ordinal: 2 });

    const ops = opsFromDiff(diffModels(live, snapshot), live);
    expect(ops).toEqual(
      expect.arrayContaining([
        { op: 'create', type: 'field', object: snapshot.objects.field.f9 },
        { op: 'delete', type: 'constraint', id: 'c1', expectedVersion: 1 },
        {
          op: 'update',
          type: 'index',
          id: 'i1',
          object: snapshot.objects.index.i1,
          expectedVersion: 7,
        },
      ]),
    );
    expect(ops).toHaveLength(3);
  });

  it('throws when the diff was not computed against this live model', () => {
    const snapshot = base();
    delete snapshot.objects.index.i1;
    const diff = diffModels(base(), snapshot);
    const live = base();
    delete live.objects.index.i1;
    expect(() => opsFromDiff(diff, live)).toThrow(/not in the live model/);
  });
});
