import type { SchemaModel } from '@schemaloom/engine-sdk';
import type { ConformanceFixtures } from '@schemaloom/engine-sdk/conformance';
import {
  RawSchemaModel,
  redact,
  type RedactedModel,
  type VisibilityContext,
} from '@schemaloom/schema-model';
import { ECOMMERCE_DDL, MIXED_DDL } from './conformance-ddl.js';
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
 * the engine's own statement of what it supports: unsigned AUTO_INCREMENT keys, an ENUM, an
 * ON UPDATE timestamp, a generated column, a CHECK, a prefix index, an expression index, a
 * full-text index, a view and a foreign key. `refs` is set wherever core would set it.
 */

export function referenceModel(): SchemaModel {
  return model({
    entities: [
      table({
        id: 'en_customers',
        name: 'customers',
        engineProps: { engine: 'InnoDB', charset: 'utf8mb4' },
      }),
      table({
        id: 'en_orders',
        name: 'orders',
        engineProps: { engine: 'InnoDB' },
        doc: { id: 'dc_orders', excerpt: "Every customer's orders, one row per order" },
      }),
      table({
        id: 'en_summary',
        name: 'order_summary',
        kind: 'view',
        engineProps: {
          viewDefinition: 'select `orders`.`id` AS `id` from `orders`',
          algorithm: 'UNDEFINED',
        },
        refs: { entityIds: ['en_orders'], fieldIds: ['fd_ord_id', 'fd_sum_id'] },
      }),
    ],
    fields: [
      column({
        id: 'fd_cust_id',
        name: 'id',
        entityId: 'en_customers',
        ordinal: 0,
        type: { name: 'bigint' },
        isNullable: false,
        engineProps: { unsigned: true, autoIncrement: true },
      }),
      column({
        id: 'fd_cust_email',
        name: 'email',
        entityId: 'en_customers',
        ordinal: 1,
        type: { name: 'varchar', args: [255] },
        isNullable: false,
      }),
      column({
        id: 'fd_cust_status',
        name: 'status',
        entityId: 'en_customers',
        ordinal: 2,
        type: { name: 'enum', args: ['active', 'closed'] },
        isNullable: false,
        engineProps: { default: "'active'" },
      }),
      column({
        id: 'fd_cust_bio',
        name: 'bio',
        entityId: 'en_customers',
        ordinal: 3,
        type: { name: 'text' },
      }),
      column({
        id: 'fd_cust_updated',
        name: 'updated_at',
        entityId: 'en_customers',
        ordinal: 4,
        type: { name: 'timestamp' },
        isNullable: false,
        engineProps: { default: 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' },
      }),
      column({
        id: 'fd_ord_id',
        name: 'id',
        entityId: 'en_orders',
        ordinal: 0,
        type: { name: 'bigint' },
        isNullable: false,
        engineProps: { unsigned: true, autoIncrement: true },
      }),
      column({
        id: 'fd_ord_customer',
        name: 'customer_id',
        entityId: 'en_orders',
        ordinal: 1,
        type: { name: 'bigint' },
        isNullable: false,
        engineProps: { unsigned: true },
        doc: { id: 'dc_customer', excerpt: 'Who placed the order' },
      }),
      column({
        id: 'fd_ord_total',
        name: 'total',
        entityId: 'en_orders',
        ordinal: 2,
        type: { name: 'decimal', args: [12, 2] },
        isNullable: false,
      }),
      column({
        id: 'fd_ord_net',
        name: 'net_total',
        entityId: 'en_orders',
        ordinal: 3,
        type: { name: 'decimal', args: [12, 2] },
        engineProps: { generatedExpression: '`total` * 0.9', generatedKind: 'VIRTUAL' },
        refs: { entityIds: [], fieldIds: ['fd_ord_total'] },
      }),
      column({
        id: 'fd_sum_id',
        name: 'id',
        entityId: 'en_summary',
        ordinal: 0,
        type: { name: 'text' },
      }),
    ],
    constraints: [
      constraint({
        id: 'cn_pk_customers',
        name: 'PRIMARY',
        entityId: 'en_customers',
        kind: 'primaryKey',
        fieldIds: ['fd_cust_id'],
      }),
      constraint({
        id: 'cn_uq_email',
        name: 'customers_email_uq',
        entityId: 'en_customers',
        kind: 'unique',
        fieldIds: ['fd_cust_email'],
      }),
      constraint({
        id: 'cn_pk_orders',
        name: 'PRIMARY',
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
        engineProps: { expression: '`total` > 0' },
        refs: { entityIds: [], fieldIds: ['fd_ord_total'] },
      }),
    ],
    indexes: [
      index({
        id: 'ix_orders_customer',
        name: 'idx_customer_id',
        entityId: 'en_orders',
        kind: 'btree',
        columns: [
          indexColumn({ ordinal: 0, fieldId: 'fd_ord_customer' }),
          indexColumn({ ordinal: 1, fieldId: 'fd_ord_total', direction: 'desc' }),
        ],
      }),
      index({
        id: 'ix_cust_email_prefix',
        name: 'idx_email_prefix',
        entityId: 'en_customers',
        kind: 'btree',
        columns: [
          indexColumn({ ordinal: 0, fieldId: 'fd_cust_email', engineProps: { length: 20 } }),
        ],
      }),
      index({
        id: 'ix_cust_status_expr',
        name: 'idx_status_lower',
        entityId: 'en_customers',
        kind: 'btree',
        columns: [indexColumn({ ordinal: 0, expression: 'lower(`status`)' })],
        refs: { entityIds: [], fieldIds: ['fd_cust_status'] },
      }),
      index({
        id: 'ix_cust_bio_ft',
        name: 'ft_bio',
        entityId: 'en_customers',
        kind: 'fulltext',
        columns: [indexColumn({ ordinal: 0, fieldId: 'fd_cust_bio' })],
      }),
    ],
    links: [
      link({
        id: 'ln_fk_orders_customer',
        name: 'fk_orders_customer',
        kind: 'foreignKey',
        from: { entityId: 'en_orders', fieldIds: ['fd_ord_customer'] },
        to: { entityId: 'en_customers', fieldIds: ['fd_cust_id'] },
        cardinality: 'N:1',
        engineProps: { onDelete: 'restrict', onUpdate: 'cascade' },
      }),
    ],
  });
}

/**
 * The redacted model, by the real `redact`: the subject sees `orders` and `order_summary` but
 * not `customers`, and `orders.total` is Restricted. That yields a stub, a link into it with
 * both sides cleared, a masked column with dense ordinals, badge-only shells for the CHECK and
 * the index that name `total`, and `propsRedacted` on the generated column's bag.
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
    visibleEntityIds: new Set(['en_orders', 'en_summary']),
    restrictedOkEntityIds: new Set(),
    areasWithAtoms: new Set(),
    restrictedFieldMode: 'mask',
    totalEntityCount: Object.keys(raw.objects.entity).length,
    entitiesWithRestrictedFields: new Set(['en_orders']),
  };
  return redact(new RawSchemaModel(raw), ctx);
}

const REFERENCE_MODEL = referenceModel();

/** A fresh reference model with one edit applied — for the migration pairs. */
function edited(edit: (model: SchemaModel) => void): SchemaModel {
  const model = referenceModel();
  edit(model);
  return model;
}

function objectOrThrow<T>(value: T | undefined, id: string): T {
  if (value === undefined) throw new Error(`fixture: ${id} is missing`);
  return value;
}

export const CONFORMANCE_FIXTURES: ConformanceFixtures = {
  referenceModel: REFERENCE_MODEL,
  redactedModel: redactedModel(),
  redactForExport: fullyVisible,
  roundTrip: [
    {
      name: 'mysqldump e-commerce',
      format: 'ddl',
      source: ECOMMERCE_DDL,
      // Framing only: three DROP TABLEs, two DROP VIEWs and eight SETs, all `ignored`.
      expectNotApplied: [
        ...Array<string>(3).fill('DROP TABLE'),
        'DROP VIEW',
        'DROP VIEW',
        ...Array<string>(8).fill('SET'),
      ],
    },
    {
      name: 'every status',
      format: 'ddl',
      source: MIXED_DDL,
      expectNotApplied: ['CREATE TABLE', 'CREATE TRIGGER', 'INSERT', 'SET', 'unparsed'],
    },
  ],
  // 9d adds the query validator, 9c the migration generator; their checks skip until then.
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
          ordinal: 5,
          type: { name: 'varchar', args: [64] },
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
      name: 'narrow a varchar and require a value',
      before: REFERENCE_MODEL,
      after: edited((m) => {
        const email = objectOrThrow(m.objects.field.fd_cust_email, 'fd_cust_email');
        m.objects.field.fd_cust_email = { ...email, type: { name: 'varchar', args: [64] } };
        const bio = objectOrThrow(m.objects.field.fd_cust_bio, 'fd_cust_bio');
        m.objects.field.fd_cust_bio = { ...bio, isNullable: false };
      }),
      expectDestructive: false,
      expectLossy: true,
    },
    {
      name: 'rename a table, a column and an index',
      before: REFERENCE_MODEL,
      after: edited((m) => {
        const customers = objectOrThrow(m.objects.entity.en_customers, 'en_customers');
        m.objects.entity.en_customers = { ...customers, name: 'clients' };
        const email = objectOrThrow(m.objects.field.fd_cust_email, 'fd_cust_email');
        m.objects.field.fd_cust_email = { ...email, name: 'email_address' };
        const prefix = objectOrThrow(m.objects.index.ix_cust_email_prefix, 'ix_cust_email_prefix');
        m.objects.index.ix_cust_email_prefix = { ...prefix, name: 'idx_email_address_prefix' };
      }),
      expectDestructive: false,
      expectLossy: false,
    },
  ],
  invalidProps: [
    { kind: 'namespace', subKind: null, value: { owner: 42 } },
    { kind: 'entity', subKind: 'table', value: { rowFormat: 'SIDEWAYS' } },
    { kind: 'entity', subKind: 'view', value: { algorithm: 'FAST' } },
    { kind: 'field', subKind: null, value: { unsigned: 'yes' } },
    { kind: 'field', subKind: null, value: { generatedKind: 'LAZY' } },
    { kind: 'link', subKind: 'foreignKey', value: { onDelete: 'explode' } },
    { kind: 'index', subKind: null, value: { fillfactor: 90 } },
    { kind: 'indexColumn', subKind: null, value: { length: 0 } },
    { kind: 'constraint', subKind: 'check', value: { notEnforced: 'no' } },
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
      object: objectOrThrow(
        REFERENCE_MODEL.objects.index.ix_cust_status_expr,
        'ix_cust_status_expr',
      ),
      subKind: null,
      expectReferences: [{ type: 'field', id: 'fd_cust_status' }],
    },
    {
      object: objectOrThrow(REFERENCE_MODEL.objects.entity.en_summary, 'en_summary'),
      subKind: 'view',
      expectReferences: [
        { type: 'entity', id: 'en_orders' },
        { type: 'field', id: 'fd_ord_id' },
        { type: 'field', id: 'fd_sum_id' },
      ],
    },
  ],
};
