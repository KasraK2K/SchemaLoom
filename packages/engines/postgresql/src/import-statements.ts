import type { EngineProps, Entity, IndexColumn, IrObjectRef } from '@schemaloom/engine-sdk';
import { type ImportModel } from './import-model.js';
import {
  asNode,
  bool,
  children,
  defElements,
  int,
  minLocation,
  qualifiedFromList,
  rangeVar,
  str,
  stringList,
  typeName,
  unwrap,
  type AstNode,
} from './import-ast.js';
import { expressionText, viewBodyAfterAs } from './sql-scan.js';

/**
 * Doc 03 §9 — turning one parsed statement into IR.
 *
 * THE RULE THIS FILE EXISTS TO KEEP: nothing is dropped quietly. Every branch that cannot
 * represent something calls `ctx.loss(...)`, which turns the statement's report entry from
 * `applied` into `partial` with a sentence a user can read. A `return` with no `loss` call is
 * a bug, not a shortcut.
 *
 * TWO PASSES, because DDL is not in dependency order. `declareStatement` creates namespaces,
 * types, entities and fields; `dependentStatement` creates everything that names one of those
 * by name — constraints, indexes and foreign keys, including the ones written inline inside a
 * `CREATE TABLE` whose target table appears later in the file.
 */

export interface StatementContext {
  readonly model: ImportModel;
  /** the statement's own text; every `location` in its parse tree is an offset into this */
  readonly text: string;
  loss(message: string): void;
  /** The statement is refused outright — what PostgreSQL itself would reject. */
  fail(message: string): void;
  produced(ref: IrObjectRef): void;
}

/** PostgreSQL's own answer to a second CREATE of the same relation. Checked BEFORE
 *  `addEntity`, so the duplicate never reaches the model (or the store's unique index). */
function alreadyExists(target: { schema?: string; name: string }, ctx: StatementContext): boolean {
  if (!ctx.model.hasEntity(target.schema, target.name)) return false;
  ctx.fail(`relation "${target.name}" already exists`);
  return true;
}

export type StatementPhase = 'declare' | 'dependent' | 'both' | 'ignored' | 'unsupported';

export interface StatementClass {
  readonly phase: StatementPhase;
  /** engine-native label, shown in the report list */
  readonly kind: string;
  /** required whenever the phase is 'ignored' or 'unsupported' */
  readonly reason?: string;
}

const IGNORED: Readonly<Record<string, { kind: string; reason: string }>> = {
  VariableSetStmt: { kind: 'SET', reason: 'Session settings do not describe the schema' },
  TransactionStmt: {
    kind: 'TRANSACTION',
    reason: 'Transaction control does not describe the schema',
  },
  CommentStmt: {
    kind: 'COMMENT',
    // Replaced per statement when pass 4 can't turn it into a doc (`import-comments.ts`).
    reason: 'Comments become docs only on tables, views and columns',
  },
  SelectStmt: { kind: 'SELECT', reason: 'A query does not describe the schema' },
  GrantStmt: { kind: 'GRANT', reason: 'Privileges are managed by SchemaLoom, not by the schema' },
};

const UNSUPPORTED: Readonly<Record<string, { kind: string; reason: string }>> = {
  CreateTrigStmt: { kind: 'CREATE TRIGGER', reason: 'Triggers are not part of the schema model' },
  CreateFunctionStmt: {
    kind: 'CREATE FUNCTION',
    reason: 'Functions and procedures are not part of the schema model',
  },
  CreatePolicyStmt: {
    kind: 'CREATE POLICY',
    reason: 'Row-level security policies are not part of the schema model',
  },
  RuleStmt: { kind: 'CREATE RULE', reason: 'Rules are not part of the schema model' },
  CreateSeqStmt: {
    kind: 'CREATE SEQUENCE',
    reason: 'Standalone sequences are not part of the schema model; identity columns are',
  },
  CreateExtensionStmt: {
    kind: 'CREATE EXTENSION',
    reason: 'Extensions are installed on the server, not described by the schema',
  },
  DropStmt: { kind: 'DROP', reason: 'An import adds to the model; it never drops from it' },
};

export function classify(statement: unknown): StatementClass {
  const node = asNode(statement);
  const tag = node === undefined ? undefined : Object.keys(node)[0];
  if (tag === undefined) {
    return { phase: 'unsupported', kind: 'unknown', reason: 'Unrecognised statement' };
  }

  const ignored = IGNORED[tag];
  if (ignored !== undefined) return { phase: 'ignored', ...ignored };
  const unsupported = UNSUPPORTED[tag];
  if (unsupported !== undefined) return { phase: 'unsupported', ...unsupported };

  switch (tag) {
    case 'CreateSchemaStmt':
      return { phase: 'declare', kind: 'CREATE SCHEMA' };
    case 'CreateEnumStmt':
      return { phase: 'declare', kind: 'CREATE TYPE' };
    case 'CreateDomainStmt':
      return { phase: 'declare', kind: 'CREATE DOMAIN' };
    case 'CompositeTypeStmt':
      return { phase: 'declare', kind: 'CREATE TYPE' };
    case 'ViewStmt':
      return { phase: 'declare', kind: 'CREATE VIEW' };
    case 'CreateTableAsStmt':
      return { phase: 'declare', kind: 'CREATE MATERIALIZED VIEW' };
    case 'CreateStmt':
      return { phase: 'both', kind: 'CREATE TABLE' };
    case 'IndexStmt':
      return { phase: 'dependent', kind: 'CREATE INDEX' };
    case 'AlterTableStmt':
      return { phase: 'dependent', kind: 'ALTER TABLE' };
    default:
      return {
        phase: 'unsupported',
        kind: tag,
        reason: `${tag} is not part of the schema model`,
      };
  }
}

// --- pass 1: declarations ----------------------------------------------------------------

export function declareStatement(statement: unknown, ctx: StatementContext): void {
  const schema = unwrap(statement, 'CreateSchemaStmt');
  if (schema !== undefined) {
    declareSchema(schema, ctx);
    return;
  }

  const enumType = unwrap(statement, 'CreateEnumStmt');
  if (enumType !== undefined) {
    declareEnum(enumType, ctx);
    return;
  }

  const domain = unwrap(statement, 'CreateDomainStmt');
  if (domain !== undefined) {
    declareDomain(domain, ctx);
    return;
  }

  const composite = unwrap(statement, 'CompositeTypeStmt');
  if (composite !== undefined) {
    declareComposite(composite, ctx);
    return;
  }

  const view = unwrap(statement, 'ViewStmt');
  if (view !== undefined) {
    declareView(view, ctx);
    return;
  }

  const matview = unwrap(statement, 'CreateTableAsStmt');
  if (matview !== undefined) {
    declareMaterializedView(matview, ctx);
    return;
  }

  const table = unwrap(statement, 'CreateStmt');
  if (table !== undefined) {
    declareTable(table, ctx);
    return;
  }
}

function declareSchema(node: AstNode, ctx: StatementContext): void {
  const name = str(node, 'schemaname');
  if (name === undefined) {
    ctx.loss('the schema has no name');
    return;
  }
  const owner = asNode(node.authrole);
  const props: EngineProps = {};
  const ownerName = owner === undefined ? undefined : str(owner, 'rolename');
  if (ownerName !== undefined) props.owner = ownerName;
  const created = ctx.model.ensureNamespace(name);
  if (ownerName !== undefined) {
    ctx.model.namespace[created.id] = { ...created, engineProps: props };
  }
  ctx.produced({ type: 'namespace', id: created.id });
}

function declareEnum(node: AstNode, ctx: StatementContext): void {
  const qualified = qualifiedFromList(stringList(node, 'typeName'));
  if (qualified === undefined) {
    ctx.loss('the type has no name');
    return;
  }
  const labels: string[] = [];
  for (const value of children(node, 'vals')) {
    const body = unwrap(value, 'String');
    const label = body === undefined ? undefined : str(body, 'sval');
    if (label !== undefined) labels.push(label);
  }
  const created = ctx.model.addCustomType(qualified.schema, qualified.name, 'enum', { labels });
  ctx.produced({ type: 'customType', id: created.id });
}

function declareDomain(node: AstNode, ctx: StatementContext): void {
  const qualified = qualifiedFromList(stringList(node, 'domainname'));
  if (qualified === undefined) {
    ctx.loss('the domain has no name');
    return;
  }
  const namespace = ctx.model.resolveNamespace(qualified.schema);
  const base = typeName(node.typeName);
  const props: EngineProps = {};
  if (base !== undefined) props.baseType = ctx.model.typeSpelling(namespace.id, base);
  else ctx.loss('the domain has no base type');

  const checks: string[] = [];
  for (const wrapper of children(node, 'constraints')) {
    const constraint = unwrap(wrapper, 'Constraint');
    if (constraint === undefined) continue;
    const type = str(constraint, 'contype');
    if (type === 'CONSTR_NOTNULL') props.notNull = true;
    else if (type === 'CONSTR_DEFAULT') {
      const text = expressionAtOf(ctx.text, constraint.raw_expr);
      if (text !== undefined) props.default = text;
    } else if (type === 'CONSTR_CHECK') {
      const text = expressionAtOf(ctx.text, constraint.raw_expr);
      if (text !== undefined) checks.push(text);
      else ctx.loss('a CHECK on the domain could not be read');
    }
  }
  if (checks.length > 0) props.checks = checks;

  const created = ctx.model.addCustomType(qualified.schema, qualified.name, 'domain', props);
  ctx.produced({ type: 'customType', id: created.id });
}

function declareComposite(node: AstNode, ctx: StatementContext): void {
  const target = rangeVar(node.typevar);
  if (target === undefined) {
    ctx.loss('the type has no name');
    return;
  }
  const namespace = ctx.model.resolveNamespace(target.schema);
  const attributes: { name: string; type: string }[] = [];
  for (const wrapper of children(node, 'coldeflist')) {
    const column = unwrap(wrapper, 'ColumnDef');
    const name = column === undefined ? undefined : str(column, 'colname');
    const type = column === undefined ? undefined : typeName(column.typeName);
    if (name === undefined || type === undefined) {
      ctx.loss('an attribute of the type could not be read');
      continue;
    }
    attributes.push({ name, type: ctx.model.typeSpelling(namespace.id, type) });
  }
  const created = ctx.model.addCustomType(target.schema, target.name, 'composite', { attributes });
  ctx.produced({ type: 'customType', id: created.id });
}

function declareView(node: AstNode, ctx: StatementContext): void {
  const target = rangeVar(node.view);
  if (target === undefined) {
    ctx.loss('the view has no name');
    return;
  }
  const props: EngineProps = {};
  const body = viewBodyAfterAs(ctx.text);
  if (body === null) ctx.loss('the view definition could not be read back as SQL');
  else props.viewDefinition = body;

  const checkOption = str(node, 'withCheckOption');
  if (checkOption === 'LOCAL_CHECK_OPTION') props.checkOption = 'local';
  else if (checkOption === 'CASCADED_CHECK_OPTION') props.checkOption = 'cascaded';

  if (alreadyExists(target, ctx)) return;
  const created = ctx.model.addEntity(target.schema, target.name, 'view', props);
  ctx.produced({ type: 'entity', id: created.id });
  declareViewColumns(node.query, created, ctx);
}

function declareMaterializedView(node: AstNode, ctx: StatementContext): void {
  if (str(node, 'objtype') !== 'OBJECT_MATVIEW') {
    ctx.loss('CREATE TABLE … AS copies data; only materialized views are modelled');
    return;
  }
  const into = asNode(node.into);
  const target = into === undefined ? undefined : rangeVar(into.rel);
  if (target === undefined) {
    ctx.loss('the materialized view has no name');
    return;
  }
  const props: EngineProps = {};
  const body = viewBodyAfterAs(ctx.text);
  if (body === null) ctx.loss('the view definition could not be read back as SQL');
  else props.viewDefinition = body;
  if (into !== undefined && !bool(into, 'skipData')) props.withData = true;
  const tablespace = into === undefined ? undefined : str(into, 'tableSpaceName');
  if (tablespace !== undefined) props.tablespace = tablespace;

  if (alreadyExists(target, ctx)) return;
  const created = ctx.model.addEntity(target.schema, target.name, 'materializedView', props);
  ctx.produced({ type: 'entity', id: created.id });
  declareViewColumns(node.query, created, ctx);
}

/**
 * A view's columns come from its SELECT list, and only the shallowest shape is knowable
 * without resolving the query: an explicit alias, or a bare column reference. `SELECT *` and
 * expressions with no alias produce nothing, and say so.
 *
 * ponytail: the alternative is a name resolver over the whole query — the exporter re-emits
 * the stored `viewDefinition` verbatim, so nothing downstream depends on the column list
 * being complete. Upgrade path is resolving `SelectStmt.fromClause` against the symbol table.
 */
function declareViewColumns(query: unknown, entity: Entity, ctx: StatementContext): void {
  const select = unwrap(query, 'SelectStmt');
  if (select === undefined) return;
  let unresolved = 0;

  for (const wrapper of children(select, 'targetList')) {
    const target = unwrap(wrapper, 'ResTarget');
    if (target === undefined) continue;
    const alias = str(target, 'name');
    const columnRef = unwrap(target.val, 'ColumnRef');
    const parts = columnRef === undefined ? [] : stringList(columnRef, 'fields');
    const name = alias ?? parts[parts.length - 1];
    if (name === undefined) {
      unresolved += 1;
      continue;
    }
    ctx.model.addField(entity, name, { name: 'text' }, true, {});
  }

  if (unresolved > 0) {
    ctx.loss(`${String(unresolved)} of the view's columns could not be named without running it`);
  }
}

function declareTable(node: AstNode, ctx: StatementContext): void {
  const target = rangeVar(node.relation);
  if (target === undefined) {
    ctx.loss('the table has no name');
    return;
  }

  const props: EngineProps = {};
  if (str(node, 'relpersistence') === 'u') props.unlogged = true;
  const tablespace = str(node, 'tablespacename');
  if (tablespace !== undefined) props.tablespace = tablespace;
  const fillfactor = defElements(node, 'options').get('fillfactor');
  if (typeof fillfactor === 'number') props.fillfactor = fillfactor;

  const partition = partitionSpec(node);
  if (partition !== undefined) props.partitionBy = partition;
  else if (asNode(node.partspec) !== undefined) {
    ctx.loss('the partition key is not a plain column list and was not imported');
  }
  if (children(node, 'inhRelations').length > 0) {
    ctx.loss('table inheritance is not part of the schema model');
  }

  if (alreadyExists(target, ctx)) return;
  const entity = ctx.model.addEntity(target.schema, target.name, 'table', props);
  ctx.produced({ type: 'entity', id: entity.id });

  const limits = elementBoundaries(node);
  for (const wrapper of children(node, 'tableElts')) {
    const column = unwrap(wrapper, 'ColumnDef');
    if (column === undefined) continue; // a table-level Constraint; pass 2 owns it
    declareColumn(column, entity, ctx, limits);
  }
}

function partitionSpec(node: AstNode): { strategy: string; expression: string } | undefined {
  const spec = asNode(node.partspec);
  if (spec === undefined) return undefined;
  const raw = str(spec, 'strategy') ?? '';
  const strategy = raw.replace('PARTITION_STRATEGY_', '').toLowerCase();
  if (strategy !== 'range' && strategy !== 'list' && strategy !== 'hash') return undefined;

  const columns: string[] = [];
  for (const wrapper of children(spec, 'partParams')) {
    const element = unwrap(wrapper, 'PartitionElem');
    const name = element === undefined ? undefined : str(element, 'name');
    if (name === undefined) return undefined;
    columns.push(name);
  }
  return columns.length === 0 ? undefined : { strategy, expression: columns.join(', ') };
}

function declareColumn(
  column: AstNode,
  entity: Entity,
  ctx: StatementContext,
  limits: readonly number[],
): void {
  const name = str(column, 'colname');
  const parsed = typeName(column.typeName);
  if (name === undefined || parsed === undefined) {
    ctx.loss('a column could not be read');
    return;
  }

  const props: EngineProps = {};
  let isNullable = true;
  const collation = stringList(asNode(column.collClause) ?? {}, 'collname');
  const collationName = collation[collation.length - 1];
  if (collationName !== undefined) props.collation = collationName;
  const storage = str(column, 'storage_name');
  if (storage !== undefined) props.storage = storage.toLowerCase();
  const compression = str(column, 'compression');
  if (compression !== undefined) props.compression = compression.toLowerCase();

  for (const wrapper of children(column, 'constraints')) {
    const constraint = unwrap(wrapper, 'Constraint');
    if (constraint === undefined) continue;
    switch (str(constraint, 'contype')) {
      case 'CONSTR_NOTNULL':
        isNullable = false;
        break;
      case 'CONSTR_DEFAULT': {
        const text = expressionAtOf(ctx.text, constraint.raw_expr, limits);
        if (text !== undefined) props.default = text;
        else ctx.loss(`the DEFAULT on "${name}" could not be read back as SQL`);
        break;
      }
      case 'CONSTR_GENERATED': {
        const text = expressionAtOf(ctx.text, constraint.raw_expr, limits);
        if (text !== undefined) props.generatedExpression = text;
        else ctx.loss(`the generated expression on "${name}" could not be read back as SQL`);
        break;
      }
      case 'CONSTR_IDENTITY':
        props.identity = str(constraint, 'generated_when') === 'd' ? 'byDefault' : 'always';
        break;
      default:
        break; // PRIMARY KEY / UNIQUE / CHECK / REFERENCES are pass 2's
    }
  }

  const field = ctx.model.addField(
    entity,
    name,
    ctx.model.buildTypeRef(entity.namespaceId, parsed.name, parsed.args, parsed.dimensions),
    isNullable,
    props,
  );
  ctx.produced({ type: 'field', id: field.id });
}

// --- pass 2: everything that names a declared object ---------------------------------------

export function dependentStatement(statement: unknown, ctx: StatementContext): void {
  const table = unwrap(statement, 'CreateStmt');
  if (table !== undefined) {
    tableConstraints(table, ctx);
    return;
  }

  const index = unwrap(statement, 'IndexStmt');
  if (index !== undefined) {
    createIndex(index, ctx);
    return;
  }

  const alter = unwrap(statement, 'AlterTableStmt');
  if (alter !== undefined) {
    alterTable(alter, ctx);
    return;
  }
}

function tableConstraints(node: AstNode, ctx: StatementContext): void {
  const target = rangeVar(node.relation);
  const entity =
    target === undefined ? undefined : ctx.model.findEntity(target.schema, target.name);
  if (entity === undefined) return; // pass 1 already reported why

  const limits = elementBoundaries(node);

  for (const wrapper of children(node, 'tableElts')) {
    const column = unwrap(wrapper, 'ColumnDef');
    if (column !== undefined) {
      const columnName = str(column, 'colname');
      if (columnName === undefined) continue;
      for (const inner of children(column, 'constraints')) {
        const constraint = unwrap(inner, 'Constraint');
        if (constraint !== undefined) {
          applyConstraint(constraint, entity, ctx, limits, [columnName]);
        }
      }
      continue;
    }
    const constraint = unwrap(wrapper, 'Constraint');
    if (constraint !== undefined) applyConstraint(constraint, entity, ctx, limits, null);
  }
}

/** `columnsFromContext` is non-null for a constraint written inline on a column, where the
 *  parse tree does not repeat the column name. */
function applyConstraint(
  constraint: AstNode,
  entity: Entity,
  ctx: StatementContext,
  limits: readonly number[],
  columnsFromContext: readonly string[] | null,
): void {
  const type = str(constraint, 'contype');
  const name = str(constraint, 'conname') ?? '';
  const props: EngineProps = {};
  if (bool(constraint, 'deferrable')) props.deferrable = true;
  if (bool(constraint, 'initdeferred')) props.initiallyDeferred = true;

  const named = (key: string): readonly string[] =>
    columnsFromContext ?? stringList(constraint, key);

  switch (type) {
    case 'CONSTR_PRIMARY':
    case 'CONSTR_UNIQUE': {
      const columns = named('keys');
      const fields = ctx.model.findFields(entity, columns);
      if (fields === undefined) {
        ctx.loss(`a constraint on "${entity.name}" names a column that is not in this import`);
        return;
      }
      if (type === 'CONSTR_UNIQUE' && bool(constraint, 'nulls_not_distinct')) {
        props.nullsNotDistinct = true;
      }
      const created = ctx.model.addConstraint(
        entity,
        name,
        type === 'CONSTR_PRIMARY' ? 'primaryKey' : 'unique',
        fields.map((f) => f.id),
        props,
      );
      ctx.produced({ type: 'constraint', id: created.id });
      return;
    }
    case 'CONSTR_CHECK': {
      const text = expressionAtOf(ctx.text, constraint.raw_expr, limits);
      if (text === undefined) {
        ctx.loss(`a CHECK on "${entity.name}" could not be read back as SQL`);
        return;
      }
      props.expression = text;
      if (bool(constraint, 'is_no_inherit')) props.noInherit = true;
      // `fieldIds` is deliberately empty: a CHECK body names its columns in SQL text, and
      // `extractReferences` is what turns that text into ids (§3.1).
      const created = ctx.model.addConstraint(entity, name, 'check', [], props);
      ctx.produced({ type: 'constraint', id: created.id });
      return;
    }
    case 'CONSTR_EXCLUSION': {
      ctx.loss(`an EXCLUDE constraint on "${entity.name}" was not imported`);
      return;
    }
    case 'CONSTR_FOREIGN':
      applyForeignKey(constraint, entity, ctx, columnsFromContext);
      return;
    default:
      return; // NOT NULL / DEFAULT / GENERATED / IDENTITY were pass 1's
  }
}

const FK_ACTION: Readonly<Record<string, string>> = {
  r: 'restrict',
  c: 'cascade',
  n: 'setNull',
  d: 'setDefault',
};

function applyForeignKey(
  constraint: AstNode,
  entity: Entity,
  ctx: StatementContext,
  columnsFromContext: readonly string[] | null,
): void {
  const target = rangeVar(constraint.pktable);
  const to = target === undefined ? undefined : ctx.model.findEntity(target.schema, target.name);
  if (to === undefined) {
    ctx.loss(`the foreign key on "${entity.name}" references a table that is not in this import`);
    return;
  }

  const fromNames = columnsFromContext ?? stringList(constraint, 'fk_attrs');
  const fromFields = ctx.model.findFields(entity, fromNames);
  if (fromFields === undefined) {
    ctx.loss(`the foreign key on "${entity.name}" names a column that is not in this import`);
    return;
  }

  // `REFERENCES customers` with no column list means the target's primary key. The PK is a
  // `Constraint` created by this same pass, so resolving it here would depend on statement
  // order; naming no columns is the shape the IR already has for "endpoint not yet chosen".
  const toNames = stringList(constraint, 'pk_attrs');
  const toFields = toNames.length === 0 ? [] : ctx.model.findFields(to, toNames);
  if (toFields === undefined) {
    ctx.loss(`the foreign key on "${entity.name}" names a target column not in this import`);
    return;
  }
  if (toNames.length === 0) {
    ctx.loss(
      `the foreign key on "${entity.name}" relies on the target's primary key, which it does not name`,
    );
  }

  const props: EngineProps = {};
  const onDelete = FK_ACTION[str(constraint, 'fk_del_action') ?? 'a'];
  const onUpdate = FK_ACTION[str(constraint, 'fk_upd_action') ?? 'a'];
  if (onDelete !== undefined) props.onDelete = onDelete;
  if (onUpdate !== undefined) props.onUpdate = onUpdate;
  if (str(constraint, 'fk_matchtype') === 'f') props.matchFull = true;
  if (bool(constraint, 'deferrable')) props.deferrable = true;
  if (bool(constraint, 'initdeferred')) props.initiallyDeferred = true;

  const created = ctx.model.addLink(
    str(constraint, 'conname') ?? '',
    { entity, fieldIds: fromFields.map((f) => f.id) },
    { entity: to, fieldIds: toFields.map((f) => f.id) },
    props,
  );
  ctx.produced({ type: 'link', id: created.id });
}

function createIndex(node: AstNode, ctx: StatementContext): void {
  const target = rangeVar(node.relation);
  const entity =
    target === undefined ? undefined : ctx.model.findEntity(target.schema, target.name);
  if (entity === undefined) {
    ctx.loss('the index is on a table that is not in this import');
    return;
  }

  const props: EngineProps = {};
  if (bool(node, 'concurrent')) props.concurrently = true;
  if (bool(node, 'nulls_not_distinct')) props.nullsNotDistinct = true;
  const tablespace = str(node, 'tableSpace');
  if (tablespace !== undefined) props.tablespace = tablespace;
  const fillfactor = defElements(node, 'options').get('fillfactor');
  if (typeof fillfactor === 'number') props.fillfactor = fillfactor;
  const where = expressionAtOf(ctx.text, node.whereClause);
  if (where !== undefined) props.where = where;
  else if (asNode(node.whereClause) !== undefined) {
    ctx.loss('the partial-index predicate could not be read back as SQL');
  }

  const columns: IndexColumn[] = [];
  let dropped = 0;
  const readElements = (key: string, role: 'key' | 'include'): void => {
    for (const wrapper of children(node, key)) {
      const element = unwrap(wrapper, 'IndexElem');
      if (element === undefined) continue;
      const column = indexColumn(element, entity, ctx, role, columns.length);
      if (column === null) dropped += 1;
      else columns.push(column);
    }
  };
  readElements('indexParams', 'key');
  readElements('indexIncludingParams', 'include');

  if (dropped > 0) ctx.loss(`${String(dropped)} index column(s) could not be imported`);
  if (columns.length === 0) {
    ctx.loss('the index has no column this import could resolve');
    return;
  }

  const created = ctx.model.addIndex(
    entity,
    str(node, 'idxname') ?? '',
    str(node, 'accessMethod') ?? 'btree',
    bool(node, 'unique'),
    columns,
    props,
  );
  ctx.produced({ type: 'index', id: created.id });
}

function indexColumn(
  element: AstNode,
  entity: Entity,
  ctx: StatementContext,
  role: 'key' | 'include',
  ordinal: number,
): IndexColumn | null {
  const props: EngineProps = {};
  const opclass = stringList(element, 'opclass');
  const opclassName = opclass[opclass.length - 1];
  if (opclassName !== undefined) props.opclass = opclassName;
  const collation = stringList(element, 'collation');
  const collationName = collation[collation.length - 1];
  if (collationName !== undefined) props.collation = collationName;
  const nulls = str(element, 'nulls_ordering');
  if (nulls === 'SORTBY_NULLS_FIRST') props.nullsOrder = 'first';
  else if (nulls === 'SORTBY_NULLS_LAST') props.nullsOrder = 'last';

  const ordering = str(element, 'ordering');
  const direction: 'asc' | 'desc' | undefined =
    ordering === 'SORTBY_DESC' ? 'desc' : ordering === 'SORTBY_ASC' ? 'asc' : undefined;
  const base = {
    ordinal,
    role,
    engineProps: props,
    ...(direction === undefined ? {} : { direction }),
  };

  const name = str(element, 'name');
  if (name !== undefined) {
    const field = ctx.model.findField(entity, name);
    return field === undefined ? null : { ...base, fieldId: field.id, expression: null };
  }

  const expression = expressionAtOf(ctx.text, element.expr);
  return expression === undefined ? null : { ...base, fieldId: null, expression };
}

function alterTable(node: AstNode, ctx: StatementContext): void {
  const target = rangeVar(node.relation);
  const entity =
    target === undefined ? undefined : ctx.model.findEntity(target.schema, target.name);
  if (entity === undefined) {
    ctx.loss('the ALTER TABLE names a table that is not in this import');
    return;
  }

  for (const wrapper of children(node, 'cmds')) {
    const command = unwrap(wrapper, 'AlterTableCmd');
    if (command === undefined) continue;
    const subtype = str(command, 'subtype');
    if (subtype === 'AT_ColumnDefault') {
      setColumnDefault(command, entity, ctx);
      continue;
    }
    if (subtype === 'AT_AddIdentity') {
      addIdentity(command, entity, ctx);
      continue;
    }
    if (subtype !== 'AT_AddConstraint') {
      ctx.loss(`${subtype ?? 'an ALTER TABLE action'} is not part of the schema model`);
      continue;
    }
    const constraint = unwrap(command.def, 'Constraint');
    if (constraint === undefined) {
      ctx.loss('the added constraint could not be read');
      continue;
    }
    applyConstraint(constraint, entity, ctx, [], null);
  }
}

/** `ALTER COLUMN … SET DEFAULT expr` — what pg_dump writes for every serial column, after the
 *  table. `import-serial.ts` later folds the `nextval` ones back into `serial`. */
function setColumnDefault(command: AstNode, entity: Entity, ctx: StatementContext): void {
  const name = str(command, 'name');
  const field = name === undefined ? undefined : ctx.model.findField(entity, name);
  if (field === undefined) {
    ctx.loss(`the column "${name ?? ''}" is not in this import`);
    return;
  }
  if (command.def === undefined) {
    ctx.loss(`DROP DEFAULT on "${field.name}" is not applied: an import only adds`);
    return;
  }
  const text = expressionAtOf(ctx.text, command.def);
  if (text === undefined) {
    ctx.loss(`the DEFAULT on "${field.name}" could not be read back as SQL`);
    return;
  }
  ctx.model.updateField(field, { engineProps: { ...field.engineProps, default: text } });
  ctx.produced({ type: 'field', id: field.id });
}

/** `ALTER COLUMN … ADD GENERATED … AS IDENTITY (SEQUENCE NAME …)` — how pg_dump writes an
 *  identity column. The sequence options are pg_dump's bookkeeping, not the design. */
function addIdentity(command: AstNode, entity: Entity, ctx: StatementContext): void {
  const name = str(command, 'name');
  const field = name === undefined ? undefined : ctx.model.findField(entity, name);
  const constraint = unwrap(command.def, 'Constraint');
  if (field === undefined || constraint === undefined) {
    ctx.loss(`the identity on "${name ?? ''}" could not be read`);
    return;
  }
  const identity = str(constraint, 'generated_when') === 'd' ? 'byDefault' : 'always';
  ctx.model.updateField(field, { engineProps: { ...field.engineProps, identity } });
  ctx.produced({ type: 'field', id: field.id });
}

// --- expression text ----------------------------------------------------------------------

/**
 * The SQL text of an expression node, recovered from the source by offset.
 *
 * `libpg-query` parses and does not deparse, and doc 04 §2.6 stores a `DEFAULT`, a CHECK body
 * and a partial predicate as engine-syntax STRINGS. `limits` are the offsets where the next
 * sibling element of a `CREATE TABLE` element list begins, which is what stops
 * `DEFAULT now() NOT NULL` from capturing `NOT NULL`.
 */
function expressionAtOf(
  source: string,
  node: unknown,
  limits: readonly number[] = [],
): string | undefined {
  const start = minLocation(node);
  if (start === undefined) return undefined;
  const limit = limits.find((offset) => offset > start);
  const text = expressionText(source, start, limit);
  return text.length === 0 ? undefined : text;
}

/** Every element boundary inside a `CREATE TABLE (...)`: each column and each constraint,
 *  ascending. Used only as an upper bound on an expression's extent. */
function elementBoundaries(node: AstNode): readonly number[] {
  const offsets: number[] = [];
  const push = (value: unknown): void => {
    const child = asNode(value);
    const location = child === undefined ? undefined : int(child, 'location');
    if (location !== undefined && location >= 0) offsets.push(location);
  };

  for (const wrapper of children(node, 'tableElts')) {
    const column = unwrap(wrapper, 'ColumnDef');
    if (column !== undefined) {
      push(column);
      for (const inner of children(column, 'constraints')) push(unwrap(inner, 'Constraint'));
      continue;
    }
    push(unwrap(wrapper, 'Constraint'));
  }
  return offsets.sort((a, b) => a - b);
}
