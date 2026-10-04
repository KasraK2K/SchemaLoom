import type { EngineDefinition } from '@schemaloom/engine-sdk';
import {
  assembleModel,
  type Id,
  type IrObject,
  type IrObjectType,
  type ObjectRefs,
} from '@schemaloom/schema-model';
import { readProjectRows, type SchemaDb } from './row-read';

/** The object types with a `refs` column (doc 02 D4). */
const REF_TYPES = [
  'namespace',
  'customType',
  'entity',
  'field',
  'constraint',
  'index',
  'link',
] as const satisfies readonly IrObjectType[];

const EMPTY: ObjectRefs = { entityIds: [], fieldIds: [] };
const same = (a: ObjectRefs, b: ObjectRefs): boolean =>
  JSON.stringify(a.entityIds) === JSON.stringify(b.entityIds) &&
  JSON.stringify(a.fieldIds) === JSON.stringify(b.fieldIds);

/**
 * Doc 03 §3.1 — `refs` is what `VisibilityFilter` reads to blank an expression (a default, a
 * CHECK body, a view's SQL) or a derived name that mentions something the viewer can't see.
 * The engine computes it; this persists it. Recomputed for the WHOLE project after a write,
 * because an object's refs move when another object appears, is renamed or goes away (a view
 * naming `emp` gains `emp`'s id the moment `emp` exists).
 *
 * Returns the objects whose refs changed, so their post-images reach realtime clients. No
 * version bump: nobody edited them, and bumping would fail other editors' next write.
 *
 * ponytail: reads every row of the project on each write. Fine at the sizes we see; scope it
 * to objects whose expressions name a changed name if large projects make writes slow.
 */
export async function refreshRefs(
  tx: SchemaDb,
  projectId: Id,
  engine: EngineDefinition,
): Promise<{ type: IrObjectType; id: Id }[]> {
  const rows = await readProjectRows(tx, projectId);
  const model = assembleModel({ projectId, engineId: '', engineVersion: '', rows });
  const changed: { type: IrObjectType; id: Id }[] = [];
  for (const type of REF_TYPES) {
    const bag: Readonly<Record<Id, IrObject>> = model.objects[type];
    for (const object of Object.values(bag)) {
      const subKind = 'kind' in object && type !== 'index' ? object.kind : null;
      const found = engine.extractReferences(object, subKind, model);
      const next: ObjectRefs = {
        entityIds: found.filter((r) => r.type === 'entity').map((r) => r.id),
        fieldIds: found.filter((r) => r.type === 'field').map((r) => r.id),
      };
      if (same(next, object.refs ?? EMPTY)) continue;
      await writeRefs(tx, type, projectId, object.id, next);
      changed.push({ type, id: object.id });
    }
  }
  return changed;
}

function writeRefs(
  tx: SchemaDb,
  type: (typeof REF_TYPES)[number],
  projectId: Id,
  id: Id,
  refs: ObjectRefs,
): Promise<unknown> {
  const args = { where: { id, projectId }, data: { refs: { ...refs } } };
  switch (type) {
    case 'namespace':
      return tx.namespace.updateMany(args);
    case 'customType':
      return tx.customType.updateMany(args);
    case 'entity':
      return tx.entity.updateMany(args);
    case 'field':
      return tx.field.updateMany(args);
    case 'constraint':
      return tx.constraint.updateMany(args);
    case 'index':
      return tx.schemaIndex.updateMany(args);
    case 'link':
      return tx.link.updateMany(args);
  }
}
