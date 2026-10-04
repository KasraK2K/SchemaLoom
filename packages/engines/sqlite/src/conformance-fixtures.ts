import type { SchemaModel } from '@schemaloom/engine-sdk';
import type { ConformanceFixtures } from '@schemaloom/engine-sdk/conformance';
import {
  RawSchemaModel,
  redact,
  type RedactedModel,
  type VisibilityContext,
} from '@schemaloom/schema-model';
import {
  column,
  constraint,
  fullyVisible,
  index,
  indexColumn,
  link,
  model,
  table,
} from './fixture-model.js';

/**
 * The fixtures doc 03 §17's suite runs against this engine. Test-only. The reference model is
 * the engine's own statement of what it supports: an INTEGER PRIMARY KEY with AUTOINCREMENT,
 * a CHECK list, a COLLATE, a generated column, a partial index, an expression index, a STRICT
 * table, a view and a foreign key. `refs` is set wherever core would set it.
 */

export function referenceModel(): SchemaModel {
  return model({
    entities: [
      table({ id: 'en_customers', name: 'customers' }),
      table({
        id: 'en_orders',
        name: 'orders',
        doc: { id: 'dc_orders', excerpt: "Every customer's orders, one row per order" },
      }),
      table({ id: 'en_tags', name: 'tags', engineProps: { strict: true, withoutRowid: true } }),
      table({
        id: 'en_summary',
        name: 'order_summary',
        kind: 'view',
        engineProps: { viewDefinition: 'SELECT id, total FROM orders' },
        refs: { entityIds: ['en_orders'], fieldIds: ['fd_ord_id', 'fd_ord_total', 'fd_sum_id'] },
      }),
    ],
    fields: [
      column({
        id: 'fd_cust_id',
        name: 'id',
        entityId: 'en_customers',
        ordinal: 0,
        type: { name: 'integer' },
        isNullable: false,
        engineProps: { autoIncrement: true },
      }),
      column({
        id: 'fd_cust_email',
        name: 'email',
        entityId: 'en_customers',
        ordinal: 1,
        type: { name: 'varchar', args: [255] },
        isNullable: false,
        engineProps: { collation: 'NOCASE' },
      }),
      column({
        id: 'fd_cust_status',
        name: 'status',
        entityId: 'en_customers',
        ordinal: 2,
        type: { name: 'text' },
        isNullable: false,
        engineProps: { default: "'active'" },
      }),
      column({
        id: 'fd_cust_updated',
        name: 'updated_at',
        entityId: 'en_customers',
        ordinal: 3,
        type: { name: 'datetime' },
        engineProps: { default: 'CURRENT_TIMESTAMP' },
      }),
      column({
        id: 'fd_ord_id',
        name: 'id',
        entityId: 'en_orders',
        ordinal: 0,
        type: { name: 'integer' },
        isNullable: false,
      }),
      column({
        id: 'fd_ord_customer',
        name: 'customer_id',
        entityId: 'en_orders',
        ordinal: 1,
        type: { name: 'integer' },
        isNullable: false,
        doc: { id: 'dc_customer', excerpt: 'Who placed the order' },
      }),
      column({
        id: 'fd_ord_total',
        name: 'total',
        entityId: 'en_orders',
        ordinal: 2,
        type: { name: 'numeric', args: [12, 2] },
        isNullable: false,
      }),
      column({
        id: 'fd_ord_net',
        name: 'net_total',
        entityId: 'en_orders',
        ordinal: 3,
        type: { name: 'numeric', args: [12, 2] },
        engineProps: { generatedExpression: 'total * 0.9', generatedKind: 'VIRTUAL' },
        refs: { entityIds: [], fieldIds: ['fd_ord_total'] },
      }),
      column({
        id: 'fd_tag_id',
        name: 'id',
        entityId: 'en_tags',
        ordinal: 0,
        type: { name: 'integer' },
        isNullable: false,
      }),
      column({
        id: 'fd_tag_label',
        name: 'label',
        entityId: 'en_tags',
        ordinal: 1,
        type: { name: 'text' },
        isNullable: false,
      }),
      column({
        id: 'fd_sum_id',
        name: 'id',
        entityId: 'en_summary',
        ordinal: 0,
        type: { name: 'integer' },
      }),
      column({
        id: 'fd_sum_total',
        name: 'total',
        entityId: 'en_summary',
        ordinal: 1,
        type: { name: 'numeric', args: [12, 2] },
      }),
    ],
    constraints: [
      constraint({
        id: 'cn_pk_customers',
        name: 'customers_pkey',
        entityId: 'en_customers',
        kind: 'primaryKey',
        fieldIds: ['fd_cust_id'],
      }),
      constraint({
        id: 'cn_uq_email',
        name: 'customers_email_key',
        entityId: 'en_customers',
        kind: 'unique',
        fieldIds: ['fd_cust_email'],
      }),
      constraint({
        id: 'cn_ck_status',
        name: 'customers_status_check',
        entityId: 'en_customers',
        kind: 'check',
        fieldIds: [],
        engineProps: { expression: "status IN ('active', 'closed')" },
        refs: { entityIds: [], fieldIds: ['fd_cust_status'] },
      }),
      constraint({
        id: 'cn_pk_orders',
        name: 'orders_pkey',
        entityId: 'en_orders',
        kind: 'primaryKey',
        fieldIds: ['fd_ord_id'],
      }),
      constraint({
        id: 'cn_ck_total',
        name: 'orders_total_positive',
        entityId: 'en_orders',
        kind: 'check',
        fieldIds: [],
        engineProps: { expression: 'total > 0' },
        refs: { entityIds: [], fieldIds: ['fd_ord_total'] },
      }),
      constraint({
        id: 'cn_pk_tags',
        name: 'tags_pkey',
        entityId: 'en_tags',
        kind: 'primaryKey',
        fieldIds: ['fd_tag_id'],
      }),
    ],
    indexes: [
      index({
        id: 'ix_orders_customer',
        name: 'idx_customer_total',
        entityId: 'en_orders',
        kind: 'btree',
        columns: [
          indexColumn({ ordinal: 0, fieldId: 'fd_ord_customer' }),
          indexColumn({ ordinal: 1, fieldId: 'fd_ord_total', direction: 'desc' }),
        ],
      }),
      index({
        id: 'ix_orders_big',
        name: 'idx_big_orders',
        entityId: 'en_orders',
        kind: 'btree',
        columns: [indexColumn({ ordinal: 0, fieldId: 'fd_ord_customer' })],
        engineProps: { where: 'total > 100' },
        refs: { entityIds: [], fieldIds: ['fd_ord_total'] },
      }),
      index({
        id: 'ix_cust_status_expr',
        name: 'idx_status_lower',
        entityId: 'en_customers',
        kind: 'btree',
        columns: [indexColumn({ ordinal: 0, expression: 'lower(status)' })],
        refs: { entityIds: [], fieldIds: ['fd_cust_status'] },
      }),
    ],
    links: [
      link({
        id: 'ln_fk_orders_customer',
        name: 'orders_customer_id_fkey',
        kind: 'foreignKey',
        from: { entityId: 'en_orders', fieldIds: ['fd_ord_customer'] },
        to: { entityId: 'en_customers', fieldIds: ['fd_cust_id'] },
        cardinality: 'N:1',
        engineProps: { onDelete: 'cascade', onUpdate: 'noAction' },
      }),
    ],
  });
}

/**
 * The redacted model, by the real `redact`: the subject sees `orders`, `tags` and
 * `order_summary` but not `customers`, and `orders.total` is Restricted. That yields a stub, a
 * link into it with both sides cleared, a masked column, badge-only shells for the CHECK and
 * the indexes that name `total`, and `propsRedacted` on the generated column and the view.
 */
export function redactedModel(): RedactedModel {
  const base = referenceModel();
  const total = base.objects.field.fd_ord_total;
  if (total === undefined) throw new Error('fixture: fd_ord_total is missing');
  const raw: SchemaModel = {
    ...base,
    objects: {
      ...base.objects,
      field: { ...base.objects.field, fd_ord_total: { ...total, isRestricted: true } },
    },
  };
  const ctx: VisibilityContext = {
    projectId: raw.projectId,
    subjectKind: 'user',
    subjectKey: 'conformance-subject',
    canOpenProject: true,
    visibleEntityIds: new Set(['en_orders', 'en_tags', 'en_summary']),
    restrictedOkEntityIds: new Set(),
    areasWithAtoms: new Set(),
    restrictedFieldMode: 'mask',
    totalEntityCount: Object.keys(raw.objects.entity).length,
    entitiesWithRestrictedFields: new Set(['en_orders']),
  };
  return redact(new RawSchemaModel(raw), ctx);
}

const REFERENCE_MODEL = referenceModel();

function edited(edit: (model: SchemaModel) => void): SchemaModel {
  const model = referenceModel();
  edit(model);
  return model;
}

function objectOrThrow<T>(value: T | undefined, id: string): T {
  if (value === undefined) throw new Error(`fixture: ${id} is missing`);
  return value;
}

/** What `sqlite3 app.db .dump` writes, rows included. */
const DUMP_DDL = `PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email varchar(255) NOT NULL UNIQUE COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed'))
);
INSERT INTO customers VALUES(1,'a@example.com','active');
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  total numeric(12,2) NOT NULL CHECK (total > 0),
  placed_at datetime DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO orders VALUES(1,1,10.5,'2026-01-01 10:00:00');
DELETE FROM sqlite_sequence;
INSERT INTO sqlite_sequence VALUES('customers',1);
CREATE INDEX orders_customer ON orders (customer_id, total DESC);
CREATE VIEW big_orders AS SELECT id, total FROM orders WHERE total > 100;
COMMIT;
`;

/** Every status: applied, ignored, unsupported and failed. */
const MIXED_DDL = `CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
CREATE TRIGGER notes_touch AFTER UPDATE ON notes BEGIN SELECT 1; END;
CREATE VIRTUAL TABLE notes_fts USING fts5(body);
ANALYZE;
ATTACH DATABASE 'other.db' AS other;
CREATE TABLE broken (id INTEGER PRIMARY KEY,);
CREATE INDEX notes_body ON notes (body);
`;

export const CONFORMANCE_FIXTURES: ConformanceFixtures = {
  referenceModel: REFERENCE_MODEL,
  redactedModel: redactedModel(),
  redactForExport: fullyVisible,
  roundTrip: [
    {
      name: 'sqlite3 .dump',
      format: 'ddl',
      source: DUMP_DDL,
      expectNotApplied: ['PRAGMA', 'BEGIN', 'INSERT', 'INSERT', 'DELETE', 'INSERT', 'COMMIT'],
    },
    {
      name: 'every status',
      format: 'ddl',
      source: MIXED_DDL,
      expectNotApplied: [
        'CREATE TRIGGER',
        'CREATE VIRTUAL TABLE',
        'ANALYZE',
        'ATTACH DATABASE',
        'CREATE TABLE',
      ],
    },
  ],
  queries: [
    {
      name: 'aliases and a view',
      query: 'SELECT o.id, o.customer_id FROM orders o JOIN order_summary AS s ON s.id = o.id',
      expect: {
        touchedEntityNames: ['orders', 'order_summary'],
        unknownIdentifiers: [],
        parsed: true,
      },
    },
    {
      name: 'a stub does not resolve by its real name',
      query: 'SELECT * FROM customers',
      expect: { touchedEntityNames: [], unknownIdentifiers: ['customers'], parsed: true },
    },
    {
      name: 'a masked column reads like a typo',
      query: 'SELECT total, net_totl FROM orders',
      expect: {
        touchedEntityNames: ['orders'],
        unknownIdentifiers: ['total', 'net_totl'],
        parsed: true,
      },
    },
    {
      name: 'unparseable',
      query: 'SELECT FROM WHERE (',
      expect: { touchedEntityNames: [], unknownIdentifiers: [], parsed: false },
    },
  ],
  migrations: [
    {
      name: 'add a column and an index',
      before: REFERENCE_MODEL,
      after: edited((m) => {
        m.objects.field.fd_cust_nick = column({
          id: 'fd_cust_nick',
          name: 'nickname',
          entityId: 'en_customers',
          ordinal: 4,
          type: { name: 'text' },
        });
        m.objects.index.ix_cust_nick = index({
          id: 'ix_cust_nick',
          name: 'idx_nickname',
          entityId: 'en_customers',
          columns: [indexColumn({ ordinal: 0, fieldId: 'fd_cust_nick' })],
        });
      }),
      expectDestructive: false,
      expectLossy: false,
    },
    {
      name: 'drop a column',
      before: REFERENCE_MODEL,
      after: edited((m) => {
        delete m.objects.field.fd_cust_updated;
      }),
      expectDestructive: true,
      expectLossy: false,
    },
    {
      name: 'change an affinity and require a value',
      before: REFERENCE_MODEL,
      after: edited((m) => {
        const status = objectOrThrow(m.objects.field.fd_cust_status, 'fd_cust_status');
        m.objects.field.fd_cust_status = { ...status, type: { name: 'integer' } };
        const updated = objectOrThrow(m.objects.field.fd_cust_updated, 'fd_cust_updated');
        m.objects.field.fd_cust_updated = { ...updated, isNullable: false };
      }),
      expectDestructive: false,
      expectLossy: true,
    },
    {
      name: 'rename a table and a column',
      before: REFERENCE_MODEL,
      after: edited((m) => {
        const customers = objectOrThrow(m.objects.entity.en_customers, 'en_customers');
        m.objects.entity.en_customers = { ...customers, name: 'clients' };
        const email = objectOrThrow(m.objects.field.fd_cust_email, 'fd_cust_email');
        m.objects.field.fd_cust_email = { ...email, name: 'email_address' };
      }),
      expectDestructive: false,
      expectLossy: false,
    },
  ],
  invalidProps: [
    { kind: 'namespace', subKind: null, value: { owner: 'x' } },
    { kind: 'entity', subKind: 'table', value: { strict: 'yes' } },
    { kind: 'entity', subKind: 'view', value: { algorithm: 'MERGE' } },
    { kind: 'field', subKind: null, value: { autoIncrement: 'yes' } },
    { kind: 'field', subKind: null, value: { generatedKind: 'LAZY' } },
    { kind: 'link', subKind: 'foreignKey', value: { onDelete: 'explode' } },
    { kind: 'index', subKind: null, value: { fillfactor: 90 } },
    { kind: 'indexColumn', subKind: null, value: { length: 20 } },
    { kind: 'constraint', subKind: 'check', value: { notEnforced: true } },
  ],
  expressionReferences: [
    {
      object: objectOrThrow(REFERENCE_MODEL.objects.constraint.cn_ck_total, 'cn_ck_total'),
      subKind: 'check',
      expectReferences: [{ type: 'field', id: 'fd_ord_total' }],
    },
    {
      object: objectOrThrow(REFERENCE_MODEL.objects.field.fd_ord_net, 'fd_ord_net'),
      subKind: null,
      expectReferences: [{ type: 'field', id: 'fd_ord_total' }],
    },
    {
      object: objectOrThrow(REFERENCE_MODEL.objects.index.ix_orders_big, 'ix_orders_big'),
      subKind: null,
      expectReferences: [{ type: 'field', id: 'fd_ord_total' }],
    },
    {
      object: objectOrThrow(REFERENCE_MODEL.objects.entity.en_summary, 'en_summary'),
      subKind: 'view',
      expectReferences: [
        { type: 'entity', id: 'en_orders' },
        { type: 'field', id: 'fd_ord_id' },
        { type: 'field', id: 'fd_ord_total' },
        { type: 'field', id: 'fd_sum_id' },
        { type: 'field', id: 'fd_sum_total' },
      ],
    },
  ],
};
