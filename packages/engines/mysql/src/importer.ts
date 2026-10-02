import type {
  Diagnostic,
  EngineProps,
  Entity,
  Field,
  Id,
  ImportContext,
  ImportedDoc,
  ImportOptions,
  ImportReport,
  ImportResult,
  ImportStatementReport,
  ImportStatementStatus,
  Importer,
  IndexColumn,
  IrObjectRef,
  IrObjectType,
  SchemaModel,
  TypeRef,
} from '@schemaloom/engine-sdk';
import { CAPABILITIES, isMariaDb } from './capabilities.js';
import { ImportModel } from './import-model.js';
import { CODE } from './messages.js';
import { loadMySqlParser, parseErrorMessage, type Ast, type MySqlParser } from './parser.js';
import { seatReferences } from './references.js';
import {
  excerptOf,
  leadingWords,
  normaliseForParser,
  rangeOf,
  splitStatements,
  type Normalised,
  type SourceChunk,
} from './sql-scan.js';
import { TYPE_CATALOG } from './types.js';

/**
 * The MySQL / MariaDB DDL importer (doc 03 §9, design §4). Same rule as PostgreSQL's: every
 * statement in the source is accounted for — applied, partial (with what was lost), ignored or
 * unsupported (with why), or failed (with the parse error).
 *
 * Three passes over one statement list, in source order: declare tables and views; then
 * foreign keys, `ALTER TABLE` and `CREATE INDEX`, which may name a table declared later; then
 * comments become docs. `COMMENT '…'` on a table or column becomes `ImportResult.docs`.
 */

type Phase = 'declare' | 'dependent' | 'ignored' | 'unsupported';

interface Classified {
  readonly phase: Phase;
  readonly kind: string;
  readonly reason?: string;
}

const IGNORED = (kind: string, reason: string): Classified => ({ phase: 'ignored', kind, reason });
const UNSUPPORTED = (kind: string, reason: string): Classified => ({
  phase: 'unsupported',
  kind,
  reason,
});

/** Classified by leading keywords, before any parsing: most of a dump is framing. */
export function classify(text: string): Classified {
  const [a = '', b = '', c = ''] = leadingWords(text);
  const two = `${a} ${b}`;
  if (a === 'SET') return IGNORED('SET', 'Session settings do not describe the schema');
  if (a === 'USE') return IGNORED('USE', 'A project models one database');
  if (a === 'LOCK' || a === 'UNLOCK') return IGNORED(two, 'Table locks do not describe the schema');
  if (['START', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT'].includes(a)) {
    return IGNORED('TRANSACTION', 'Transaction control does not describe the schema');
  }
  if (['INSERT', 'REPLACE', 'UPDATE', 'DELETE', 'TRUNCATE', 'LOAD'].includes(a)) {
    return IGNORED(a, 'Data does not describe the schema');
  }
  if (a === 'SELECT' || a === 'WITH' || a === 'SHOW' || a === 'EXPLAIN') {
    return IGNORED(a, 'A query does not describe the schema');
  }
  if (
    ['GRANT', 'REVOKE', 'FLUSH'].includes(a) ||
    (a === 'CREATE' && ['USER', 'ROLE'].includes(b))
  ) {
    return IGNORED(
      a === 'CREATE' ? two : a,
      'Privileges are managed by SchemaLoom, not by the schema',
    );
  }
  if ((a === 'CREATE' || a === 'DROP' || a === 'ALTER') && (b === 'DATABASE' || b === 'SCHEMA')) {
    return IGNORED(two, 'A project models one database');
  }
  if (a === 'DROP') return IGNORED(two, 'A drop removes objects; an import only adds them');
  if (a === 'CREATE') {
    const what = b === 'OR' ? (leadingWords(text, 8)[3] ?? '') : b;
    if (what === 'TRIGGER')
      return UNSUPPORTED('CREATE TRIGGER', 'Triggers are not part of the schema model');
    if (what === 'PROCEDURE' || what === 'FUNCTION' || (what === 'AGGREGATE' && c === 'FUNCTION')) {
      return UNSUPPORTED(`CREATE ${what}`, 'Stored routines are not part of the schema model');
    }
    if (what === 'EVENT')
      return UNSUPPORTED('CREATE EVENT', 'Scheduled events are not part of the schema model');
    if (what === 'SEQUENCE')
      return UNSUPPORTED('CREATE SEQUENCE', 'Sequences are not part of the schema model');
    if (what === 'TABLE' || (what === 'TEMPORARY' && c === 'TABLE'))
      return { phase: 'declare', kind: 'CREATE TABLE' };
    if (
      what === 'VIEW' ||
      what === 'ALGORITHM=UNDEFINED' ||
      /^ALGORITHM|^SQL$|^DEFINER/.test(what) ||
      leadingWords(text, 8).includes('VIEW')
    ) {
      return { phase: 'declare', kind: 'CREATE VIEW' };
    }
    if (['INDEX', 'UNIQUE', 'FULLTEXT', 'SPATIAL'].includes(what)) {
      return { phase: 'dependent', kind: 'CREATE INDEX' };
    }
    // A misspelt CREATE goes to the parser, which reports the syntax error.
    return { phase: 'declare', kind: 'unparsed' };
  }
  if (a === 'ALTER' && b === 'TABLE') return { phase: 'dependent', kind: 'ALTER TABLE' };
  if (a === 'RENAME' || a === 'ANALYZE' || a === 'OPTIMIZE') {
    return IGNORED(a, 'Maintenance statements do not describe the schema');
  }
  return UNSUPPORTED(a === '' ? 'unknown' : a, 'Not a statement SchemaLoom models');
}

interface StatementState {
  readonly chunk: SourceChunk;
  readonly classified: Classified;
  readonly normalised: Normalised | null;
  ast: readonly Ast[];
  parseError: string | null;
  readonly produced: IrObjectRef[];
  readonly losses: string[];
  failure: string | null;
}

/** What one statement's handlers may do. */
interface Ctx {
  readonly model: ImportModel;
  readonly parser: MySqlParser;
  readonly state: StatementState;
  readonly docs: Map<Id, ImportedDoc>;
  /** FKs declared inside a CREATE TABLE wait for pass 2: the target may come later. */
  readonly deferred: (() => void)[];
}

// --- AST access --------------------------------------------------------------------------

const isAst = (v: unknown): v is Ast => typeof v === 'object' && v !== null && !Array.isArray(v);
const get = (node: unknown, key: string): unknown => (isAst(node) ? node[key] : undefined);
const text = (node: unknown, key: string): string | undefined => {
  const v = get(node, key);
  return typeof v === 'string' ? v : undefined;
};
const list = (node: unknown, key: string): readonly unknown[] => {
  const v = get(node, key);
  return Array.isArray(v) ? v : [];
};

/** `'it''s'` and `'it\'s'` → `it's` */
const unquote = (s: string): string =>
  s
    .replace(/^'([\s\S]*)'$/, '$1')
    .replace(/''/g, "'")
    .replace(/\\'/g, "'");

/** A string or number as text; anything else (an AST node) is not a value. */
const plain = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

const isField = (field: Field | undefined): field is Field => field !== undefined;

function tableName(node: unknown): string | undefined {
  const first: unknown = Array.isArray(node) ? (node as readonly unknown[])[0] : node;
  return text(first, 'table');
}

function columnName(node: unknown): string | undefined {
  const column = get(node, 'column');
  if (typeof column === 'string') return column;
  // newer node-sql-parser builds wrap it: { expr: { type: 'default', value } }
  const value = get(get(column, 'expr'), 'value');
  return typeof value === 'string' ? value : undefined;
}

// --- types -------------------------------------------------------------------------------

const INTEGERS = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint']);

function typeRef(definition: unknown): { type: TypeRef; props: EngineProps } {
  const raw = (text(definition, 'dataType') ?? 'unknown').toLowerCase();
  const length = get(definition, 'length');
  const scale = get(definition, 'scale');
  const suffix = list(definition, 'suffix').map((s) => String(s).toUpperCase());
  const props: EngineProps = {};
  if (suffix.includes('UNSIGNED')) props.unsigned = true;
  if (suffix.includes('ZEROFILL')) props.zerofill = true;

  // tinyint(1) is how MySQL spells BOOLEAN back; other integer display widths are deprecated.
  if (raw === 'tinyint' && length === 1 && props.unsigned !== true) {
    return { type: TYPE_CATALOG.buildRef({ name: 'boolean' }, CONTEXT), props };
  }
  let args: (string | number)[] = [];
  if (raw === 'enum' || raw === 'set') {
    args = list(get(definition, 'expr'), 'value').map((v) => unquote(plain(get(v, 'value'))));
  } else if (!INTEGERS.has(raw) && typeof length === 'number') {
    args = typeof scale === 'number' ? [length, scale] : [length];
  }
  return {
    type: TYPE_CATALOG.buildRef({ name: raw, ...(args.length > 0 ? { args } : {}) }, CONTEXT),
    props,
  };
}

const CONTEXT = { customTypes: [], namespaceName: null };

// --- column definitions ------------------------------------------------------------------

function defaultText(ctx: Ctx, value: unknown): string | undefined {
  if (!isAst(value) || value.type === 'null') return undefined;
  const { over: _onUpdate, ...rest } = value;
  const sql = ctx.parser.expression(rest);
  // MySQL's SHOW CREATE quotes a numeric default (`'0.00'`) and MariaDB's doesn't; both
  // spell CURRENT_TIMESTAMP, MariaDB with `()`. One form, so neither reads as drift.
  if (value.type === 'number') return `'${sql}'`;
  if (/^current_timestamp\(\)$/i.test(sql)) return 'CURRENT_TIMESTAMP';
  return value.parentheses === true && value.type === 'function' && !/^current_timestamp/i.test(sql)
    ? `(${sql})`
    : sql;
}

function onUpdateText(ctx: Ctx, value: unknown): string | undefined {
  const over = get(value, 'over');
  if (text(over, 'type') !== 'on update') return undefined;
  const keyword = text(over, 'keyword') ?? 'CURRENT_TIMESTAMP';
  const args = list(get(over, 'expr'), 'value').map((v) => ctx.parser.expression(v));
  return get(over, 'parentheses') === true && args.length > 0
    ? `${keyword}(${args.join(', ')})`
    : keyword;
}

function declareColumn(ctx: Ctx, entity: Entity, def: Ast): Field | undefined {
  const name = columnName(def.column);
  if (name === undefined) {
    ctx.state.losses.push('a column has no name');
    return undefined;
  }
  const { type, props } = typeRef(def.definition);
  const nullable = text(def.nullable, 'type');
  const defaultValue = defaultText(ctx, get(def.default_val, 'value'));
  if (defaultValue !== undefined) props.default = defaultValue;
  const onUpdate = onUpdateText(ctx, get(def.default_val, 'value'));
  if (onUpdate !== undefined) props.onUpdate = onUpdate;
  if (def.auto_increment !== undefined && def.auto_increment !== null) props.autoIncrement = true;
  const charset = text(get(def.character_set, 'value'), 'value');
  const collation = text(get(def.collate, 'collate'), 'name');
  // A collation names its charset (`utf8mb4_unicode_ci`), and SHOW CREATE TABLE spells both
  // where a design says only COLLATE. Keeping the redundant one would read as drift.
  if (charset !== undefined && !collation?.toLowerCase().startsWith(`${charset.toLowerCase()}_`)) {
    props.charset = charset;
  }
  if (collation !== undefined) props.collation = collation;
  if (isAst(def.generated)) {
    props.generatedExpression = ctx.parser.expression(def.generated.expr);
    props.generatedKind =
      text(def.generated, 'storage_type')?.toUpperCase() === 'STORED' ? 'STORED' : 'VIRTUAL';
  }
  const recovered = ctx.state.normalised?.columnAttributes.get(name);
  if (recovered?.srid !== undefined) props.srid = recovered.srid;
  if (recovered?.invisible === true) props.invisible = true;

  // A PRIMARY KEY column is NOT NULL whatever it says.
  const isNullable = nullable !== 'not null' && def.primary_key === undefined;
  const field = ctx.model.addField(entity, name, type, isNullable, props);
  ctx.state.produced.push({ type: 'field', id: field.id });

  const comment = text(get(def.comment, 'value'), 'value');
  if (comment !== undefined && comment !== '') {
    ctx.docs.set(field.id, { target: { type: 'field', id: field.id }, text: unquote(comment) });
  }
  if (def.primary_key !== undefined) addKey(ctx, entity, 'primaryKey', 'PRIMARY', [field]);
  if (def.unique !== undefined) addKey(ctx, entity, 'unique', name, [field]);
  if (isAst(def.reference_definition)) {
    ctx.state.losses.push(
      'MySQL ignores a REFERENCES clause written on the column; declare it as FOREIGN KEY (…)',
    );
  }
  return field;
}

function addKey(
  ctx: Ctx,
  entity: Entity,
  kind: 'primaryKey' | 'unique',
  name: string,
  fields: readonly Field[],
): void {
  if (kind === 'primaryKey') {
    if (ctx.model.constraintsOf(entity).some((c) => c.kind === 'primaryKey')) {
      ctx.state.losses.push('a second primary key is not kept');
      return;
    }
    for (const field of fields) ctx.model.updateField(field, { isNullable: false });
  }
  const created = ctx.model.addConstraint(
    entity,
    kind === 'primaryKey' ? 'PRIMARY' : name,
    kind,
    fields.map((f) => f.id),
    {},
  );
  ctx.state.produced.push({ type: 'constraint', id: created.id });
}

// --- keys, indexes, checks, foreign keys ------------------------------------------------

/** A key part: a column, a column prefix `name(20)`, or an expression `(lower(email))`. */
function keyPart(ctx: Ctx, entity: Entity, part: unknown, ordinal: number): IndexColumn | string {
  const direction = text(part, 'order_by')?.toLowerCase();
  const dir =
    direction === 'desc'
      ? { direction: 'desc' as const }
      : direction === 'asc'
        ? { direction: 'asc' as const }
        : {};
  if (text(part, 'type') === 'function' && get(part, 'parentheses') !== true) {
    // `a(10)` in CREATE INDEX parses as a call: a column with a prefix length.
    const fn = text(list(get(part, 'name'), 'name')[0], 'value');
    const arg = get(list(get(part, 'args'), 'value')[0], 'value');
    const field = fn === undefined ? undefined : ctx.model.findField(entity, fn);
    if (field !== undefined && typeof arg === 'number') {
      return {
        ordinal,
        fieldId: field.id,
        expression: null,
        role: 'key',
        ...dir,
        engineProps: { length: arg },
      };
    }
  }
  if (text(part, 'type') === 'function' || text(part, 'type') === 'binary_expr') {
    const { order_by: _o, ...expr } = part as Ast;
    return {
      ordinal,
      fieldId: null,
      expression: ctx.parser.expression({ ...expr, parentheses: false }),
      role: 'key',
      ...dir,
      engineProps: {},
    };
  }
  const name = columnName(part);
  const field = name === undefined ? undefined : ctx.model.findField(entity, name);
  if (field === undefined) return name ?? 'an unnamed column';
  const prefix = /^\((\d+)\)$/.exec(text(part, 'suffix') ?? '')?.[1];
  return {
    ordinal,
    fieldId: field.id,
    expression: null,
    role: 'key',
    ...dir,
    engineProps: prefix === undefined ? {} : { length: Number(prefix) },
  };
}

function keyParts(
  ctx: Ctx,
  entity: Entity,
  parts: readonly unknown[],
): readonly IndexColumn[] | undefined {
  const columns: IndexColumn[] = [];
  for (const [i, part] of parts.entries()) {
    const column = keyPart(ctx, entity, part, i);
    if (typeof column === 'string') {
      ctx.state.losses.push(`an index names a column “${column}” that is not in the table`);
      return undefined;
    }
    columns.push(column);
  }
  return columns;
}

function indexKind(keyword: string | undefined, indexType: string | null | undefined): string {
  const k = `${keyword ?? ''} ${indexType ?? ''}`.toLowerCase();
  if (k.includes('fulltext')) return 'fulltext';
  if (k.includes('spatial')) return 'spatial';
  return 'btree';
}

function indexOptions(options: readonly unknown[]): EngineProps {
  const props: EngineProps = {};
  for (const option of options) if (text(option, 'type') === 'invisible') props.invisible = true;
  return props;
}

function declareIndex(
  ctx: Ctx,
  entity: Entity,
  name: string | undefined,
  kind: string,
  isUnique: boolean,
  parts: readonly unknown[],
  options: readonly unknown[],
): void {
  const columns = keyParts(ctx, entity, parts);
  if (columns === undefined || columns.length === 0) return;
  // A plain UNIQUE KEY over whole columns is a unique constraint; one with a prefix or an
  // expression stays an index, because a constraint has no room for either.
  const simple = columns.every(
    (c) => c.fieldId !== null && c.engineProps.length === undefined && c.direction === undefined,
  );
  const fallback = columnFieldName(ctx, entity, columns[0]) ?? 'idx';
  const finalName = uniqueIndexName(ctx, entity, name ?? fallback);
  if (isUnique && simple && kind === 'btree' && Object.keys(indexOptions(options)).length === 0) {
    addKey(
      ctx,
      entity,
      'unique',
      finalName,
      columns.map((c) => ctx.model.field[c.fieldId ?? '']).filter(isField),
    );
    return;
  }
  const created = ctx.model.addIndex(
    entity,
    finalName,
    kind,
    isUnique,
    columns,
    indexOptions(options),
  );
  ctx.state.produced.push({ type: 'index', id: created.id });
}

function columnFieldName(
  ctx: Ctx,
  _entity: Entity,
  column: IndexColumn | undefined,
): string | undefined {
  return column?.fieldId === null || column === undefined
    ? undefined
    : ctx.model.field[column.fieldId]?.name;
}

/** MySQL names an unnamed index after its first column, adding `_2`, `_3` on a clash. */
function uniqueIndexName(ctx: Ctx, entity: Entity, base: string): string {
  if (!ctx.model.hasIndexNamed(entity, base)) return base;
  for (let n = 2; ; n += 1) {
    if (!ctx.model.hasIndexNamed(entity, `${base}_${String(n)}`)) return `${base}_${String(n)}`;
  }
}

function declareCheck(ctx: Ctx, entity: Entity, def: Ast): void {
  const expression = list(def, 'definition')[0];
  if (expression === undefined) {
    ctx.state.losses.push('a CHECK has no expression');
    return;
  }
  const checks = ctx.model.constraintsOf(entity).filter((c) => c.kind === 'check').length;
  const name = text(def, 'constraint') ?? `${entity.name}_chk_${String(checks + 1)}`;
  const props: EngineProps = { expression: stripOuterParens(ctx.parser.expression(expression)) };
  if (ctx.state.normalised?.notEnforced.has(name) === true) props.notEnforced = true;
  const created = ctx.model.addConstraint(entity, name, 'check', [], props);
  ctx.state.produced.push({ type: 'constraint', id: created.id });
}

const stripOuterParens = (sql: string): string => {
  const trimmed = sql.trim();
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return trimmed;
  let depth = 0;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === '(') depth += 1;
    else if (trimmed[i] === ')' && (depth -= 1) === 0 && i < trimmed.length - 1) return trimmed;
  }
  return trimmed.slice(1, -1).trim();
};

/** RESTRICT is the default, so it imports as no prop: MariaDB's SHOW CREATE leaves it out,
 *  MySQL's writes it, and either way the same key must not read as drift. */
const ACTIONS: Readonly<Record<string, string | undefined>> = {
  'no action': 'noAction',
  restrict: undefined,
  cascade: 'cascade',
  'set null': 'setNull',
  'set default': 'setDefault',
};

function declareForeignKey(ctx: Ctx, entity: Entity, def: Ast): void {
  const reference = def.reference_definition;
  const target = tableName(get(reference, 'table'));
  const to = target === undefined ? undefined : ctx.model.findEntity(target);
  if (to === undefined) {
    ctx.state.losses.push(
      `a foreign key references “${target ?? '?'}”, which is not in this source`,
    );
    return;
  }
  const fromNames = list(def, 'definition').map(columnName);
  const toNames = list(reference, 'definition').map(columnName);
  const fromFields = fromNames.every((n) => n !== undefined)
    ? ctx.model.findFields(entity, fromNames)
    : undefined;
  const toFields = toNames.every((n) => n !== undefined)
    ? ctx.model.findFields(to, toNames)
    : undefined;
  if (fromFields === undefined || toFields?.length !== fromFields.length) {
    ctx.state.losses.push('a foreign key names columns that are not in its tables');
    return;
  }
  const props: EngineProps = {};
  for (const action of list(reference, 'on_action')) {
    const value = ACTIONS[plain(get(get(action, 'value'), 'value')).toLowerCase()];
    if (value === undefined) continue;
    if (text(action, 'type') === 'on delete') props.onDelete = value;
    if (text(action, 'type') === 'on update') props.onUpdate = value;
  }
  const name =
    text(def, 'constraint') ?? `${entity.name}_ibfk_${String(ctx.model.linkCount(entity) + 1)}`;
  const created = ctx.model.addLink(
    name,
    { entity, fieldIds: fromFields.map((f) => f.id) },
    { entity: to, fieldIds: toFields.map((f) => f.id) },
    props,
  );
  ctx.state.produced.push({ type: 'link', id: created.id });
}

/** One entry of a CREATE TABLE body or an ALTER TABLE … ADD. */
function declareDefinition(ctx: Ctx, entity: Entity, def: Ast, deferForeignKeys: boolean): void {
  const resource = text(def, 'resource');
  if (resource === 'column') {
    declareColumn(ctx, entity, def);
    return;
  }
  if (resource === 'index') {
    declareIndex(
      ctx,
      entity,
      text(def, 'index'),
      indexKind(text(def, 'keyword'), text(def, 'index_type')),
      false,
      list(def, 'definition'),
      list(def, 'index_options'),
    );
    return;
  }
  if (resource !== 'constraint') return;
  const type = (text(def, 'constraint_type') ?? '').toLowerCase();
  if (type === 'primary key') {
    const fields = keyParts(ctx, entity, list(def, 'definition'));
    if (fields !== undefined)
      addKey(
        ctx,
        entity,
        'primaryKey',
        'PRIMARY',
        fields.map((c) => ctx.model.field[c.fieldId ?? '']).filter(isField),
      );
  } else if (type.startsWith('unique')) {
    declareIndex(
      ctx,
      entity,
      text(def, 'index') ?? text(def, 'constraint'),
      'btree',
      true,
      list(def, 'definition'),
      list(def, 'index_options'),
    );
  } else if (type === 'check') {
    declareCheck(ctx, entity, def);
  } else if (type === 'foreign key') {
    if (deferForeignKeys)
      ctx.deferred.push(() => {
        declareForeignKey(ctx, entity, def);
      });
    else declareForeignKey(ctx, entity, def);
  } else {
    ctx.state.losses.push(`a ${type} constraint is not kept`);
  }
}

// --- statements --------------------------------------------------------------------------

const ENGINES: Readonly<Record<string, string>> = {
  innodb: 'InnoDB',
  myisam: 'MyISAM',
  memory: 'MEMORY',
  archive: 'ARCHIVE',
  csv: 'CSV',
  aria: 'Aria',
};

function tableProps(ctx: Ctx, entity: Entity, options: readonly unknown[]): EngineProps {
  const props: EngineProps = {};
  for (const option of options) {
    const keyword = (text(option, 'keyword') ?? '').toLowerCase();
    const value = get(option, 'value');
    const plain =
      typeof value === 'string'
        ? value
        : typeof value === 'number'
          ? String(value)
          : (text(value, 'value') ?? '');
    if (keyword === 'engine') props.engine = ENGINES[plain.toLowerCase()] ?? plain;
    else if (keyword.includes('charset') || keyword.includes('character set'))
      props.charset = plain;
    else if (keyword.includes('collate')) props.collation = plain;
    else if (keyword === 'row_format') props.rowFormat = plain.toUpperCase();
    else if (keyword === 'comment' && unquote(plain) !== '') {
      ctx.docs.set(entity.id, { target: { type: 'entity', id: entity.id }, text: unquote(plain) });
    }
  }
  return props;
}

function createTable(ctx: Ctx, ast: Ast): void {
  const name = tableName(ast.table);
  if (name === undefined) {
    ctx.state.failure = 'the table has no name';
    return;
  }
  if (ast.like !== undefined && ast.like !== null) {
    ctx.state.failure = 'CREATE TABLE … LIKE copies another table; define the columns instead';
    return;
  }
  if (ctx.model.findEntity(name) !== undefined) {
    ctx.state.losses.push(`“${name}” is already defined above; the first definition is kept`);
    return;
  }
  const entity = ctx.model.addEntity(name, 'table', {});
  ctx.state.produced.push({ type: 'entity', id: entity.id });
  ctx.model.setEntityProps(entity, tableProps(ctx, entity, list(ast, 'table_options')));
  // Columns first: a key may be listed before the column it names.
  const definitions = list(ast, 'create_definitions').filter(isAst);
  for (const def of definitions)
    if (text(def, 'resource') === 'column') declareColumn(ctx, entity, def);
  for (const def of definitions)
    if (text(def, 'resource') !== 'column') declareDefinition(ctx, entity, def, true);
  if (ast.query_expr !== undefined && ast.query_expr !== null)
    ctx.state.losses.push(
      'CREATE TABLE … AS SELECT copies data; only the declared columns are kept',
    );
}

/** The SELECT exactly as written, after `AS`; a trailing `WITH … CHECK OPTION` is a prop. */
function viewBody(source: string): { body: string; checkOption?: 'LOCAL' | 'CASCADED' } | null {
  const match = /\bVIEW\s+(?:`(?:[^`]|``)+`|[\w$.]+)(?:\s*\([^)]*\))?\s+AS\s+([\s\S]+)$/i.exec(
    source,
  );
  const raw = match?.[1]?.trim();
  if (raw === undefined || raw === '') return null;
  const check = /\s+WITH\s+(?:(LOCAL|CASCADED)\s+)?CHECK\s+OPTION\s*$/i.exec(raw);
  if (check === null) return { body: raw };
  return {
    body: raw.slice(0, check.index).trim(),
    checkOption: (check[1]?.toUpperCase() as 'LOCAL' | 'CASCADED' | undefined) ?? 'CASCADED',
  };
}

function createView(ctx: Ctx, ast: Ast, source: string): void {
  const name = text(get(ast, 'view'), 'view');
  if (name === undefined) {
    ctx.state.failure = 'the view has no name';
    return;
  }
  const props: EngineProps = {};
  const body = viewBody(source);
  if (body === null) ctx.state.losses.push('the view definition could not be read');
  else {
    props.viewDefinition = body.body;
    if (body.checkOption !== undefined) props.checkOption = body.checkOption;
  }
  const algorithm = text(ast, 'algorithm')?.toUpperCase();
  if (algorithm === 'MERGE' || algorithm === 'TEMPTABLE' || algorithm === 'UNDEFINED')
    props.algorithm = algorithm;
  const security = text(ast, 'sql_security')?.toUpperCase();
  if (security === 'DEFINER' || security === 'INVOKER') props.sqlSecurity = security;

  const existing = ctx.model.findEntity(name);
  let entity: Entity;
  if (existing?.kind === 'view') {
    entity = ctx.model.replaceView(existing, props);
  } else if (existing !== undefined) {
    ctx.state.losses.push(`“${name}” is already a table; the view is not kept`);
    return;
  } else {
    entity = ctx.model.addEntity(name, 'view', props);
  }
  ctx.state.produced.push({ type: 'entity', id: entity.id });

  const declared = list(ast, 'columns').map(String);
  const names =
    declared.length > 0
      ? declared
      : list(get(ast, 'select'), 'columns').map((c) => text(c, 'as') ?? columnName(get(c, 'expr')));
  let unnamed = 0;
  for (const column of names) {
    if (column === undefined || column === '*') {
      unnamed += 1;
      continue;
    }
    ctx.model.addField(entity, column, { name: 'text' }, true, {});
  }
  if (unnamed > 0)
    ctx.state.losses.push(
      `${String(unnamed)} of the view's columns could not be named without running it`,
    );
}

function alterTable(ctx: Ctx, ast: Ast): void {
  const name = tableName(ast.table);
  const entity = name === undefined ? undefined : ctx.model.findEntity(name);
  if (entity === undefined) {
    ctx.state.failure = `the table “${name ?? '?'}” is not defined in this source`;
    return;
  }
  for (const expr of list(ast, 'expr').filter(isAst)) {
    const action = text(expr, 'action');
    if (text(expr, 'resource') === 'comment') {
      const comment = unquote(plain(get(expr, 'comment')));
      if (comment !== '')
        ctx.docs.set(entity.id, { target: { type: 'entity', id: entity.id }, text: comment });
      continue;
    }
    if (action === 'modify' && text(expr, 'resource') === 'column') {
      // The exporter's way of commenting a column; anything else MODIFY changes is not
      // applied, because an import only adds.
      const column = columnName(expr.column);
      const field = column === undefined ? undefined : ctx.model.findField(entity, column);
      const comment = text(get(expr.comment, 'value'), 'value');
      if (field !== undefined && comment !== undefined) {
        if (comment !== '')
          ctx.docs.set(field.id, {
            target: { type: 'field', id: field.id },
            text: unquote(comment),
          });
        continue;
      }
    }
    if (action !== 'add') {
      ctx.state.losses.push(
        `ALTER TABLE … ${(action ?? text(expr, 'keyword') ?? 'change').toUpperCase()} is not applied: an import only adds`,
      );
      continue;
    }
    const definition = isAst(expr.create_definitions) ? expr.create_definitions : expr;
    declareDefinition(ctx, entity, definition, false);
  }
}

function createIndex(ctx: Ctx, ast: Ast): void {
  const name = tableName(ast.table);
  const entity = name === undefined ? undefined : ctx.model.findEntity(name);
  if (entity === undefined) {
    ctx.state.failure = `the table “${name ?? '?'}” is not defined in this source`;
    return;
  }
  const type = text(ast, 'index_type');
  declareIndex(
    ctx,
    entity,
    text(ast, 'index'),
    indexKind(undefined, type),
    type === 'unique',
    list(ast, 'index_columns'),
    list(ast, 'index_options'),
  );
}

// --- the pipeline ------------------------------------------------------------------------

function statusOf(state: StatementState): { status: ImportStatementStatus; reason: string | null } {
  if (state.parseError !== null) return { status: 'failed', reason: state.parseError };
  if (state.failure !== null) return { status: 'failed', reason: state.failure };
  const { phase, reason } = state.classified;
  if (phase === 'ignored')
    return { status: 'ignored', reason: reason ?? 'not part of the schema model' };
  if (phase === 'unsupported')
    return { status: 'unsupported', reason: reason ?? 'not part of the schema model' };
  const losses = [...(state.normalised?.losses ?? []), ...state.losses];
  if (losses.length > 0) return { status: 'partial', reason: losses.join('; ') };
  return { status: 'applied', reason: null };
}

function countObjects(model: SchemaModel): Partial<Record<IrObjectType, number>> {
  const counts: Partial<Record<IrObjectType, number>> = {};
  for (const [type, bag] of Object.entries(model.objects)) {
    const size = Object.keys(bag).length;
    if (size > 0) counts[type as IrObjectType] = size;
  }
  return counts;
}

async function importDdl(
  source: string,
  options: ImportOptions,
  ictx: ImportContext,
): Promise<ImportResult> {
  const descriptor =
    CAPABILITIES.importFormats.find((f) => f.id === options.format) ??
    CAPABILITIES.importFormats[0];
  const maxBytes = descriptor?.maxBytes ?? source.length;
  const truncated = new TextEncoder().encode(source).length > maxBytes;
  const input = truncated
    ? new TextDecoder()
        .decode(new TextEncoder().encode(source).slice(0, maxBytes))
        .replace(/�$/, '')
    : source;

  const parser = await loadMySqlParser(isMariaDb(ictx.serverVersion));
  const model = new ImportModel(ictx.newId, options.defaultNamespace ?? '');
  const docs = new Map<Id, ImportedDoc>();
  const deferred: (() => void)[] = [];

  const states: StatementState[] = splitStatements(input).map((chunk) => {
    const classified = classify(chunk.text);
    const parsing = classified.phase === 'declare' || classified.phase === 'dependent';
    const normalised = parsing ? normaliseForParser(chunk.text) : null;
    const state: StatementState = {
      chunk,
      classified,
      normalised,
      ast: [],
      parseError: null,
      produced: [],
      losses: [],
      failure: null,
    };
    if (normalised !== null) {
      try {
        state.ast = parser.parse(normalised.text);
        if (state.ast.length === 0) state.parseError = 'the statement could not be read';
      } catch (error) {
        state.parseError = parseErrorMessage(error);
      }
    }
    return state;
  });

  const run = (state: StatementState, phase: Phase) => {
    if (state.parseError !== null || state.classified.phase !== phase) return;
    const ctx: Ctx = { model, parser, state, docs, deferred };
    for (const ast of state.ast) {
      const keyword = text(ast, 'keyword');
      if (phase === 'declare' && keyword === 'table') createTable(ctx, ast);
      else if (phase === 'declare' && keyword === 'view')
        createView(ctx, ast, state.normalised?.text ?? state.chunk.text);
      else if (phase === 'dependent' && text(ast, 'type') === 'alter') alterTable(ctx, ast);
      else if (phase === 'dependent' && keyword === 'index') createIndex(ctx, ast);
      else state.losses.push('part of the statement is not modelled');
    }
  };

  for (const state of states) run(state, 'declare');
  for (const job of deferred.splice(0)) job();
  for (const state of states) run(state, 'dependent');
  const built = model.toModel(ictx.projectId, ictx.serverVersion ?? '');

  const diagnostics: Diagnostic[] = [];
  const countsByStatus: Record<ImportStatementStatus, number> = {
    applied: 0,
    partial: 0,
    unsupported: 0,
    ignored: 0,
    failed: 0,
  };
  const statements: ImportStatementReport[] = states.map((state, ordinal) => {
    const { status, reason } = statusOf(state);
    countsByStatus[status] += 1;
    const range = rangeOf(input, state.chunk.start, state.chunk.end);
    if (status === 'failed') {
      diagnostics.push({
        code: CODE.importStatementFailed,
        severity: 'error',
        params: { reason: reason ?? '' },
        target: { type: 'project', id: ictx.projectId },
        range,
      });
    }
    return {
      ordinal,
      kind: state.classified.kind,
      range,
      excerpt: excerptOf(state.chunk.text),
      status,
      reason,
      // A placeholder view's columns were replaced by the real view's: drop refs to them.
      producedObjects: state.produced.filter(
        (ref) => built.objects[ref.type][ref.id] !== undefined,
      ),
    };
  });

  seatReferences(built);
  const report: ImportReport = {
    statementCount: statements.length,
    statements,
    countsByStatus,
    objectCounts: countObjects(built),
    truncated,
  };
  return {
    model: built,
    report,
    diagnostics,
    docs: [...docs.values()].filter((d) => built.objects[d.target.type][d.target.id] !== undefined),
  };
}

export const IMPORTER: Importer = {
  import(source, options, ctx) {
    return importDdl(source, options, ctx);
  },
};
