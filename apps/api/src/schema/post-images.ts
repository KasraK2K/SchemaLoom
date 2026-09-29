import {
  assembleModel,
  emptyCollections,
  type Id,
  type IrCollections,
  type IrObjectType,
  type SchemaModel,
} from '@schemaloom/schema-model';
import { readTouchedRows, type SchemaDb, type TouchedIds } from './row-read';

/**
 * Doc 04 §8.6 rule 8 / §8.4 — the `changed` half of a write result: a post-image of every
 * object the batch created, updated, or modified through a server-side cascade, ready for
 * a client to merge straight into `model.objects[type][id]`.
 *
 * Built by feeding the touched rows back through the SAME pure `assembleModel` the read
 * path uses, rather than by hand-mapping eight row shapes a second time. A post-image
 * produced by different code from the one the client loaded is a post-image that
 * eventually disagrees with it — and the disagreement surfaces as a phantom diff weeks
 * later, not as a failing test here.
 *
 * Bounded by the BATCH, never by the project: `readTouchedRows` queries by id, so a
 * one-column rename reads one row and not three thousand. That is what makes "the server
 * never rebuilds and re-sends a whole IR after a write" (§8.2) affordable.
 */
export async function postImages(
  db: SchemaDb,
  projectId: Id,
  touched: readonly { type: IrObjectType; id: Id }[],
): Promise<Partial<IrCollections>> {
  if (touched.length === 0) return {};

  const rows = await readTouchedRows(db, projectId, groupIds(touched));
  // `engineId` / `engineVersion` are copied onto the model ROOT, which is discarded here:
  // only `objects` is read. Assembly treats them as opaque strings and never branches on
  // them (§8.1), so there is no project row to fetch for this.
  const model = assembleModel({ projectId, engineId: '', engineVersion: '', rows });

  const changed = emptyCollections();
  let any = false;
  for (const t of touched) any = copyOne(model, changed, t.type, t.id) || any;
  return any ? prune(changed) : {};
}

function groupIds(touched: readonly { type: IrObjectType; id: Id }[]): TouchedIds {
  const ids: Record<IrObjectType, Set<Id>> = {
    area: new Set(),
    namespace: new Set(),
    customType: new Set(),
    entity: new Set(),
    field: new Set(),
    constraint: new Set(),
    index: new Set(),
    link: new Set(),
  };
  for (const t of touched) ids[t.type].add(t.id);
  return {
    area: [...ids.area],
    namespace: [...ids.namespace],
    customType: [...ids.customType],
    entity: [...ids.entity],
    field: [...ids.field],
    constraint: [...ids.constraint],
    index: [...ids.index],
    link: [...ids.link],
  };
}

/**
 * The lookup and the write happen in the SAME arm, so each collection's element type is
 * statically known on both sides and no cast is needed. An object that is absent was
 * deleted by a later op in the same batch — a legitimate outcome, reported through
 * `removed` instead.
 */
function copyOne(model: SchemaModel, changed: IrCollections, type: IrObjectType, id: Id): boolean {
  switch (type) {
    case 'area': {
      const o = model.objects.area[id];
      if (o === undefined) return false;
      changed.area[id] = o;
      return true;
    }
    case 'namespace': {
      const o = model.objects.namespace[id];
      if (o === undefined) return false;
      changed.namespace[id] = o;
      return true;
    }
    case 'customType': {
      const o = model.objects.customType[id];
      if (o === undefined) return false;
      changed.customType[id] = o;
      return true;
    }
    case 'entity': {
      const o = model.objects.entity[id];
      if (o === undefined) return false;
      changed.entity[id] = o;
      return true;
    }
    case 'field': {
      const o = model.objects.field[id];
      if (o === undefined) return false;
      changed.field[id] = o;
      return true;
    }
    case 'constraint': {
      const o = model.objects.constraint[id];
      if (o === undefined) return false;
      changed.constraint[id] = o;
      return true;
    }
    case 'index': {
      const o = model.objects.index[id];
      if (o === undefined) return false;
      changed.index[id] = o;
      return true;
    }
    case 'link': {
      const o = model.objects.link[id];
      if (o === undefined) return false;
      changed.link[id] = o;
      return true;
    }
  }
}

/** Only the collections that actually gained an entry: `changed` is `Partial`, and eight
 *  empty records per frame is noise on a channel that fires every 400 ms. */
function prune(changed: IrCollections): Partial<IrCollections> {
  const out: Partial<IrCollections> = {};
  if (Object.keys(changed.area).length > 0) out.area = changed.area;
  if (Object.keys(changed.namespace).length > 0) out.namespace = changed.namespace;
  if (Object.keys(changed.customType).length > 0) out.customType = changed.customType;
  if (Object.keys(changed.entity).length > 0) out.entity = changed.entity;
  if (Object.keys(changed.field).length > 0) out.field = changed.field;
  if (Object.keys(changed.constraint).length > 0) out.constraint = changed.constraint;
  if (Object.keys(changed.index).length > 0) out.index = changed.index;
  if (Object.keys(changed.link).length > 0) out.link = changed.link;
  return out;
}
