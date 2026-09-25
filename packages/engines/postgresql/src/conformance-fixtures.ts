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
  customType,
  index,
  indexColumn,
  link,
  model,
  fullyVisible,
  ns,
  table,
} from './fixture-model.js';

/**
 * The fixtures doc 03 §17's suite runs against this engine. Test-only: nothing exports this
 * from `index.ts` or `static.ts`, so it never reaches `dist`.
 *
 * The reference model is this engine's own statement of what it supports — every entity kind,
 * both namespaces, an identity column, a generated column, a user-defined enum and domain, an
 * expression index, a partial index, an INCLUDE column and a foreign key. `validator/clean-on-
 * reference-ir` asserts the engine finds nothing wrong with it, which is the point: a model an
 * engine cannot validate cleanly is a capability declaration the engine contradicts.
 *
 * `refs` is set on every expression-bearing object, because core sets it on every write
 * (§3.1) and doc 05's R27 reads it. A fixture without it would exercise the fail-closed path
 * instead of the real one.
 */

const PUBLIC = 'ns_public';
const BILLING = 'ns_billing';

export function referenceModel(): SchemaModel {
  return model({
    namespaces: [
      ns({ id: PUBLIC, name: 'public', isDefault: true }),
      ns({ id: BILLING, name: 'billing' }),
    ],
    customTypes: [
      customType({
        id: 'ct_status',
        name: 'order_status',
        namespaceId: PUBLIC,
        kind: 'enum',
        engineProps: { labels: ['pending', 'paid', 'void'] },
      }),
      customType({
        id: 'ct_positive',
        name: 'positive_int',
        namespaceId: PUBLIC,
        kind: 'domain',
        engineProps: { baseType: 'integer', notNull: true },
      }),
    ],
    entities: [
      table({
        id: 'en_customers',
        name: 'customers',
        namespaceId: PUBLIC,
        engineProps: { fillfactor: 90 },
      }),
      table({
        id: 'en_orders',
        name: 'orders',
        namespaceId: PUBLIC,
        engineProps: { tablespace: 'fast_ssd' },
        // §10.2: `COMMENT ON` comes off `doc.excerpt` and nothing else, so the fixture
        // carries one. The apostrophe is deliberate — it is what forces the dollar-quoting
        // branch of the escaper, and a comment body that silently ends early is a syntax
        // error in the middle of an exported file.
        doc: { id: 'dc_orders', excerpt: "Every customer's orders, one row per order" },
      }),
      table({
        id: 'en_summary',
        name: 'order_summary',
        namespaceId: BILLING,
        kind: 'view',
        engineProps: { viewDefinition: 'SELECT id FROM orders' },
        refs: { entityIds: ['en_orders'], fieldIds: ['fd_sum_id'] },
      }),
      table({
        id: 'en_stats',
        name: 'order_stats',
        namespaceId: BILLING,
        kind: 'materializedView',
        // A matview IS its definition: without one there is no `CREATE MATERIALIZED VIEW` to
        // emit, and `export/redaction-is-announced` catches the omission as an incomplete
        // export. It selects from the VIEW, not the table, so the fixture also exercises
        // §10.1 rule 2's "a view before a view that selects from *it*".
        engineProps: { withData: true, viewDefinition: 'SELECT id FROM billing.order_summary' },
        refs: { entityIds: ['en_summary'], fieldIds: ['fd_stat_id'] },
      }),
    ],
    fields: [
      column({
        id: 'fd_cust_id',
        name: 'id',
        entityId: 'en_customers',
        type: { name: 'integer' },
        isNullable: false,
        engineProps: { identity: 'always' },
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
        id: 'fd_cust_created',
        name: 'created_at',
        entityId: 'en_customers',
        ordinal: 2,
        type: { name: 'timestamptz' },
        engineProps: { default: 'now()' },
      }),
      column({
        id: 'fd_ord_id',
        name: 'id',
        entityId: 'en_orders',
        type: { name: 'integer' },
        isNullable: false,
        engineProps: { identity: 'byDefault' },
      }),
      column({
        id: 'fd_ord_customer',
        name: 'customer_id',
        entityId: 'en_orders',
        ordinal: 1,
        type: { name: 'integer' },
      }),
      column({
        id: 'fd_ord_status',
        name: 'status',
        entityId: 'en_orders',
        ordinal: 2,
        type: { name: 'order_status', customTypeId: 'ct_status' },
        // On a VISIBLE column, so `export/comments-from-docs` exercises COMMENT ON COLUMN.
        // `orders.total` would not: it is masked in `redactedModel`, and a masked field's
        // doc is blanked with the rest of it.
        doc: { id: 'dc_status', excerpt: 'Where the order is in the payment lifecycle' },
      }),
      column({
        id: 'fd_ord_total',
        name: 'total',
        entityId: 'en_orders',
        ordinal: 3,
        type: { name: 'numeric', args: [12, 2] },
      }),
      column({
        id: 'fd_ord_net',
        name: 'net_total',
        entityId: 'en_orders',
        ordinal: 4,
        type: { name: 'numeric', args: [12, 2] },
        engineProps: { generatedExpression: 'total * 0.9' },
        refs: { entityIds: [], fieldIds: ['fd_ord_total'] },
      }),
      column({
        id: 'fd_ord_qty',
        name: 'quantity',
        entityId: 'en_orders',
        ordinal: 5,
        type: { name: 'positive_int', customTypeId: 'ct_positive' },
      }),
      column({ id: 'fd_sum_id', name: 'id', entityId: 'en_summary', type: { name: 'integer' } }),
      column({ id: 'fd_stat_id', name: 'id', entityId: 'en_stats', type: { name: 'integer' } }),
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
        engineProps: { nullsNotDistinct: false },
      }),
      constraint({
        id: 'cn_pk_orders',
        name: 'orders_pkey',
        entityId: 'en_orders',
        kind: 'primaryKey',
        fieldIds: ['fd_ord_id'],
      }),
      // fieldIds is deliberately empty: a CHECK body names its columns in SQL text, which is
      // exactly why `extractReferences` exists.
      constraint({
        id: 'cn_ck_total',
        name: 'orders_total_positive',
        entityId: 'en_orders',
        kind: 'check',
        fieldIds: [],
        engineProps: { expression: 'total > 0' },
        refs: { entityIds: [], fieldIds: ['fd_ord_total'] },
      }),
    ],
    indexes: [
      index({
        id: 'ix_orders_customer',
        name: 'orders_customer_id_idx',
        entityId: 'en_orders',
        kind: 'btree',
        engineProps: { fillfactor: 90 },
        columns: [
          indexColumn({ ordinal: 0, fieldId: 'fd_ord_customer' }),
          indexColumn({ ordinal: 1, fieldId: 'fd_ord_total', role: 'include' }),
        ],
      }),
      index({
        id: 'ix_orders_status_expr',
        name: 'orders_status_lower_idx',
        entityId: 'en_orders',
        kind: 'btree',
        engineProps: { where: 'total > 0' },
        columns: [indexColumn({ ordinal: 0, expression: 'lower(status::text)' })],
        refs: { entityIds: [], fieldIds: ['fd_ord_status', 'fd_ord_total'] },
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
        engineProps: { onDelete: 'restrict', onUpdate: 'cascade' },
      }),
    ],
  });
}

/**
 * The redacted model, produced by the real `redact` — `RedactedModel`'s brand cannot be
 * forged, so this cannot be a hand-written imitation of redaction.
 *
 * The subject may see `orders`, `order_summary` and `order_stats` but not `customers`, and
 * `orders.total` is Restricted. That one setup produces every shape §17 asks for:
 *
 *  - `customers` becomes a STUB, because a surviving link points at it
 *  - the foreign key survives as a badge with BOTH sides' `fieldIds` cleared together
 *  - `orders.total` is MASKED and the sibling ordinals renumber densely — no gap, because
 *    the gap would itself be the disclosure
 *  - the CHECK naming `total` and the index INCLUDEing it drop to badge-only shells
 *  - `orders` carries `propsRedacted`, while `order_summary` — whose `refs` are all visible —
 *    keeps its `viewDefinition`. R-1's two flags, on their two independent axes.
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
    visibleEntityIds: new Set(['en_orders', 'en_summary', 'en_stats']),
    restrictedOkEntityIds: new Set(),
    areasWithAtoms: new Set(),
    restrictedFieldMode: 'mask',
    totalEntityCount: Object.keys(raw.objects.entity).length,
    entitiesWithRestrictedFields: new Set(['en_orders']),
  };

  return redact(new RawSchemaModel(raw), ctx);
}

const REFERENCE_MODEL = referenceModel();

function objectOrThrow<T>(value: T | undefined, id: string): T {
  if (value === undefined) throw new Error(`fixture: ${id} is missing`);
  return value;
}

export const CONFORMANCE_FIXTURES: ConformanceFixtures = {
  referenceModel: REFERENCE_MODEL,
  redactedModel: redactedModel(),

  redactForExport: fullyVisible,

  // Steps 20 and 21. `expectNotApplied` is asserted EXACTLY, so the day this engine starts
  // silently dropping a statement kind it currently reports, `import/reasons-present` fails
  // and names the kind.
  roundTrip: [
    { name: 'e-commerce', format: 'ddl', source: ECOMMERCE_DDL, expectNotApplied: [] },
    {
      name: 'every status',
      format: 'ddl',
      source: MIXED_DDL,
      expectNotApplied: [
        'ALTER TABLE', // EXCLUDE: partial
        'COMMENT', // ignored
        'CREATE TRIGGER', // unsupported
        'SET', // ignored
        'TRANSACTION', // ignored (BEGIN)
        'TRANSACTION', // ignored (COMMIT)
        'unparsed', // failed
      ],
    },
  ],
  queries: [],
  migrations: [],

  invalidProps: [
    { kind: 'namespace', subKind: null, value: { owner: 42 } },
    { kind: 'entity', subKind: 'table', value: { fillfactor: 5 } },
    { kind: 'entity', subKind: 'table', value: { partitionBy: { strategy: 'weekly' } } },
    { kind: 'field', subKind: null, value: { identity: 'sometimes' } },
    { kind: 'field', subKind: null, value: { compression: 'zstd' } },
    { kind: 'link', subKind: 'foreignKey', value: { onDelete: 'explode' } },
    { kind: 'index', subKind: null, value: { tablespace: 'x'.repeat(64) } },
    { kind: 'indexColumn', subKind: null, value: { nullsOrder: 'middle' } },
    { kind: 'constraint', subKind: 'check', value: { noInherit: 'yes' } },
    { kind: 'customType', subKind: 'enum', value: { labels: 'pending' } },
    { kind: 'customType', subKind: 'domain', value: { checks: [{ body: 'VALUE > 0' }] } },
  ],

  // Every expression shape this engine stores: a CHECK body and a partial-index predicate in
  // `engineProps`, a generated-column expression, an index column expression that references
  // no field id at all, and a view body naming another table. A miss in any of them is a leak.
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
      object: objectOrThrow(REFERENCE_MODEL.objects.index.ix_orders_status_expr, 'ix_orders_status_expr'),
      subKind: null,
      expectReferences: [
        { type: 'field', id: 'fd_ord_status' },
        { type: 'field', id: 'fd_ord_total' },
      ],
    },
    {
      object: objectOrThrow(REFERENCE_MODEL.objects.entity.en_summary, 'en_summary'),
      subKind: 'view',
      expectReferences: [
        { type: 'entity', id: 'en_orders' },
        { type: 'field', id: 'fd_sum_id' },
      ],
    },
  ],

  // `staticEntry` is omitted: bundling it needs `esbuild`, an optional peer dependency this
  // workspace does not install. `static-boundary.spec.ts` guards the same boundary statically,
  // on every commit, and catches the first cheap Node import rather than only the megabytes.
};
