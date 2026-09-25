import {
  emptyCollections,
  type Area,
  type Constraint,
  type Entity,
  type Field,
  type Id,
  type Link,
  type Namespace,
  type SchemaModel,
  type TypeRef,
} from '@schemaloom/schema-model';

/**
 * A small redacted model for the canvas tests.
 *
 * TEST-ONLY. `@schemaloom/schema-model` keeps its own fixture builders out of its public
 * exports so nothing ships in a bundle, so the canvas builds its own — deliberately tiny,
 * and deliberately `redacted: true`, because that is the ONLY kind of model this app ever
 * receives: `GET /projects/:id/ir` runs every response through `VisibilityFilter`.
 *
 * It contains one stub entity and one badge-redacted link, because those are the cases the
 * canvas gets wrong silently.
 */
const base = (id: Id, name: string) => ({ id, name, version: 1, engineProps: {} });

export const NS = 'ns_public';
export const AREA_BILLING = 'area_billing';
export const AREA_CRM = 'area_crm';
export const ORDERS = 'e_orders';
export const CUSTOMERS = 'e_customers';
export const SECRET = 'e_secret';
export const ORDER_ID = 'f_order_id';
export const ORDER_CUSTOMER_ID = 'f_order_customer_id';
export const ORDER_NOTE = 'f_order_note';
export const CUSTOMER_ID = 'f_customer_id';

const uuid: TypeRef = { name: 'uuid' };
const text: TypeRef = { name: 'text' };

function area(id: Id, name: string, ordinal: number): Area {
  return { ...base(id, name), color: 'indigo', ordinal, doc: null };
}

function namespace(id: Id, name: string): Namespace {
  return { ...base(id, name), isDefault: true };
}

function entity(id: Id, name: string, over: Partial<Entity> = {}): Entity {
  return {
    ...base(id, name),
    namespaceId: NS,
    kind: 'table',
    areaId: null,
    position: { x: 0, y: 0 },
    color: null,
    doc: null,
    ...over,
  };
}

function field(id: Id, name: string, entityId: Id, ordinal: number, type: TypeRef): Field {
  return {
    ...base(id, name),
    entityId,
    parentFieldId: null,
    ordinal,
    type,
    isNullable: false,
    isRestricted: false,
    isPii: false,
    isDeprecated: false,
    doc: null,
  };
}

function constraint(id: Id, entityId: Id, fieldIds: readonly Id[]): Constraint {
  return { ...base(id, ''), entityId, kind: 'primaryKey', fieldIds: [...fieldIds] };
}

function link(id: Id, from: Link['from'], to: Link['to'], over: Partial<Link> = {}): Link {
  return { ...base(id, ''), kind: 'foreignKey', from, to, cardinality: 'N:1', ...over };
}

export function fixtureModel(): SchemaModel {
  const objects = emptyCollections();

  objects.namespace[NS] = namespace(NS, 'public');
  objects.area[AREA_BILLING] = area(AREA_BILLING, 'Billing', 0);
  objects.area[AREA_CRM] = area(AREA_CRM, 'CRM', 1);

  objects.entity[ORDERS] = entity(ORDERS, 'orders', {
    areaId: AREA_BILLING,
    position: { x: 0, y: 0 },
  });
  objects.entity[CUSTOMERS] = entity(CUSTOMERS, 'customers', {
    areaId: AREA_CRM,
    position: { x: 400, y: 0 },
  });
  // Exactly what `stubEntity` produces: real id and kind, blanked name, default
  // namespace, no area, version 0.
  objects.entity[SECRET] = {
    ...entity(SECRET, '', { position: { x: 800, y: 0 } }),
    version: 0,
    restricted: true,
  };

  objects.field[ORDER_ID] = field(ORDER_ID, 'id', ORDERS, 0, uuid);
  objects.field[ORDER_CUSTOMER_ID] = field(ORDER_CUSTOMER_ID, 'customer_id', ORDERS, 1, uuid);
  objects.field[ORDER_NOTE] = field(ORDER_NOTE, 'note', ORDERS, 2, text);
  objects.field[CUSTOMER_ID] = field(CUSTOMER_ID, 'id', CUSTOMERS, 0, uuid);

  objects.constraint.c_orders_pk = constraint('c_orders_pk', ORDERS, [ORDER_ID]);
  objects.constraint.c_customers_pk = constraint('c_customers_pk', CUSTOMERS, [CUSTOMER_ID]);

  objects.link.l_orders_customers = link(
    'l_orders_customers',
    { entityId: ORDERS, fieldIds: [ORDER_CUSTOMER_ID] },
    { entityId: CUSTOMERS, fieldIds: [CUSTOMER_ID] },
  );
  // `badgeLink` with cleared endpoints: it survives only so the stub renders connected.
  objects.link.l_orders_secret = link(
    'l_orders_secret',
    { entityId: ORDERS, fieldIds: [] },
    { entityId: SECRET, fieldIds: [] },
    { version: 0, restricted: true },
  );

  return {
    irVersion: 1,
    projectId: 'p1',
    engineId: 'postgresql',
    engineVersion: '16',
    redacted: true,
    objects,
  };
}
