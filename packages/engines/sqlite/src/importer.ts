import { importPrisma } from '@schemaloom/orm';
import type {
  Constraint,
  Diagnostic,
  EngineProps,
  Entity,
  Field,
  Id,
  ImportContext,
  ImportOptions,
  ImportReport,
  ImportResult,
  ImportStatementReport,
  ImportStatementStatus,
  Importer,
  Index,
  IndexColumn,
  IrObjectRef,
  IrObjectType,
  Link,
  Namespace,
  SchemaModel,
  SourceRange,
  TypeRef,
} from '@schemaloom/engine-sdk';
import { CODE } from './messages.js';
import { normalizeName } from './normalize-name.js';
import { ORM_DIALECT } from './orm-types.js';
import { seatReferences } from './references.js';
import {
  classify,
  indexFacts,
  splitStatements,
  tableFacts,
  targetOf,
  viewBody,
  type Chunk,
  type StatementClass,
} from './sql-scan.js';
import { openMemory, quoteIdentifier, type Row, type Sqlite } from './sqlite.js';
import { TYPE_CATALOG } from './types.js';

/**
 * Phase 13 §4.1 — SQLite is its own parser. The allowlisted statements run, in order, in a
 * fresh in-memory database, and the model is read back with PRAGMAs, so what a statement
 * means is what SQLite says it means. A statement SQLite rejects is `failed` with SQLite's own
 * message. Nothing outside the allowlist is ever run (`classify`).
 */

const ACTIONS: Readonly<Record<string, string>> = {
  'NO ACTION': 'noAction',
  RESTRICT: 'restrict',
  CASCADE: 'cascade',
  'SET NULL': 'setNull',
  'SET DEFAULT': 'setDefault',
};

const BUILTIN = { customTypes: [], namespaceName: null };

/** `numeric(10, 2)` → name and arguments; `''` (no declared type) → none. */
export function declaredType(declared: string): TypeRef | null {
  const m = /^\s*([^(]*?)\s*(?:\(([^)]*)\))?\s*$/.exec(declared);
  const name = m?.[1]?.trim() ?? '';
  if (name === '') return null;
  const args = m?.[2]
    ?.split(',')
    .map((a) => a.trim())
    .filter((a) => a !== '')
    .map((a) => (/^-?\d+$/.test(a) ? Number(a) : a));
  return TYPE_CATALOG.buildRef(
    { name: name.toLowerCase(), ...(args === undefined || args.length === 0 ? {} : { args }) },
    BUILTIN,
  );
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));

/** The model as it stands in `db`, read with PRAGMAs. */
export function readModel(
  db: Sqlite,
  newId: () => Id,
  namespaceName: string,
  projectId: Id,
  engineVersion: string,
): SchemaModel {
  const namespaceId = newId();
  const namespace: Record<Id, Namespace> = {
    [namespaceId]: {
      id: namespaceId,
      name: namespaceName,
      version: 0,
      engineProps: {},
      isDefault: true,
    },
  };
  const entity: Record<Id, Entity> = {};
  const field: Record<Id, Field> = {};
  const constraint: Record<Id, Constraint> = {};
  const index: Record<Id, Index> = {};
  const link: Record<Id, Link> = {};

  const schema = db.all(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY rowid",
  );
  const tableList = new Map(
    db.all('PRAGMA table_list').map((r) => [normalizeName(str(r.name)), r] as const),
  );
  const tableByName = new Map<string, Entity>();
  const columnsOf = new Map<Id, Map<string, Field>>();

  const addEntity = (name: string, kind: 'table' | 'view', engineProps: EngineProps): Entity => {
    const created: Entity = {
      id: newId(),
      name,
      version: 0,
      engineProps,
      namespaceId,
      kind,
      areaId: null,
      position: { x: 0, y: 0 },
      color: null,
      doc: null,
    };
    entity[created.id] = created;
    tableByName.set(normalizeName(name), created);
    columnsOf.set(created.id, new Map());
    return created;
  };

  const readColumns = (owner: Entity, facts: ReturnType<typeof tableFacts> | null) => {
    let ordinal = 0;
    const columns = db.all(`PRAGMA table_xinfo(${quoteIdentifier(owner.name)})`);
    for (const column of columns) {
      const hidden = num(column.hidden);
      if (hidden === 1) continue;
      const name = str(column.name);
      const fact = facts?.columns.get(name.toLowerCase());
      const props: EngineProps = {};
      const dflt = column.dflt_value;
      if (typeof dflt === 'string' && dflt !== '') props.default = dflt;
      if (fact?.autoIncrement === true) props.autoIncrement = true;
      if (fact?.collation !== undefined) props.collation = fact.collation;
      if (fact?.generated !== undefined) {
        props.generatedExpression = fact.generated.expression;
        props.generatedKind = fact.generated.kind;
      }
      const created: Field = {
        id: newId(),
        name,
        version: 0,
        engineProps: props,
        entityId: owner.id,
        parentFieldId: null,
        ordinal: ordinal++,
        type: declaredType(str(column.type)) ?? TYPE_CATALOG.buildRef({ name: 'any' }, BUILTIN),
        isNullable: num(column.notnull) === 0,
        isRestricted: false,
        isPii: false,
        isDeprecated: false,
        doc: null,
      };
      field[created.id] = created;
      columnsOf.get(owner.id)?.set(normalizeName(name), created);
    }
  };

  const addConstraint = (
    owner: Entity,
    kind: string,
    name: string,
    fieldIds: readonly Id[],
    props: EngineProps = {},
  ) => {
    const created: Constraint = {
      id: newId(),
      name,
      version: 0,
      engineProps: props,
      entityId: owner.id,
      kind,
      fieldIds: [...fieldIds],
    };
    constraint[created.id] = created;
  };

  const tables = schema.filter((r) => r.type === 'table');
  for (const row of tables) {
    const name = str(row.name);
    const listed = tableList.get(normalizeName(name));
    const props: EngineProps = {};
    if (num(listed?.wr) === 1) props.withoutRowid = true;
    if (num(listed?.strict) === 1) props.strict = true;
    const table = addEntity(name, 'table', props);
    const facts = tableFacts(str(row.sql));
    readColumns(table, facts);
    const columns = columnsOf.get(table.id) ?? new Map<string, Field>();
    const byCid = db.all(`PRAGMA table_xinfo(${quoteIdentifier(name)})`);

    const pk = byCid
      .filter((c) => num(c.pk) > 0)
      .sort((a, b) => num(a.pk) - num(b.pk))
      .flatMap((c) => columns.get(normalizeName(str(c.name)))?.id ?? []);
    if (pk.length > 0)
      addConstraint(table, 'primaryKey', facts.primaryKeyName ?? `${name}_pkey`, pk);

    let n = 0;
    for (const [column, fact] of facts.columns) {
      for (const check of fact.checks) {
        addConstraint(table, 'check', check.name ?? `${name}_${column}_check`, [], {
          expression: check.expression,
        });
      }
    }
    for (const check of facts.checks) {
      n += 1;
      addConstraint(table, 'check', check.name ?? `${name}_check${n > 1 ? String(n) : ''}`, [], {
        expression: check.expression,
      });
    }
  }

  // Indexes and UNIQUE constraints, once every table's columns exist.
  for (const row of tables) {
    const table = tableByName.get(normalizeName(str(row.name)));
    if (table === undefined) continue;
    const columns = columnsOf.get(table.id) ?? new Map<string, Field>();
    for (const listed of db.all(`PRAGMA index_list(${quoteIdentifier(table.name)})`)) {
      const origin = str(listed.origin);
      const indexName = str(listed.name);
      if (origin === 'pk') continue;
      const keyColumns = db
        .all(`PRAGMA index_xinfo(${quoteIdentifier(indexName)})`)
        .filter((c) => num(c.key) === 1)
        .sort((a, b) => num(a.seqno) - num(b.seqno));
      if (origin === 'u') {
        const ids = keyColumns.flatMap((c) => columns.get(normalizeName(str(c.name)))?.id ?? []);
        const names = keyColumns.map((c) => str(c.name));
        addConstraint(table, 'unique', `${table.name}_${names.join('_')}_key`, ids);
        continue;
      }
      const sql = str(schema.find((r) => r.type === 'index' && r.name === indexName)?.sql);
      const facts = indexFacts(sql);
      const indexColumns: IndexColumn[] = keyColumns.map((c, ordinal) => {
        const cid = num(c.cid);
        const fieldId = cid >= 0 ? (columns.get(normalizeName(str(c.name)))?.id ?? null) : null;
        const coll = str(c.coll);
        return {
          ordinal,
          fieldId,
          expression: fieldId === null ? (facts.columns[ordinal] ?? '') : null,
          role: 'key',
          direction: num(c.desc) === 1 ? 'desc' : 'asc',
          engineProps: coll !== '' && coll.toUpperCase() !== 'BINARY' ? { collation: coll } : {},
        };
      });
      const created: Index = {
        id: newId(),
        name: indexName,
        version: 0,
        engineProps: facts.where === undefined ? {} : { where: facts.where },
        entityId: table.id,
        kind: 'btree',
        isUnique: num(listed.unique) === 1,
        columns: indexColumns,
      };
      index[created.id] = created;
    }

    // Foreign keys, grouped by id; a missing `to` means the parent's primary key.
    const groups = new Map<number, Row[]>();
    for (const fk of db.all(`PRAGMA foreign_key_list(${quoteIdentifier(table.name)})`)) {
      const id = num(fk.id);
      groups.set(id, [...(groups.get(id) ?? []), fk]);
    }
    for (const rows of [...groups.values()].map((g) => g.sort((a, b) => num(a.seq) - num(b.seq)))) {
      const parent = tableByName.get(normalizeName(str(rows[0]?.table)));
      if (parent === undefined) continue;
      const parentColumns = columnsOf.get(parent.id) ?? new Map<string, Field>();
      const from = rows.flatMap((r) => columns.get(normalizeName(str(r.from)))?.id ?? []);
      const parentKey = Object.values(constraint).find(
        (c) => c.entityId === parent.id && c.kind === 'primaryKey',
      )?.fieldIds;
      const to = rows.every((r) => typeof r.to === 'string' && r.to !== '')
        ? rows.flatMap((r) => parentColumns.get(normalizeName(str(r.to)))?.id ?? [])
        : [...(parentKey ?? [])];
      if (from.length === 0 || from.length !== to.length) continue;
      const created: Link = {
        id: newId(),
        name: `${table.name}_${rows.map((r) => str(r.from)).join('_')}_fkey`,
        version: 0,
        engineProps: {
          onDelete: ACTIONS[str(rows[0]?.on_delete).toUpperCase()] ?? 'noAction',
          onUpdate: ACTIONS[str(rows[0]?.on_update).toUpperCase()] ?? 'noAction',
        },
        kind: 'foreignKey',
        from: { entityId: table.id, fieldIds: from },
        to: { entityId: parent.id, fieldIds: to },
        cardinality: 'N:1',
      };
      link[created.id] = created;
    }
  }

  for (const row of schema.filter((r) => r.type === 'view')) {
    const definition = viewBody(str(row.sql));
    const view = addEntity(
      str(row.name),
      'view',
      definition === undefined ? {} : { viewDefinition: definition },
    );
    try {
      readColumns(view, null);
    } catch {
      // A view over a table that isn't there: SQLite stored it, but can't list its columns.
    }
  }

  return {
    irVersion: 1,
    projectId,
    engineId: 'sqlite',
    engineVersion,
    redacted: false,
    objects: { area: {}, namespace, customType: {}, entity, field, constraint, index, link },
  };
}

function rangeOf(source: string, start: number, end: number): SourceRange {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < start && i < source.length; i += 1) {
    if (source[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { start, end, line, column: start - lineStart + 1 };
}

const excerptOf = (text: string): string => {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= 200 ? collapsed : `${collapsed.slice(0, 199)}…`;
};

interface State {
  readonly chunk: Chunk;
  readonly cls: StatementClass;
  error: string | null;
}

export async function importDdl(
  source: string,
  options: ImportOptions,
  ctx: ImportContext,
): Promise<ImportResult> {
  const states: State[] = splitStatements(source).map((chunk) => ({
    chunk,
    cls: classify(chunk.text),
    error: null,
  }));

  const db = await openMemory();
  let model: SchemaModel;
  try {
    for (const state of states) {
      if (state.cls.action !== 'run') continue;
      try {
        db.exec(state.chunk.text);
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
      }
    }
    model = readModel(
      db,
      ctx.newId,
      options.defaultNamespace ?? '',
      ctx.projectId,
      ctx.serverVersion ?? '',
    );
  } finally {
    db.close();
  }

  // What each statement produced, found by the name it targets.
  const entityByName = new Map(
    Object.values(model.objects.entity).map((e) => [normalizeName(e.name), e] as const),
  );
  const producedBy = (state: State): IrObjectRef[] => {
    if (state.cls.action !== 'run' || state.error !== null) return [];
    const target = targetOf(state.chunk.text);
    if (target === null) return [];
    if (state.cls.kind === 'CREATE INDEX') {
      const found = Object.values(model.objects.index).find(
        (i) => normalizeName(i.name) === normalizeName(target.name),
      );
      return found === undefined ? [] : [{ type: 'index', id: found.id }];
    }
    const owner = entityByName.get(normalizeName(target.name));
    if (owner === undefined) return [];
    const fields = Object.values(model.objects.field).filter((f) => f.entityId === owner.id);
    if (state.cls.kind === 'ALTER TABLE') {
      const column = target.column;
      const added =
        column === undefined
          ? undefined
          : fields.find((f) => normalizeName(f.name) === normalizeName(column));
      return added === undefined ? [] : [{ type: 'field', id: added.id }];
    }
    if (state.cls.kind !== 'CREATE TABLE' && state.cls.kind !== 'CREATE VIEW') return [];
    return [
      { type: 'entity', id: owner.id },
      ...fields.map((f) => ({ type: 'field' as const, id: f.id })),
      ...Object.values(model.objects.constraint)
        .filter((c) => c.entityId === owner.id)
        .map((c) => ({ type: 'constraint' as const, id: c.id })),
      ...Object.values(model.objects.link)
        .filter((l) => l.from.entityId === owner.id)
        .map((l) => ({ type: 'link' as const, id: l.id })),
    ];
  };

  const diagnostics: Diagnostic[] = [];
  const countsByStatus: Record<ImportStatementStatus, number> = {
    applied: 0,
    partial: 0,
    unsupported: 0,
    ignored: 0,
    failed: 0,
  };
  const statements: ImportStatementReport[] = states.map((state, ordinal) => {
    const { cls } = state;
    const status: ImportStatementStatus =
      cls.action === 'run' ? (state.error === null ? 'applied' : 'failed') : cls.action;
    const reason = cls.action === 'run' ? state.error : cls.reason;
    countsByStatus[status] += 1;
    const range = rangeOf(source, state.chunk.start, state.chunk.end);
    if (status === 'failed') {
      diagnostics.push({
        code: CODE.importStatementFailed,
        severity: 'error',
        params: { reason: reason ?? '' },
        target: { type: 'project', id: ctx.projectId },
        range,
      });
    }
    return {
      ordinal,
      kind: cls.kind,
      range,
      excerpt: excerptOf(state.chunk.text),
      status,
      reason,
      producedObjects: producedBy(state),
    };
  });

  seatReferences(model);
  const objectCounts: Partial<Record<IrObjectType, number>> = {};
  for (const [type, bag] of Object.entries(model.objects)) {
    const size = Object.keys(bag).length;
    if (size > 0) objectCounts[type as IrObjectType] = size;
  }
  const report: ImportReport = {
    statementCount: statements.length,
    statements,
    countsByStatus,
    objectCounts,
    truncated: false,
  };
  return { model, report, diagnostics };
}

export const IMPORTER: Importer = {
  async import(source, options, ctx) {
    if (options.format !== 'prisma') return importDdl(source, options, ctx);
    const result = await importPrisma(source, options, ctx, ORM_DIALECT);
    seatReferences(result.model);
    return result;
  },
};
