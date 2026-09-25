/**
 * Doc 04 §7.5 — the precomputed ordering key.
 *
 *     sortPath = <typeRank>/<namespace>/<entity>/<ordinalPath>/<name>/<id>
 *
 * `entries` is sorted by a plain string comparison of it, so no comparator needs the
 * model and re-sorting in the browser is free. Every segment is percent-encoded before
 * joining, so a name containing `/` cannot reorder the list. The trailing id makes the
 * sort TOTAL: two objects with identical names never swap places between renders.
 *
 *     area        00///0002/Billing/clx_area_billing
 *     namespace   01/public///public/clx_ns_public
 *     customType  02/public///order_status/clx_ct_status
 *     entity      03/public///orders/clx_ent_orders
 *     field       04/public/orders/0003/customer_id/clx_fld_cust
 *     field       04/public/orders/00030000/lat/clx_fld_lat
 *     constraint  05/public/orders//orders_pkey/clx_con_pk
 *     index       06/public/orders//idx_orders_customer/clx_idx_cust
 *     link        07/public/orders//fk_orders_customer/clx_lnk_cust
 */
import { MAX_FIELD_DEPTH } from '../constants.js';
import type { Field } from '../field.js';
import type { Id } from '../ids.js';
import { IR_OBJECT_TYPES, type IrObjectType, type SchemaModel } from '../model.js';

/** Ordinals are dense 0…n-1 (§8.6 rule 6), so four digits covers 10,000 siblings. */
function ord(value: number): string {
  return String(value).padStart(4, '0');
}

/** A reference with no object behind it. Keeps the key total without throwing —
 *  `validateModel` is what reports the dangling reference. */
function missing(id: Id): string {
  return `#${id}`;
}

function namespaceName(model: SchemaModel, namespaceId: Id): string {
  return model.objects.namespace[namespaceId]?.name ?? missing(namespaceId);
}

interface Scope {
  namespace: string;
  entity: string;
}

/** The `<namespace>/<entity>` pair every entity-owned object sorts under. */
function entityScope(model: SchemaModel, entityId: Id): Scope {
  const entity = model.objects.entity[entityId];
  if (entity === undefined) return { namespace: '', entity: missing(entityId) };
  return { namespace: namespaceName(model, entity.namespaceId), entity: entity.name };
}

/**
 * The chain of 4-digit ordinals from the ROOT field down to this one, so a child sorts
 * immediately under its parent. Revision 1 used the child's own ordinal within its parent,
 * which sorted a child at ordinal 0 ahead of its parent at ordinal 3.
 *
 * §7.5 prints this chain DOTTED (`0003.0000`), and that does not survive its own byte
 * comparison: `.` is 0x2E and the segment separator `/` is 0x2F, so `0003.0000/…` sorts
 * BEFORE `0003/…` and the child jumps ahead of the parent again — the same class of defect
 * §7.5 caught in revision 1, one mechanism along. The ordinals are fixed-width, so the dot
 * carries no information; dropping it makes a child a strict prefix-extension of its
 * parent, which is what the stated ordering needs.
 *
 * Bounded by `MAX_FIELD_DEPTH` so a `parentFieldId` cycle cannot hang the caller.
 */
function fieldOrdinalPath(model: SchemaModel, field: Field): string {
  const ordinals: string[] = [];
  let cur: Field | undefined = field;
  for (let depth = 0; cur !== undefined && depth <= MAX_FIELD_DEPTH; depth++) {
    ordinals.unshift(ord(cur.ordinal));
    cur = cur.parentFieldId === null ? undefined : model.objects.field[cur.parentFieldId];
  }
  return ordinals.join('');
}

interface Parts extends Scope {
  ordinalPath: string;
  name: string;
}

const EMPTY: Parts = { namespace: '', entity: '', ordinalPath: '', name: '' };

function partsFor(model: SchemaModel, type: IrObjectType, id: Id): Parts {
  switch (type) {
    case 'area': {
      const area = model.objects.area[id];
      if (area === undefined) return EMPTY;
      return { ...EMPTY, ordinalPath: ord(area.ordinal), name: area.name };
    }
    case 'namespace': {
      const ns = model.objects.namespace[id];
      if (ns === undefined) return EMPTY;
      return { ...EMPTY, namespace: ns.name, name: ns.name };
    }
    case 'customType': {
      const ct = model.objects.customType[id];
      if (ct === undefined) return EMPTY;
      return { ...EMPTY, namespace: namespaceName(model, ct.namespaceId), name: ct.name };
    }
    case 'entity': {
      const entity = model.objects.entity[id];
      if (entity === undefined) return EMPTY;
      return {
        ...EMPTY,
        namespace: namespaceName(model, entity.namespaceId),
        name: entity.name,
      };
    }
    case 'field': {
      const field = model.objects.field[id];
      if (field === undefined) return EMPTY;
      return {
        ...entityScope(model, field.entityId),
        ordinalPath: fieldOrdinalPath(model, field),
        name: field.name,
      };
    }
    case 'constraint': {
      const c = model.objects.constraint[id];
      if (c === undefined) return EMPTY;
      return { ...entityScope(model, c.entityId), ordinalPath: '', name: c.name };
    }
    case 'index': {
      const ix = model.objects.index[id];
      if (ix === undefined) return EMPTY;
      return { ...entityScope(model, ix.entityId), ordinalPath: '', name: ix.name };
    }
    case 'link': {
      const link = model.objects.link[id];
      if (link === undefined) return EMPTY;
      // A link sorts under its `from` entity, which is also where `ownerEntityId` puts it.
      return { ...entityScope(model, link.from.entityId), ordinalPath: '', name: link.name };
    }
  }
}

/**
 * `model` is the side whose names this entry shows: the BEFORE model for a `removed`
 * entry, the AFTER model for `added` and `changed` (§7.5).
 */
export function sortPath(model: SchemaModel, type: IrObjectType, id: Id): string {
  const rank = String(IR_OBJECT_TYPES.indexOf(type)).padStart(2, '0');
  const p = partsFor(model, type, id);
  return [rank, p.namespace, p.entity, p.ordinalPath, p.name, id]
    .map((s) => encodeURIComponent(s))
    .join('/');
}
