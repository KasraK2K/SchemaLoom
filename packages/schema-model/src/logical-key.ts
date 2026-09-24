import { MAX_FIELD_DEPTH } from './constants.js';
import type { Field } from './field.js';
import type { Id } from './ids.js';
import type { IrObject, IrObjectMap, IrObjectType, SchemaModel } from './model.js';
import { identityNormalizeName, type NormalizeName } from './normalize-name.js';

/**
 * Tag per object type. Short because these end up in diff output, import previews and
 * AI prompts, where the type is usually already obvious from context.
 */
const TAG: Record<IrObjectType, string> = {
  area: 'area',
  namespace: 'ns',
  customType: 'type',
  entity: 'ent',
  field: 'fld',
  constraint: 'con',
  index: 'idx',
  link: 'lnk',
};

/**
 * Fold, then percent-encode, so no name can contain a separator and no folding
 * difference can split what is really one object.
 *
 * `encodeURIComponent` leaves `- _ . ! ~ * ' ( )` alone; of those `.` `(` `)` are
 * separators here, so they get escaped by hand along with the other four. `-` and `_`
 * stay readable — `->` cannot be forged because `>` is escaped by `encodeURIComponent`.
 */
function seg(name: string, normalize: NormalizeName): string {
  return encodeURIComponent(normalize(name)).replace(
    /[.!~*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** A parent that is not in the model at all. Keeps the key injective without throwing —
 *  `validateModel` (§11.1) is what reports the dangling reference. */
function missing(id: Id): string {
  return `#${encodeURIComponent(id)}`;
}

function namespaceSeg(model: SchemaModel, namespaceId: Id, n: NormalizeName): string {
  const ns = model.objects.namespace[namespaceId];
  return ns === undefined ? missing(namespaceId) : seg(ns.name, n);
}

/** `<namespace>.<entity>` — the scope every entity-owned object keys under. */
function entityScope(model: SchemaModel, entityId: Id, n: NormalizeName): string {
  const entity = model.objects.entity[entityId];
  if (entity === undefined) return missing(entityId);
  return `${namespaceSeg(model, entity.namespaceId, n)}.${seg(entity.name, n)}`;
}

/**
 * Dotted name path of a field within its entity: `address.geo.lat`.
 *
 * The walk is bounded by `MAX_FIELD_DEPTH` so a `parentFieldId` cycle cannot hang the
 * caller before `FIELD_PARENT_CYCLE` finds it; a truncated key on an already-invalid
 * model is the right trade.
 */
function fieldNameSeg(model: SchemaModel, fieldId: Id, n: NormalizeName): string {
  const start = model.objects.field[fieldId];
  if (start === undefined) return missing(fieldId);

  const names: string[] = [];
  let cur: Field | undefined = start;
  for (let depth = 0; cur !== undefined && depth <= MAX_FIELD_DEPTH; depth++) {
    names.unshift(seg(cur.name, n));
    cur = cur.parentFieldId === null ? undefined : model.objects.field[cur.parentFieldId];
  }
  return names.join('.');
}

function endpointSeg(
  model: SchemaModel,
  endpoint: { entityId: Id; fieldIds: Id[] },
  n: NormalizeName,
): string {
  const fields = endpoint.fieldIds.map((id) => fieldNameSeg(model, id, n)).join(',');
  return `${entityScope(model, endpoint.entityId, n)}(${fields})`;
}

/**
 * Canonical, stable, engine-neutral string identity of an object by position in the
 * naming hierarchy (§6.1). Deterministic given (model, normalizeName).
 *
 * ```
 * area       area:Billing
 * namespace  ns:public
 * customType type:public.order_status
 * entity     ent:public.orders
 * field      fld:public.orders.address.geo.lat
 * constraint con:public.orders#primaryKey(id)
 * constraint con:public.orders#check@orders_total_positive   <- no participating fields
 * index      idx:public.orders#idx_orders_customer
 * link       lnk:public.orders(customer_id)->public.customers(id)
 * link       lnk:public.orders()->public.customers()@fk_draft <- no fields either side
 * any stub   <tag>:#<id>                                      <- restricted objects
 * ```
 *
 * THE INVARIANT: injective per object type over any valid model, redacted or not. The
 * three fallbacks exist because the obvious format is not:
 *
 * - a table-level CHECK or EXCLUDE has empty `fieldIds`, so two business-rule CHECKs on
 *   one table both keyed to `con:public.orders#check()` — ordinary PostgreSQL, hit on
 *   the first real table of the headline import workflow. Falls back to `#<kind>@<name>`,
 *   then `#<kind>#<id>` when the constraint is also unnamed;
 * - a link may have empty `fieldIds` on BOTH sides (§2.7), which is exactly the
 *   N:M-before-a-junction-table case, so two drafts between the same pair collided.
 *   Falls back to `@<name>`, then `#<id>`;
 * - a redacted stub blanks its name to `""`, so two stubbed entities in one namespace
 *   both keyed to `ent:public.`. A restricted object keys as `<tag>:#<id>` — it keeps its
 *   REAL cuid (doc 05 §7.10), which is unique by construction.
 *
 * Indexes keep their name, because two indexes on the same columns with different kinds
 * or predicates are genuinely different objects and names are how humans refer to them.
 * Areas have no parent scope, so name alone.
 *
 * An id with no object behind it keys as `<tag>:#<id>` rather than throwing.
 */
export function logicalKey(
  model: SchemaModel,
  type: IrObjectType,
  id: Id,
  normalizeName: NormalizeName = identityNormalizeName,
): string {
  const tag = TAG[type];
  const obj: IrObject | undefined = model.objects[type][id];
  if (obj === undefined || obj.restricted === true) return `${tag}:${missing(id)}`;

  const n = normalizeName;
  switch (type) {
    case 'area': {
      const area = model.objects.area[id];
      return `${tag}:${area === undefined ? missing(id) : seg(area.name, n)}`;
    }
    case 'namespace': {
      const ns = model.objects.namespace[id];
      return `${tag}:${ns === undefined ? missing(id) : seg(ns.name, n)}`;
    }
    case 'customType': {
      const ct = model.objects.customType[id];
      if (ct === undefined) return `${tag}:${missing(id)}`;
      return `${tag}:${namespaceSeg(model, ct.namespaceId, n)}.${seg(ct.name, n)}`;
    }
    case 'entity': {
      return `${tag}:${entityScope(model, id, n)}`;
    }
    case 'field': {
      const field = model.objects.field[id];
      if (field === undefined) return `${tag}:${missing(id)}`;
      return `${tag}:${entityScope(model, field.entityId, n)}.${fieldNameSeg(model, id, n)}`;
    }
    case 'constraint': {
      const c = model.objects.constraint[id];
      if (c === undefined) return `${tag}:${missing(id)}`;
      const scope = `${tag}:${entityScope(model, c.entityId, n)}#${seg(c.kind, n)}`;
      if (c.fieldIds.length > 0) {
        const fields = c.fieldIds.map((f) => fieldNameSeg(model, f, n)).join(',');
        return `${scope}(${fields})`;
      }
      return c.name === '' ? `${scope}${missing(id)}` : `${scope}@${seg(c.name, n)}`;
    }
    case 'index': {
      const ix = model.objects.index[id];
      if (ix === undefined) return `${tag}:${missing(id)}`;
      return `${tag}:${entityScope(model, ix.entityId, n)}#${seg(ix.name, n)}`;
    }
    case 'link': {
      const link = model.objects.link[id];
      if (link === undefined) return `${tag}:${missing(id)}`;
      const ends = `${endpointSeg(model, link.from, n)}->${endpointSeg(model, link.to, n)}`;
      if (link.from.fieldIds.length > 0 || link.to.fieldIds.length > 0) {
        return `${tag}:${ends}`;
      }
      return link.name === ''
        ? `${tag}:${ends}${missing(id)}`
        : `${tag}:${ends}@${seg(link.name, n)}`;
    }
  }
}

/**
 * Every object of one type, indexed by logical key — the lookup the import matcher and
 * the cross-project diff run on (§6.2).
 *
 * On a valid model the keys are injective, so nothing is lost. On an invalid one a
 * collision silently keeps the last entry; `validateModel`'s `NAME_COLLISION` is what
 * reports it, and callers that must not lose a duplicate compare `.size` against the
 * collection's key count.
 */
export function byLogicalKey<T extends IrObjectType>(
  model: SchemaModel,
  type: T,
  normalizeName: NormalizeName = identityNormalizeName,
): Map<string, IrObjectMap[T]> {
  const out = new Map<string, IrObjectMap[T]>();
  for (const id of Object.keys(model.objects[type])) {
    const obj = model.objects[type][id] as IrObjectMap[T] | undefined;
    if (obj !== undefined) out.set(logicalKey(model, type, id, normalizeName), obj);
  }
  return out;
}
