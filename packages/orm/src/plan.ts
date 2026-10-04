import type {
  Constraint,
  Diagnostic,
  Entity,
  Field,
  Id,
  Index,
  IrObjectType,
  Link,
  RedactedModel,
} from '@schemaloom/engine-sdk';
import type { OrmDialect, OrmEnum } from './dialect.js';
import { compare, propString } from './util.js';

/**
 * Phase 8 §2.1 — what the Drizzle, TypeORM and Django writers share: which objects are in the
 * export, in which order, and what each one is. A writer only names and prints. Redaction is
 * settled here once: a hidden object is skipped, sets `skipped`, and (on a model that wasn't
 * redacted wholesale) leaves a diagnostic, as the DDL exporters do.
 */

export interface PlannedKey {
  readonly name: string;
  readonly fieldIds: readonly Id[];
}

export interface PlannedIndex {
  readonly index: Index;
  /** the key columns in order, or null when one is an expression (or an INCLUDE column) */
  readonly fieldIds: readonly Id[] | null;
  readonly descending: ReadonlySet<Id>;
  readonly method: string | null;
  readonly where: string | undefined;
}

export interface PlannedForeignKey {
  readonly link: Link;
  readonly child: PlannedTable;
  readonly parent: PlannedTable;
  readonly fromIds: readonly Id[];
  readonly toIds: readonly Id[];
  /** `noAction` … `setDefault`, as stored */
  readonly onDelete: string;
  readonly onUpdate: string;
  /** some child column is nullable */
  readonly optional: boolean;
  /** the child columns are unique, so the relation is one-to-one */
  readonly oneToOne: boolean;
  /** more than one foreign key between the same two tables, or a table referring to itself:
   *  ORMs need the relation named to tell them apart */
  readonly ambiguous: boolean;
}

export interface PlannedTable {
  readonly entity: Entity;
  readonly namespace: string;
  readonly isDefaultNamespace: boolean;
  readonly fields: readonly Field[];
  readonly primaryKey: PlannedKey | null;
  readonly uniques: readonly PlannedKey[];
  readonly indexes: readonly PlannedIndex[];
  readonly checks: readonly { readonly name: string; readonly expression: string }[];
  /** foreign keys out of this table, then into it */
  readonly outgoing: PlannedForeignKey[];
  readonly incoming: PlannedForeignKey[];
}

export interface PlannedView {
  readonly entity: Entity;
  readonly namespace: string;
  readonly isDefaultNamespace: boolean;
  readonly materialized: boolean;
  readonly fields: readonly Field[];
  /** undefined when the body is hidden or was never written */
  readonly definition: string | undefined;
}

export interface OrmPlan {
  readonly tables: readonly PlannedTable[];
  readonly views: readonly PlannedView[];
  readonly enums: readonly OrmEnum[];
  readonly fieldById: ReadonlyMap<Id, Field>;
  /** a hidden object was left out: the export is incomplete */
  readonly skipped: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

const setKey = (ids: readonly Id[]): string => [...ids].sort(compare).join(',');

const byName = (a: Constraint | Index | Link, b: Constraint | Index | Link): number =>
  compare(a.name, b.name) || compare(a.id, b.id);

export function planModels(model: RedactedModel, dialect: OrmDialect): OrmPlan {
  const diagnostics: Diagnostic[] = [];
  let skipped = false as boolean;
  const skip = (type: IrObjectType, id: Id, reason: string): void => {
    skipped = true;
    if (model.redacted) return;
    diagnostics.push({
      code: dialect.omittedCode,
      severity: 'warning',
      params: { reason },
      target: { type, id },
    });
  };

  const namespace = (id: Id) => model.objects.namespace[id];
  const nsName = (id: Id): string => namespace(id)?.name ?? '';

  const found = dialect.enums(model);
  for (const id of found.hidden) skip('customType', id, 'hidden from the requester');

  const fieldsByEntity = new Map<Id, Field[]>();
  for (const field of Object.values(model.objects.field)) {
    const bucket = fieldsByEntity.get(field.entityId);
    if (bucket === undefined) fieldsByEntity.set(field.entityId, [field]);
    else bucket.push(field);
  }
  const fieldById = new Map<Id, Field>();
  const primaryKeyFields = new Set(
    Object.values(model.objects.constraint)
      .filter((c) => c.kind === 'primaryKey' && c.restricted !== true)
      .flatMap((c) => c.fieldIds),
  );
  const visibleFields = (entity: Entity): Field[] => {
    const fields: Field[] = [];
    for (const field of (fieldsByEntity.get(entity.id) ?? []).sort(
      (a, b) => a.ordinal - b.ordinal || compare(a.id, b.id),
    )) {
      if (field.restricted === true || field.name === '') {
        skip('field', field.id, 'hidden from the requester');
        continue;
      }
      // An import of an inline `PRIMARY KEY` doesn't mark the column NOT NULL; the database does.
      const visible = primaryKeyFields.has(field.id) ? { ...field, isNullable: false } : field;
      fields.push(visible);
      fieldById.set(field.id, visible);
    }
    return fields;
  };

  const tables = new Map<Id, PlannedTable & { uniqueSets: Set<string> }>();
  const views: PlannedView[] = [];
  const sortedEntities = Object.values(model.objects.entity).sort(
    (a, b) =>
      compare(nsName(a.namespaceId), nsName(b.namespaceId)) ||
      compare(a.name, b.name) ||
      compare(a.id, b.id),
  );
  for (const entity of sortedEntities) {
    if (entity.restricted === true) {
      skip('entity', entity.id, 'hidden from the requester');
      continue;
    }
    const isDefaultNamespace = namespace(entity.namespaceId)?.isDefault === true;
    if (entity.kind !== 'table') {
      views.push({
        entity,
        namespace: nsName(entity.namespaceId),
        isDefaultNamespace,
        materialized: entity.kind === 'materializedView',
        fields: visibleFields(entity),
        definition:
          entity.propsRedacted === true
            ? undefined
            : propString(entity.engineProps, 'viewDefinition'),
      });
      continue;
    }
    tables.set(entity.id, {
      entity,
      namespace: nsName(entity.namespaceId),
      isDefaultNamespace,
      fields: visibleFields(entity),
      primaryKey: null,
      uniques: [],
      indexes: [],
      checks: [],
      outgoing: [],
      incoming: [],
      uniqueSets: new Set(),
    });
  }

  const allVisible = (ids: readonly Id[]): boolean =>
    ids.length > 0 && ids.every((id) => fieldById.has(id));

  for (const constraint of Object.values(model.objects.constraint).sort(byName)) {
    if (constraint.restricted === true) {
      skip('constraint', constraint.id, 'hidden from the requester');
      continue;
    }
    const table = tables.get(constraint.entityId);
    if (table === undefined) continue;
    if (constraint.kind === 'check') {
      const expression =
        constraint.propsRedacted === true
          ? undefined
          : propString(constraint.engineProps, 'expression');
      if (expression === undefined) skip('constraint', constraint.id, 'its body is hidden');
      else
        (table.checks as { name: string; expression: string }[]).push({
          name: constraint.name,
          expression,
        });
      continue;
    }
    if (constraint.kind !== 'primaryKey' && constraint.kind !== 'unique') continue;
    if (!allVisible(constraint.fieldIds)) {
      skip('constraint', constraint.id, 'it references a column not in this export');
      continue;
    }
    const key = { name: constraint.name, fieldIds: constraint.fieldIds };
    if (constraint.kind === 'primaryKey')
      (table as { primaryKey: PlannedKey | null }).primaryKey = key;
    else (table.uniques as PlannedKey[]).push(key);
    table.uniqueSets.add(setKey(constraint.fieldIds));
  }

  for (const index of Object.values(model.objects.index).sort(byName)) {
    if (index.restricted === true) {
      skip('index', index.id, 'hidden from the requester');
      continue;
    }
    const table = tables.get(index.entityId);
    if (table === undefined) continue;
    const columns = [...index.columns].sort((a, b) => a.ordinal - b.ordinal);
    const keyColumns = columns.filter((c) => c.role !== 'include');
    const keyIds = keyColumns.flatMap((c) => (c.fieldId === null ? [] : [c.fieldId]));
    const fieldIds = keyIds.length === columns.length ? keyIds : null;
    if (fieldIds !== null && !allVisible(fieldIds)) {
      skip('index', index.id, 'it references a column not in this export');
      continue;
    }
    const where = index.propsRedacted === true ? undefined : propString(index.engineProps, 'where');
    // A plain unique index on columns is a unique key to every ORM.
    if (index.isUnique && fieldIds !== null && where === undefined) {
      if (!table.uniqueSets.has(setKey(fieldIds))) {
        (table.uniques as PlannedKey[]).push({ name: index.name, fieldIds });
        table.uniqueSets.add(setKey(fieldIds));
      }
      continue;
    }
    (table.indexes as PlannedIndex[]).push({
      index,
      fieldIds,
      descending: new Set(
        keyColumns.flatMap((c) =>
          c.direction === 'desc' && c.fieldId !== null ? [c.fieldId] : [],
        ),
      ),
      method: dialect.indexMethod(index),
      where,
    });
  }

  const links = Object.values(model.objects.link)
    .filter((l) => {
      if (l.restricted === true) {
        skip('link', l.id, 'hidden from the requester');
        return false;
      }
      return l.kind === 'foreignKey';
    })
    .sort(byName);
  const pair = (l: Link): string => [l.from.entityId, l.to.entityId].sort(compare).join('|');
  const pairCount = new Map<string, number>();
  for (const l of links) pairCount.set(pair(l), (pairCount.get(pair(l)) ?? 0) + 1);
  for (const link of links) {
    const child = tables.get(link.from.entityId);
    const parent = tables.get(link.to.entityId);
    if (child === undefined || parent === undefined) {
      if (
        model.objects.entity[link.from.entityId]?.restricted === true ||
        model.objects.entity[link.to.entityId]?.restricted === true
      ) {
        skip('link', link.id, 'one of its tables is not in this export');
      }
      continue;
    }
    if (
      !allVisible(link.from.fieldIds) ||
      !allVisible(link.to.fieldIds) ||
      link.from.fieldIds.length !== link.to.fieldIds.length
    ) {
      skip('link', link.id, 'it references a column not in this export');
      continue;
    }
    const props = link.propsRedacted === true ? {} : link.engineProps;
    const fk: PlannedForeignKey = {
      link,
      child,
      parent,
      fromIds: link.from.fieldIds,
      toIds: link.to.fieldIds,
      onDelete: propString(props, 'onDelete') ?? 'noAction',
      onUpdate: propString(props, 'onUpdate') ?? 'noAction',
      optional: link.from.fieldIds.some((id) => fieldById.get(id)?.isNullable !== false),
      oneToOne: child.uniqueSets.has(setKey(link.from.fieldIds)),
      ambiguous: child === parent || (pairCount.get(pair(link)) ?? 0) > 1,
    };
    child.outgoing.push(fk);
    parent.incoming.push(fk);
  }

  return {
    tables: [...tables.values()],
    views,
    enums: found.enums,
    fieldById,
    skipped,
    diagnostics,
  };
}

/** Tables with every parent first, so languages that need a class before its use get one;
 *  a cycle keeps the remaining tables in name order. */
export function parentsFirst(tables: readonly PlannedTable[]): PlannedTable[] {
  const out: PlannedTable[] = [];
  const done = new Set<PlannedTable>();
  const visiting = new Set<PlannedTable>();
  const visit = (table: PlannedTable): void => {
    if (done.has(table) || visiting.has(table)) return;
    visiting.add(table);
    for (const fk of table.outgoing) visit(fk.parent);
    visiting.delete(table);
    done.add(table);
    out.push(table);
  };
  for (const table of tables) visit(table);
  return out;
}

/** A SQL default, classified for writers that have literals of their own. */
export type DefaultValue =
  | { readonly kind: 'number'; readonly text: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'now' }
  | { readonly kind: 'sql'; readonly text: string };

export function classifyDefault(expression: string): DefaultValue {
  const sql = expression.trim();
  if (/^-?\d+(\.\d+)?$/.test(sql)) return { kind: 'number', text: sql };
  if (/^(true|false)$/i.test(sql)) return { kind: 'boolean', value: /^true$/i.test(sql) };
  if (/^(now\(\)|current_timestamp(\(\))?)$/i.test(sql)) return { kind: 'now' };
  const literal = /^'((?:[^']|'')*)'(?:::[\w\s."[\]]+)?$/.exec(sql);
  if (literal?.[1] !== undefined) return { kind: 'string', value: literal[1].replace(/''/g, "'") };
  return { kind: 'sql', text: sql };
}
