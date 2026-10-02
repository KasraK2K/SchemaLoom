import {
  IR_OBJECT_TYPES,
  logicalKey,
  type Field,
  type Index,
  type IrObjectType,
  type SchemaModel,
} from '@schemaloom/schema-model';
import { blobToLive, type LiveIr } from './live-ir';

export interface MergedImport {
  /** Live plus every imported object live does not already have. Never removes anything. */
  readonly model: LiveIr;
  /** Names of imported tables that already existed and were left exactly as they are. */
  readonly existing: readonly string[];
  /** The imported model with every matched object carrying its LIVE id (keys too), for
   *  the rename generator and for validating confirmed renames against. */
  readonly imported: SchemaModel;
  /** Imported id → live id, for every imported object live already had. An unmatched
   *  object is written with its imported id, so `liveIds.get(id) ?? id` is where it lives. */
  readonly liveIds: ReadonlyMap<string, string>;
}

/**
 * Doc 03 §9.2's four merge questions, answered the conservative way — ADDITIVE, LIVE WINS:
 *
 * 1. **Collision key** is `logicalKey` (§6.1): `ent:public.orders`, `fld:public.orders.id`…
 *    An imported object whose key live already has is the SAME object and is not written.
 * 2. **Docs** and 3. **positions** of existing objects are untouched, because nothing
 *    existing is updated here. The ONE exception (Phase 4 Q1) is not in this function: a
 *    rename a human CONFIRMED in the import dialog is applied as an ordinary
 *    `update { name }` through `SchemaWriter` before this merge runs, so the renamed object
 *    then matches by key. Nothing is inferred and nothing is deleted.
 * 4. **Grants and comments** stay attached to existing ids; new objects referencing an
 *    existing one are RETARGETED to its live id.
 *
 * So a re-import adds new tables, new columns on existing tables, new indexes and FKs, and
 * never deletes or rewrites — the plan built from this model is creates only. The one
 * exception to "new key → add": a second primary key on a table that already has one,
 * which no engine accepts.
 *
 * The importer mints its own default namespace; it is mapped onto the project's default
 * whatever it is called, or every entity would land in an orphan namespace.
 */
export function mergeImport(live: LiveIr, imported: SchemaModel): MergedImport {
  const liveIdOf = new Map<string, string>();
  const defaultNs = (m: SchemaModel) =>
    Object.values(m.objects.namespace).find((ns) => ns.isDefault)?.id;
  const [importedNs, liveNs] = [defaultNs(imported), defaultNs(live)];
  // Keys are computed as if the imported default namespace had the live one's name, so
  // `ent:public.orders` matches even when the project's default is called something else.
  let keyed = imported;
  if (importedNs !== undefined && liveNs !== undefined) {
    liveIdOf.set(importedNs, liveNs);
    const ns = imported.objects.namespace[importedNs];
    const name = live.objects.namespace[liveNs]?.name;
    if (ns !== undefined && name !== undefined) {
      keyed = {
        ...imported,
        objects: {
          ...imported.objects,
          namespace: { ...imported.objects.namespace, [importedNs]: { ...ns, name } },
        },
      };
    }
  }

  const existing: string[] = [];
  for (const type of IR_OBJECT_TYPES) {
    const liveKeys = new Map(
      Object.keys(live.objects[type]).map((id) => [logicalKey(live, type, id), id]),
    );
    for (const id of Object.keys(imported.objects[type])) {
      if (liveIdOf.has(id)) continue;
      const liveId = liveKeys.get(logicalKey(keyed, type, id));
      if (liveId === undefined) continue;
      liveIdOf.set(id, liveId);
      if (type === 'entity') existing.push(imported.objects.entity[id]?.name ?? id);
    }
  }

  // Retarget every reference to a matched object. Keys of the collections are object ids
  // too, but only unmatched objects are kept below, and their ids are not in the map.
  const retargeted = JSON.parse(JSON.stringify(imported), (_key, value: unknown) =>
    typeof value === 'string' ? (liveIdOf.get(value) ?? value) : value,
  ) as SchemaModel;
  // The store's write defaults (`row-write.ts`): an importer leaves "no custom type" and
  // "ascending" out, the store reads them back as `null` and `'asc'`, and the diff counts
  // absent as different (doc 04 §7.4 rule 2). Imported objects take the stored form.
  for (const field of Object.values(retargeted.objects.field) as { type: Field['type'] }[]) {
    field.type = { ...field.type, customTypeId: field.type.customTypeId ?? null };
  }
  for (const index of Object.values(retargeted.objects.index) as { columns: Index['columns'] }[]) {
    index.columns = index.columns.map((c) => ({ ...c, direction: c.direction ?? 'asc' }));
  }

  const hasPk = new Set(
    Object.values(live.objects.constraint)
      .filter((c) => c.kind === 'primaryKey')
      .map((c) => c.entityId),
  );
  // A new column on an existing table goes after the columns it already has.
  const nextOrdinal = new Map<string, number>();
  for (const field of Object.values(live.objects.field)) {
    nextOrdinal.set(
      field.entityId,
      Math.max(nextOrdinal.get(field.entityId) ?? 0, field.ordinal + 1),
    );
  }

  const objects = structuredClone(live.objects) as Record<IrObjectType, Record<string, unknown>>;
  for (const type of IR_OBJECT_TYPES) {
    for (const [id, object] of Object.entries(retargeted.objects[type])) {
      if (liveIdOf.has(id)) continue;
      if (type === 'constraint') {
        const c = retargeted.objects.constraint[id];
        if (c?.kind === 'primaryKey' && hasPk.has(c.entityId)) continue;
      }
      if (type === 'field') {
        const f = retargeted.objects.field[id];
        const base = f === undefined ? undefined : nextOrdinal.get(f.entityId);
        if (f !== undefined && base !== undefined) {
          objects.field[id] = { ...f, ordinal: base + f.ordinal };
          continue;
        }
      }
      objects[type][id] = object;
    }
  }

  const rekeyed = Object.fromEntries(
    IR_OBJECT_TYPES.map((type) => [
      type,
      Object.fromEntries(
        Object.values(retargeted.objects[type] as Record<string, { id: string }>).map((o) => [
          o.id,
          o,
        ]),
      ),
    ]),
  ) as unknown as SchemaModel['objects'];

  return {
    model: blobToLive({ ...live, objects }),
    existing,
    imported: { ...retargeted, objects: rekeyed },
    liveIds: liveIdOf,
  };
}

/** What only SchemaLoom knows about an object: no database holds it, so no import has it. */
const DESIGN_ONLY = ['doc', 'isDeprecated', 'isRestricted', 'isPii', 'areaId'] as const;

/**
 * Phase 6 §6 — drift is about the database. A database read (`mergeImport(…).imported`)
 * has no docs, PII flags or areas, so each object it shares with the design takes the
 * design's; otherwise every documented or flagged object would read as drift.
 */
export function withDesignOnly(database: SchemaModel, design: SchemaModel): SchemaModel {
  const objects = Object.fromEntries(
    IR_OBJECT_TYPES.map((type) => [
      type,
      Object.fromEntries(
        Object.entries(database.objects[type] as Record<string, Record<string, unknown>>).map(
          ([id, object]) => {
            const ours = (design.objects[type] as Record<string, Record<string, unknown>>)[id];
            if (ours === undefined) return [id, object];
            const copied = DESIGN_ONLY.filter((key) => key in object && key in ours);
            return [id, { ...object, ...Object.fromEntries(copied.map((k) => [k, ours[k]])) }];
          },
        ),
      ),
    ]),
  ) as unknown as SchemaModel['objects'];
  return { ...database, objects };
}
