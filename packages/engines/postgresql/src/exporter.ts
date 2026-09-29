import {
  EXPORT_PHASE_RANK,
  type CustomType,
  type Diagnostic,
  type EngineProps,
  type Entity,
  type ExportInput,
  type ExportPhase,
  type ExportResult,
  type ExportStatement,
  type Exporter,
  type Field,
  type Id,
  type Index,
  type IrObjectRef,
  type IrObjectType,
  type Link,
  type Namespace,
  type SchemaModel,
  type TypeResolutionContext,
} from '@schemaloom/engine-sdk';
import { CAPABILITIES } from './capabilities.js';
import {
  addConstraint,
  columnDefinition,
  commentOn,
  compositeAttributes,
  constraintBody,
  createComposite,
  createDomain,
  createEnum,
  createIndex,
  createSchema,
  createTable,
  createView,
  dropStatement,
  enableRowLevelSecurity,
  foreignKeyBody,
  propBool,
  propString,
  propStringArray,
  qualify,
  quoteIdentifier,
  type CommentSubject,
  type IndexColumnInput,
} from './export-ddl.js';
import { CODE } from './messages.js';
import { quoteDocText } from './sql-text.js';
import { TYPE_CATALOG } from './types.js';

/**
 * Doc 03 §10 — the PostgreSQL exporter.
 *
 * THREE PROPERTIES, in the order they matter:
 *
 * 1. IT TAKES A `RedactedModel`. Not a `SchemaModel`. The branded type is the whole
 *    permission story: an unredacted model does not typecheck into this function, so
 *    "exports respect permissions" is a compile error rather than a code-review habit.
 *
 * 2. IT IS DETERMINISTIC. Every list is sorted by an EXPLICIT key — never by `Object.keys`
 *    order, never by `localeCompare`, whose result depends on the server's ICU data. The same
 *    IR and the same options produce byte-identical output on every machine, so diffing two
 *    exports is a real diff of the schema (§10.1).
 *
 * 3. IT NEVER DROPS SOMETHING SILENTLY. An object it cannot emit sets `incomplete`, and on a
 *    redacted model that is announced once in the header and never counted — doc 05 §8.4 L8
 *    is explicit that an aggregate over hidden objects is itself the leak.
 */

interface Pending {
  readonly phase: ExportPhase;
  readonly kind: string;
  readonly text: string;
  readonly target: IrObjectRef | null;
  /** dependency rank inside the phase; 0 for phases with no dependency order */
  readonly rank: number;
  /** §10.1 rule 3: `(namespaceName, objectName, id)`, ascending */
  readonly sort: readonly [string, string, string];
}

/** Byte comparison, NOT `localeCompare`: the result must not depend on the server's locale. */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byPhaseThenKey(a: Pending, b: Pending): number {
  return (
    EXPORT_PHASE_RANK[a.phase] - EXPORT_PHASE_RANK[b.phase] ||
    a.rank - b.rank ||
    compare(a.sort[0], b.sort[0]) ||
    compare(a.sort[1], b.sort[1]) ||
    compare(a.sort[2], b.sort[2])
  );
}

const REDACTION_NOTICE = '-- Some objects are not included because of your access level.';

export const ENTITY_SUBJECT: Readonly<Record<string, CommentSubject>> = {
  table: 'TABLE',
  view: 'VIEW',
  materializedView: 'MATERIALIZED VIEW',
};

/**
 * `propsRedacted` means the bag was blanked because an expression inside it named something
 * the viewer may not see (R27). The object itself is fully visible and IS exported (§10.3
 * rule 1) — just without engine-owned properties. Redaction already emptied the bag; reading
 * it through here says so at every use site instead of relying on that.
 */
function propsOf(object: { engineProps: EngineProps; propsRedacted?: true }): EngineProps {
  return object.propsRedacted === true ? {} : object.engineProps;
}

class ExportPlan {
  readonly pending: Pending[] = [];
  readonly diagnostics: Diagnostic[] = [];
  skipped = false;

  constructor(private readonly model: SchemaModel) {}

  add(item: Pending): void {
    this.pending.push(item);
  }

  /**
   * §10.3 rules 3 and 4. A redacted model gets NO per-object diagnostic — "a list of `info`
   * diagnostics is a count with extra steps" — only the single header notice. A model that is
   * not redacted has nothing to protect, so an object the exporter cannot render is a real
   * problem and says so.
   */
  skip(type: IrObjectType, id: Id, reason: string): void {
    this.skipped = true;
    if (this.model.redacted) return;
    this.diagnostics.push({
      code: CODE.exportOmitted,
      severity: 'warning',
      params: { reason },
      target: { type, id },
    });
  }
}

function sortedValues<T extends { readonly id: Id }>(bag: Record<Id, T>): readonly T[] {
  return Object.values(bag).sort((a, b) => compare(a.id, b.id));
}

/** Dependency depth over `refs.entityIds` — §10.1 rule 2, "a table before a view that selects
 *  from it, and a view before a view that selects from *it*". A cycle resolves to depth 0 for
 *  every member, so the tie-break key orders it deterministically rather than hanging. */
export function entityDepths(entities: readonly Entity[]): ReadonlyMap<Id, number> {
  const present = new Set(entities.map((e) => e.id));
  const byId = new Map(entities.map((e) => [e.id, e]));
  const depths = new Map<Id, number>();
  const visiting = new Set<Id>();

  const depthOf = (id: Id): number => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let depth = 0;
    for (const dependency of byId.get(id)?.refs?.entityIds ?? []) {
      if (dependency !== id && present.has(dependency)) {
        depth = Math.max(depth, depthOf(dependency) + 1);
      }
    }
    visiting.delete(id);
    depths.set(id, depth);
    return depth;
  };

  for (const entity of entities) depthOf(entity.id);
  return depths;
}

function buildExport(input: ExportInput): ExportResult {
  const { model, options } = input;
  const plan = new ExportPlan(model);

  const namespaces = new Map<Id, Namespace>(
    Object.entries(model.objects.namespace).map(([id, ns]) => [id, ns]),
  );
  const namespaceName = (id: Id): string => namespaces.get(id)?.name ?? '';
  const typeContextFor = (nsId: Id): TypeResolutionContext => ({
    customTypes: Object.values(model.objects.customType),
    namespaceName: namespaceName(nsId),
  });

  // --- namespaces -----------------------------------------------------------------------
  for (const namespace of sortedValues(model.objects.namespace)) {
    if (namespace.isDefault) continue; // `public` is always there; creating it is noise
    plan.add({
      phase: 'namespaces',
      kind: 'CREATE SCHEMA',
      text: createSchema(namespace.name, propsOf(namespace), options.includeIfNotExists),
      target: { type: 'namespace', id: namespace.id },
      rank: 0,
      sort: [namespace.name, namespace.name, namespace.id],
    });
  }

  // --- custom types ---------------------------------------------------------------------
  for (const customType of sortedValues(model.objects.customType)) {
    const statement = customTypeStatement(customType, namespaceName(customType.namespaceId));
    if (statement === null) {
      plan.skip('customType', customType.id, `a ${customType.kind} type cannot be rendered`);
      continue;
    }
    plan.add({
      phase: 'custom-types',
      kind: statement.kind,
      text: statement.text,
      target: { type: 'customType', id: customType.id },
      rank: 0,
      sort: [namespaceName(customType.namespaceId), customType.name, customType.id],
    });
  }

  // --- entities -------------------------------------------------------------------------
  const emittedEntities = new Map<Id, Entity>();
  const fieldsByEntity = new Map<Id, Field[]>();
  for (const field of Object.values(model.objects.field)) {
    const bucket = fieldsByEntity.get(field.entityId);
    if (bucket === undefined) fieldsByEntity.set(field.entityId, [field]);
    else bucket.push(field);
  }

  const emittedFields = new Map<Id, Field>();
  const candidates: Entity[] = [];

  for (const entity of sortedValues(model.objects.entity)) {
    // R-1: a restricted ENTITY is a stub — blank name, no fields. §10.3 rule 1 skips it, and
    // everything that depends on it goes with it.
    if (entity.restricted === true) {
      plan.skip('entity', entity.id, 'hidden from the requester');
      continue;
    }
    if (!(entity.kind in ENTITY_SUBJECT)) {
      plan.skip('entity', entity.id, `unknown entity kind “${entity.kind}”`);
      continue;
    }
    candidates.push(entity);
  }

  const depths = entityDepths(candidates);

  for (const entity of candidates) {
    const props = propsOf(entity);
    const nsName = namespaceName(entity.namespaceId);
    const qualified = qualify(nsName, entity.name);
    const sort: readonly [string, string, string] = [nsName, entity.name, entity.id];
    const rank = depths.get(entity.id) ?? 0;

    // R-1: a restricted FIELD is masked — blank name, blank type (punch-list ∆4) — so it
    // cannot be emitted as a column at all. §10.3 rule 2: skip it, never `"" "" NOT NULL`.
    const visible: Field[] = [];
    for (const field of (fieldsByEntity.get(entity.id) ?? []).sort(
      (a, b) => a.ordinal - b.ordinal || compare(a.id, b.id),
    )) {
      if (field.restricted === true || field.name === '') {
        plan.skip('field', field.id, 'hidden from the requester');
        continue;
      }
      visible.push(field);
    }

    if (entity.kind === 'table') {
      const typeContext = typeContextFor(entity.namespaceId);
      const columns = visible.map((field) =>
        columnDefinition({
          name: field.name,
          type: renderType(field, typeContext, entity.namespaceId, namespaceName),
          isNullable: field.isNullable,
          props: propsOf(field),
        }),
      );
      plan.add({
        phase: 'entities',
        kind: 'CREATE TABLE',
        text: createTable(qualified, columns, props, options.includeIfNotExists),
        target: { type: 'entity', id: entity.id },
        rank,
        sort,
      });
      if (propBool(props, 'rowLevelSecurity')) {
        plan.add({
          phase: 'constraints',
          kind: 'ALTER TABLE',
          text: enableRowLevelSecurity(qualified),
          target: { type: 'entity', id: entity.id },
          rank: 0,
          sort,
        });
      }
    } else {
      // A view IS its `viewDefinition`. Without one there is no statement to emit — and on a
      // redacted model that is exactly R27 blanking the bag, which is why this is a skip and
      // not a `CREATE VIEW` with an empty body.
      const body = propString(props, 'viewDefinition');
      if (body === undefined) {
        plan.skip('entity', entity.id, 'the view has no definition');
        continue;
      }
      const kind = entity.kind === 'materializedView' ? 'materializedView' : 'view';
      plan.add({
        phase: 'entities',
        kind: kind === 'view' ? 'CREATE VIEW' : 'CREATE MATERIALIZED VIEW',
        text: createView(kind, qualified, body, props, options.includeIfNotExists),
        target: { type: 'entity', id: entity.id },
        rank,
        sort,
      });
    }

    emittedEntities.set(entity.id, entity);
    for (const field of visible) emittedFields.set(field.id, field);

    if (options.includeDrops) {
      const subject = ENTITY_SUBJECT[entity.kind] ?? 'TABLE';
      plan.add({
        phase: 'drops',
        kind: `DROP ${subject}`,
        text: dropStatement(subject, qualified),
        target: { type: 'entity', id: entity.id },
        // Reverse of creation: a dependent view is dropped before what it selects from.
        rank: -rank,
        sort,
      });
    }
  }

  const entityRef = (id: Id): Entity | undefined => emittedEntities.get(id);
  const columnNames = (ids: readonly Id[]): readonly string[] | null => {
    const names: string[] = [];
    for (const id of ids) {
      const field = emittedFields.get(id);
      if (field === undefined) return null;
      names.push(field.name);
    }
    return names;
  };

  // --- constraints ----------------------------------------------------------------------
  for (const constraint of sortedValues(model.objects.constraint)) {
    const entity = entityRef(constraint.entityId);
    // A badge-only constraint (R-1: restricted + type `constraint`) has a blank name and an
    // empty props bag, so its CHECK body is gone. §10.3 rule 1 skips it.
    if (constraint.restricted === true) {
      plan.skip('constraint', constraint.id, 'hidden from the requester');
      continue;
    }
    if (entity === undefined) {
      plan.skip('constraint', constraint.id, 'its table is not in this export');
      continue;
    }
    const names = columnNames(constraint.fieldIds);
    if (names === null) {
      plan.skip('constraint', constraint.id, 'it references a column not in this export');
      continue;
    }
    const body = constraintBody(constraint.kind, names, propsOf(constraint));
    if (body === undefined) {
      plan.skip('constraint', constraint.id, `a ${constraint.kind} constraint cannot be rendered`);
      continue;
    }
    const nsName = namespaceName(entity.namespaceId);
    plan.add({
      phase: 'constraints',
      kind: 'ALTER TABLE',
      text: addConstraint(qualify(nsName, entity.name), constraint.name, body),
      target: { type: 'constraint', id: constraint.id },
      rank: 0,
      sort: [nsName, `${entity.name}.${constraint.name}`, constraint.id],
    });
  }

  // --- links (foreign keys) -------------------------------------------------------------
  for (const link of sortedValues(model.objects.link)) {
    const skipReason = linkSkipReason(link, entityRef, columnNames);
    if (skipReason !== null) {
      plan.skip('link', link.id, skipReason);
      continue;
    }
    const from = entityRef(link.from.entityId);
    const to = entityRef(link.to.entityId);
    const fromColumns = columnNames(link.from.fieldIds);
    const toColumns = columnNames(link.to.fieldIds);
    if (from === undefined || to === undefined || fromColumns === null || toColumns === null) {
      continue; // unreachable: `linkSkipReason` already returned non-null for each of these
    }
    const nsName = namespaceName(from.namespaceId);
    plan.add({
      phase: 'constraints',
      kind: 'ALTER TABLE',
      text: addConstraint(
        qualify(nsName, from.name),
        link.name,
        foreignKeyBody(
          fromColumns,
          qualify(namespaceName(to.namespaceId), to.name),
          toColumns,
          propsOf(link),
        ),
      ),
      target: { type: 'link', id: link.id },
      rank: 0,
      sort: [nsName, `${from.name}.${link.name}`, link.id],
    });
  }

  // --- indexes --------------------------------------------------------------------------
  for (const index of sortedValues(model.objects.index)) {
    if (index.restricted === true) {
      plan.skip('index', index.id, 'hidden from the requester');
      continue;
    }
    const entity = entityRef(index.entityId);
    if (entity === undefined) {
      plan.skip('index', index.id, 'its table is not in this export');
      continue;
    }
    const columns = indexColumns(index, emittedFields);
    if (columns === null) {
      plan.skip('index', index.id, 'it references a column not in this export');
      continue;
    }
    const nsName = namespaceName(entity.namespaceId);
    plan.add({
      phase: 'indexes',
      kind: 'CREATE INDEX',
      text: createIndex(
        index.name,
        qualify(nsName, entity.name),
        index.kind,
        index.isUnique,
        columns.keys,
        columns.included,
        propsOf(index),
      ),
      target: { type: 'index', id: index.id },
      rank: 0,
      sort: [nsName, `${entity.name}.${index.name}`, index.id],
    });
  }

  // --- comments (§10.2) -----------------------------------------------------------------
  if (options.includeComments && CAPABILITIES.features.comments) {
    for (const entity of [...emittedEntities.values()].sort((a, b) => compare(a.id, b.id))) {
      if (entity.doc === null) continue;
      const nsName = namespaceName(entity.namespaceId);
      const subject = ENTITY_SUBJECT[entity.kind] ?? 'TABLE';
      plan.add({
        phase: 'comments',
        kind: `COMMENT ON ${subject}`,
        text: commentOn(subject, qualify(nsName, entity.name), quoteDocText(entity.doc.excerpt)),
        target: { type: 'entity', id: entity.id },
        rank: 0,
        sort: [nsName, entity.name, entity.id],
      });
    }
    for (const field of [...emittedFields.values()].sort((a, b) => compare(a.id, b.id))) {
      const entity = entityRef(field.entityId);
      if (field.doc === null || entity === undefined) continue;
      const nsName = namespaceName(entity.namespaceId);
      plan.add({
        phase: 'comments',
        kind: 'COMMENT ON COLUMN',
        text: commentOn(
          'COLUMN',
          `${qualify(nsName, entity.name)}.${quoteIdentifier(field.name)}`,
          quoteDocText(field.doc.excerpt),
        ),
        target: { type: 'field', id: field.id },
        rank: 0,
        sort: [nsName, `${entity.name}.${field.name}`, field.id],
      });
    }
  }

  // --- assemble -------------------------------------------------------------------------
  const ordered = [...plan.pending].sort(byPhaseThenKey);
  const statements: ExportStatement[] = [];

  // §10.3 rule 3: exactly one header statement, present precisely when something was skipped,
  // with no count and no names.
  if (plan.skipped) {
    statements.push({
      ordinal: 0,
      phase: 'header',
      kind: 'COMMENT',
      text: REDACTION_NOTICE,
      target: null,
    });
  }
  for (const item of ordered) {
    statements.push({
      ordinal: statements.length,
      phase: item.phase,
      kind: item.kind,
      text: item.text,
      target: item.target,
    });
  }

  return {
    statements,
    separator: CAPABILITIES.queryLanguage.statementSeparator,
    incomplete: plan.skipped,
    diagnostics: plan.diagnostics,
  };
}

/**
 * The type catalog renders a user-defined type by BARE name, because that is what the canvas
 * badge shows. DDL needs more than that: `CREATE TABLE public.orders (status order_status)`
 * only compiles when `order_status`'s schema is on the server's `search_path`, which an
 * exported file cannot assume. So a user type living in another namespace than the table is
 * qualified here — in the exporter, where the DDL is, rather than in the catalog, where the
 * label is.
 */
export function renderType(
  field: Field,
  typeContext: TypeResolutionContext,
  entityNamespaceId: Id,
  namespaceName: (id: Id) => string,
): string {
  const resolved = TYPE_CATALOG.resolve(field.type, typeContext);
  const rendered = TYPE_CATALOG.format(resolved);
  const custom = resolved.customType;
  if (custom === null || custom.namespaceId === entityNamespaceId) return rendered;
  return `${quoteIdentifier(namespaceName(custom.namespaceId))}.${rendered}`;
}

function linkSkipReason(
  link: Link,
  entityRef: (id: Id) => Entity | undefined,
  columnNames: (ids: readonly Id[]) => readonly string[] | null,
): string | null {
  if (link.restricted === true) return 'hidden from the requester';
  if (link.kind !== 'foreignKey') return `a ${link.kind} link has no DDL form`;
  const from = entityRef(link.from.entityId);
  const to = entityRef(link.to.entityId);
  // §10.3 rule 1: a foreign key to a stub entity is skipped rather than emitted against a
  // table that will not exist.
  if (from === undefined || to === undefined) return 'one of its tables is not in this export';
  if (link.from.fieldIds.length === 0 || link.to.fieldIds.length === 0) {
    return 'its columns are not in this export';
  }
  if (columnNames(link.from.fieldIds) === null || columnNames(link.to.fieldIds) === null) {
    return 'it references a column not in this export';
  }
  return null;
}

export function indexColumns(
  index: Index,
  emittedFields: ReadonlyMap<Id, Field>,
): { keys: readonly IndexColumnInput[]; included: readonly string[] } | null {
  const keys: IndexColumnInput[] = [];
  const included: string[] = [];

  for (const column of [...index.columns].sort((a, b) => a.ordinal - b.ordinal)) {
    if (column.fieldId !== null) {
      const field = emittedFields.get(column.fieldId);
      if (field === undefined) return null;
      if (column.role === 'include') included.push(field.name);
      else
        keys.push({
          columnName: field.name,
          direction: column.direction,
          props: column.engineProps,
        });
      continue;
    }
    if (column.expression === null) return null;
    keys.push({
      expression: column.expression,
      direction: column.direction,
      props: column.engineProps,
    });
  }

  return keys.length === 0 ? null : { keys, included };
}

export function customTypeStatement(
  customType: CustomType,
  nsName: string,
): { kind: string; text: string } | null {
  const qualified = qualify(nsName, customType.name);
  const props = propsOf(customType);

  switch (customType.kind) {
    case 'enum': {
      const labels = propStringArray(props, 'labels');
      if (labels === undefined || labels.length === 0) return null;
      return { kind: 'CREATE TYPE', text: createEnum(qualified, labels) };
    }
    case 'domain':
      return { kind: 'CREATE DOMAIN', text: createDomain(qualified, props) };
    case 'composite': {
      const attributes = compositeAttributes(props);
      if (attributes === undefined || attributes.length === 0) return null;
      return { kind: 'CREATE TYPE', text: createComposite(qualified, attributes) };
    }
    default:
      return null;
  }
}

export const EXPORTER: Exporter = {
  // Not `async`: there is no I/O to await, and the SDK's signature is a Promise only because
  // another engine's exporter may need one.
  export(input: ExportInput): Promise<ExportResult> {
    return Promise.resolve(buildExport(input));
  },
};
