import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Area } from '../area.js';
import type { Entity } from '../entity.js';
import type { Field } from '../field.js';
import type { Id } from '../ids.js';
import type { Index } from '../ir-index.js';
import type { Link } from '../link.js';
import { emptyCollections, type SchemaModel } from '../model.js';
import type { Namespace } from '../namespace.js';
import { RawSchemaModel } from './brand.js';
import { fieldVisibility, type RestrictedFieldMode, type VisibilityContext } from './context.js';
import { redact } from './redact.js';

/**
 * Doc 05 §11.3, P2 / P4 / P9 — the properties that catch the leak nobody thought of.
 *
 * A hand-written redaction test asserts the case its author imagined. These assert the
 * SHAPE of every output over randomly generated worlds, which is the only kind of test
 * that keeps covering L1–L6 when someone adds a tenth field to the IR.
 *
 * Every user-authored string in a generated model is a DISTINCTIVE TOKEN (`zzq-fd-0007`,
 * fixed width so one token is never a substring of another). The soundness property is
 * then a substring search over `JSON.stringify(redact(...))` with no false positives:
 * either a name the subject may not see is somewhere in those bytes, or it is not.
 *
 * Index, constraint and link names deliberately EMBED the token of the field they
 * reference (`idx-zzq-fd-0007`) and declare it in `refs`, because that is the real
 * L2/L3 leak: `idx_employees_salary` names a hidden column without containing its id,
 * and a derived name is how it escapes. Entity `engineProps.viewDefinition` embeds one
 * too, for R27 / L5.
 */

const NS_DEFAULT = 'ns_def';
const NS_SECRET = 'ns_sec';

// ---------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------

const pad = (n: number): string => String(n).padStart(4, '0');
const entityToken = (i: number): string => `zzq-en-${pad(i)}`;
const fieldToken = (i: number): string => `zzq-fd-${pad(i)}`;
const typeToken = (i: number): string => `zzq-ty-${pad(i)}`;
const areaToken = (i: number): string => `zzq-ar-${pad(i)}`;
const docToken = (kind: string, i: number): string => `zzq-doc-${kind}-${pad(i)}`;
const NS_SECRET_TOKEN = 'zzq-ns-0001';

// ---------------------------------------------------------------------------------------
// Generated worlds
// ---------------------------------------------------------------------------------------

interface WorldSpec {
  readonly entityCount: number;
  readonly areaCount: number;
  readonly areaOf: readonly number[];
  readonly inSecretNs: readonly boolean[];
  readonly fieldCounts: readonly number[];
  readonly restrictedSeed: readonly boolean[];
  readonly nestSeed: readonly boolean[];
  readonly visible: readonly boolean[];
  readonly restrictedOk: readonly boolean[];
  readonly areaHasAtoms: readonly boolean[];
  readonly mode: RestrictedFieldMode;
  readonly linkPairs: readonly (readonly [number, number])[];
}

const MAX_FIELDS = 3;

const worldSpecArb: fc.Arbitrary<WorldSpec> = fc
  .record({
    entityCount: fc.integer({ min: 1, max: 4 }),
    areaCount: fc.integer({ min: 0, max: 2 }),
  })
  .chain(({ entityCount, areaCount }) => {
    const perEntity = { minLength: entityCount, maxLength: entityCount };
    const perField = { minLength: entityCount * MAX_FIELDS, maxLength: entityCount * MAX_FIELDS };
    const areaSlots = { minLength: Math.max(areaCount, 1), maxLength: Math.max(areaCount, 1) };
    return fc.record<WorldSpec>({
      entityCount: fc.constant(entityCount),
      areaCount: fc.constant(areaCount),
      // -1 = no area.
      areaOf: fc.array(fc.integer({ min: -1, max: areaCount - 1 }), perEntity),
      inSecretNs: fc.array(fc.boolean(), perEntity),
      fieldCounts: fc.array(fc.integer({ min: 1, max: MAX_FIELDS }), perEntity),
      restrictedSeed: fc.array(fc.boolean(), perField),
      nestSeed: fc.array(fc.boolean(), perField),
      visible: fc.array(fc.boolean(), perEntity),
      restrictedOk: fc.array(fc.boolean(), perEntity),
      areaHasAtoms: fc.array(fc.boolean(), areaSlots),
      mode: fc.constantFrom<RestrictedFieldMode>('mask', 'hide'),
      linkPairs: fc.array(
        fc.tuple(
          fc.integer({ min: 0, max: entityCount - 1 }),
          fc.integer({ min: 0, max: entityCount - 1 }),
        ),
        { minLength: 0, maxLength: 3 },
      ),
    });
  });

interface World {
  readonly model: SchemaModel;
  readonly ctx: VisibilityContext;
}

/** One deterministic IR + context out of one generated spec. No randomness in here. */
function buildWorld(spec: WorldSpec, over: Partial<VisibilityContext> = {}): World {
  const namespace: Record<Id, Namespace> = {
    [NS_DEFAULT]: {
      id: NS_DEFAULT,
      name: 'public',
      version: 1,
      engineProps: {},
      isDefault: true,
    },
    [NS_SECRET]: {
      id: NS_SECRET,
      name: NS_SECRET_TOKEN,
      version: 1,
      engineProps: {},
      isDefault: false,
    },
  };

  const area: Record<Id, Area> = {};
  for (let a = 0; a < spec.areaCount; a += 1) {
    area[`ar_${pad(a)}`] = {
      id: `ar_${pad(a)}`,
      name: areaToken(a),
      version: 1,
      engineProps: {},
      color: 'indigo',
      ordinal: a,
      doc: { id: `dc_ar_${pad(a)}`, excerpt: docToken('ar', a) },
    };
  }

  const entity: Record<Id, Entity> = {};
  const field: Record<Id, Field> = {};
  const index: Record<Id, Index> = {};
  const link: Record<Id, Link> = {};
  /** Flat field index -> id, so links and indexes can name a specific one. */
  const firstFieldOf: string[] = [];

  let flat = 0;
  for (let e = 0; e < spec.entityCount; e += 1) {
    const entityId = `en_${pad(e)}`;
    const areaIndex = spec.areaOf[e] ?? -1;
    const count = spec.fieldCounts[e] ?? 1;

    const ids: string[] = [];
    let topOrdinal = 0;
    let nestedOrdinal = 0;
    for (let f = 0; f < count; f += 1) {
      const fieldId = `fd_${pad(flat)}`;
      const nested = f > 0 && (spec.nestSeed[flat] ?? false);
      field[fieldId] = {
        id: fieldId,
        name: fieldToken(flat),
        version: 1,
        engineProps: { comment: `note-${fieldToken(flat)}` },
        entityId,
        parentFieldId: nested ? (ids[0] ?? null) : null,
        ordinal: nested ? nestedOrdinal : topOrdinal,
        type: { name: typeToken(flat) },
        isNullable: true,
        isRestricted: spec.restrictedSeed[flat] ?? false,
        isPii: false,
        isDeprecated: false,
        doc: { id: `dc_fd_${pad(flat)}`, excerpt: docToken('fd', flat) },
      };
      if (nested) nestedOrdinal += 1;
      else topOrdinal += 1;
      ids.push(fieldId);
      flat += 1;
    }
    const anchorField = ids[0] ?? '';
    const anchorFlat = Number(anchorField.slice(3));
    firstFieldOf.push(anchorField);

    entity[entityId] = {
      id: entityId,
      name: entityToken(e),
      version: 1,
      // L5 — a view body that names a column in plain text. `refs` declares it, so R27
      // can blank the whole prop without ever parsing the string.
      engineProps: { viewDefinition: `select ${fieldToken(anchorFlat)} from t` },
      refs: { entityIds: [], fieldIds: [anchorField] },
      namespaceId: (spec.inSecretNs[e] ?? false) ? NS_SECRET : NS_DEFAULT,
      kind: 'table',
      areaId: areaIndex >= 0 ? `ar_${pad(areaIndex)}` : null,
      position: { x: e * 100, y: 0 },
      color: null,
      doc: { id: `dc_en_${pad(e)}`, excerpt: docToken('en', e) },
    };

    // L3 — an index whose NAME is derived from the column it covers.
    index[`ix_${pad(e)}`] = {
      id: `ix_${pad(e)}`,
      name: `idx-${fieldToken(anchorFlat)}`,
      version: 1,
      engineProps: { where: `${fieldToken(anchorFlat)} > 0` },
      refs: { entityIds: [], fieldIds: [anchorField] },
      entityId,
      kind: 'btree',
      isUnique: false,
      columns: [
        { ordinal: 0, fieldId: anchorField, expression: null, role: 'key', engineProps: {} },
      ],
    };
  }

  for (const [i, pair] of spec.linkPairs.entries()) {
    const [from, to] = pair;
    if (from === to) continue;
    const fromId = `en_${pad(from)}`;
    const toId = `en_${pad(to)}`;
    const fromField = firstFieldOf[from] ?? '';
    const toField = firstFieldOf[to] ?? '';
    link[`lk_${pad(i)}`] = {
      id: `lk_${pad(i)}`,
      // L2 — an FK name derived from both columns it joins.
      name: `fk-${fieldToken(Number(fromField.slice(3)))}-${fieldToken(Number(toField.slice(3)))}`,
      version: 1,
      engineProps: { onDelete: 'cascade' },
      refs: { entityIds: [], fieldIds: [fromField, toField] },
      kind: 'foreignKey',
      from: { entityId: fromId, fieldIds: [fromField] },
      to: { entityId: toId, fieldIds: [toField] },
      cardinality: 'N:1',
    };
  }

  const model: SchemaModel = {
    irVersion: 1,
    projectId: 'prj_1',
    engineId: 'postgresql',
    engineVersion: '16',
    redacted: false,
    objects: { ...emptyCollections(), namespace, area, entity, field, index, link },
  };

  const visibleEntityIds = new Set<string>();
  const restrictedOkEntityIds = new Set<string>();
  for (let e = 0; e < spec.entityCount; e += 1) {
    if (spec.visible[e] ?? false) visibleEntityIds.add(`en_${pad(e)}`);
    if (spec.restrictedOk[e] ?? false) restrictedOkEntityIds.add(`en_${pad(e)}`);
  }
  const areasWithAtoms = new Set<string>();
  for (let a = 0; a < spec.areaCount; a += 1) {
    if (spec.areaHasAtoms[a] ?? false) areasWithAtoms.add(`ar_${pad(a)}`);
  }
  const entitiesWithRestrictedFields = new Set<string>();
  for (const f of Object.values(field)) {
    if (f.isRestricted) entitiesWithRestrictedFields.add(f.entityId);
  }

  const ctx: VisibilityContext = {
    projectId: 'prj_1',
    subjectKind: 'user',
    subjectKey: 'u:1',
    canOpenProject: true,
    visibleEntityIds,
    restrictedOkEntityIds,
    areasWithAtoms,
    restrictedFieldMode: spec.mode,
    totalEntityCount: spec.entityCount,
    entitiesWithRestrictedFields,
    ...over,
  };

  return { model, ctx };
}

// ---------------------------------------------------------------------------------------
// The oracle: every token this subject is NOT entitled to see.
// ---------------------------------------------------------------------------------------

/**
 * Derived from the CONTEXT, per §8.3 and R-2 — not from `redact`'s output, which would
 * make the property agree with itself. `fieldVisibility` is used as the field-level
 * oracle because it IS doc 05 §7.10; what this property tests is that no OTHER object
 * smuggles a string past that verdict.
 */
function forbiddenTokens(model: SchemaModel, ctx: VisibilityContext): string[] {
  const out: string[] = [];
  const fields = model.objects.field;

  for (const entity of Object.values(model.objects.entity)) {
    if (ctx.visibleEntityIds.has(entity.id)) continue;
    out.push(entity.name);
    if (entity.doc !== null) out.push(entity.doc.excerpt);
    for (const value of Object.values(entity.engineProps)) {
      if (typeof value === 'string') out.push(value);
    }
  }

  for (const f of Object.values(fields)) {
    if (fieldVisibility(ctx, fields, f) === 'full') continue;
    out.push(f.name, f.type.name);
    if (f.doc !== null) out.push(f.doc.excerpt);
    for (const value of Object.values(f.engineProps)) {
      if (typeof value === 'string') out.push(value);
    }
  }

  // R-2 — a namespace survives only if it holds a VISIBLE entity. `public` is not a
  // secret; `payroll_private` is the whole point.
  const nsWithVisible = new Set<string>();
  for (const entity of Object.values(model.objects.entity)) {
    if (ctx.visibleEntityIds.has(entity.id)) nsWithVisible.add(entity.namespaceId);
  }
  if (!nsWithVisible.has(NS_SECRET)) out.push(NS_SECRET_TOKEN);

  // §8.3 — an area survives on a visible entity OR on the subject holding an atom on it.
  const areaWithVisible = new Set<string>();
  for (const entity of Object.values(model.objects.entity)) {
    if (ctx.visibleEntityIds.has(entity.id) && entity.areaId !== null) {
      areaWithVisible.add(entity.areaId);
    }
  }
  for (const a of Object.values(model.objects.area)) {
    if (areaWithVisible.has(a.id) || ctx.areasWithAtoms.has(a.id)) continue;
    out.push(a.name);
    if (a.doc !== null) out.push(a.doc.excerpt);
  }

  return out;
}

// ---------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------

describe('P4 — no name, type or expression of a hidden object reaches the wire', () => {
  it('holds for every generated model and every generated permission map', () => {
    fc.assert(
      fc.property(worldSpecArb, (spec) => {
        const { model, ctx } = buildWorld(spec);
        const json = JSON.stringify(redact(new RawSchemaModel(model), ctx));
        for (const token of forbiddenTokens(model, ctx)) {
          expect(json.includes(token), `leaked "${token}"`).toBe(false);
        }
      }),
    );
  });

  it('a subject with no visible entity reads no name at all', () => {
    fc.assert(
      fc.property(worldSpecArb, (spec) => {
        const { model, ctx } = buildWorld(spec, {
          visibleEntityIds: new Set<string>(),
          restrictedOkEntityIds: new Set<string>(),
          areasWithAtoms: new Set<string>(),
        });
        const json = JSON.stringify(redact(new RawSchemaModel(model), ctx));
        expect(json.includes('zzq-')).toBe(false);
      }),
    );
  });

  it('a subject who cannot open the project gets an empty model, not a filtered one', () => {
    fc.assert(
      fc.property(worldSpecArb, (spec) => {
        const { model, ctx } = buildWorld(spec, { canOpenProject: false });
        const out = redact(new RawSchemaModel(model), ctx);
        expect(out.objects).toEqual(emptyCollections());
        expect(JSON.stringify(out).includes('zzq-')).toBe(false);
      }),
    );
  });
});

describe('P2 / G3 — redaction is idempotent', () => {
  it('redacting an already-redacted model changes nothing', () => {
    fc.assert(
      fc.property(worldSpecArb, (spec) => {
        const { model, ctx } = buildWorld(spec);
        const once = redact(new RawSchemaModel(model), ctx);
        const twice = redact(new RawSchemaModel(once), ctx);
        expect(twice).toEqual(once);
      }),
    );
  });
});

describe('P9 / L22 — ordinals are dense after redaction, and no parent dangles', () => {
  it('every sibling group is exactly 0..n-1 and every parentFieldId resolves', () => {
    fc.assert(
      fc.property(worldSpecArb, (spec) => {
        const { model, ctx } = buildWorld(spec);
        const out = redact(new RawSchemaModel(model), ctx);
        const survivors = out.objects.field;

        const groups = new Map<string, number[]>();
        for (const f of Object.values(survivors)) {
          // R24 — a child whose parent was dropped would be a dangling reference in mask
          // mode and an existence disclosure in hide mode.
          if (f.parentFieldId !== null) {
            expect(survivors[f.parentFieldId], `dangling parent on ${f.id}`).toBeDefined();
          }
          const key = `${f.entityId}|${f.parentFieldId ?? ''}`;
          const bucket = groups.get(key);
          if (bucket === undefined) groups.set(key, [f.ordinal]);
          else bucket.push(f.ordinal);
        }

        for (const [key, ordinals] of groups) {
          const sorted = [...ordinals].sort((a, b) => a - b);
          // The GAP is the leak: 0,1,3 says "one column is hidden, and it sat here".
          expect(sorted, `gapped sibling group ${key}`).toEqual(sorted.map((_, i) => i));
        }
      }),
    );
  });
});
