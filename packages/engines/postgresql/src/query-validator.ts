import type {
  DiagnosticParam,
  Entity,
  Field,
  IdentifierResolution,
  IdentifierRole,
  QueryParseError,
  QueryValidationInput,
  QueryValidationResult,
  QueryValidator,
  ResolutionStatus,
} from '@schemaloom/engine-sdk';
import { createIndex, fieldsOf, findEntityByName, type ModelIndex } from '@schemaloom/schema-model';
import { CAPABILITIES } from './capabilities.js';
import {
  asArray,
  asNode,
  children,
  int,
  minLocation,
  nodeTag,
  statementsOf,
  str,
  unwrap,
  type AstNode,
} from './import-ast.js';
import { classify } from './import-statements.js';
import { CODE } from './messages.js';
import { normalizeName, utf8ByteLength } from './normalize-name.js';
import { loadSqlParser } from './parser.js';
import { rangeOf, skipNonCode, splitStatements, type SourceChunk } from './sql-scan.js';

/**
 * Doc 03 §12 — the query validator. Parses with the real PostgreSQL parser and resolves every
 * identifier against the REDACTED model through schema-model's folded index
 * (`createIndex(model, { normalizeName })` + `findEntityByName`, doc 04 §6.3).
 *
 * Resolution rules:
 *  - relations: schema-qualified, or `public` (PostgreSQL's default search_path). An
 *    unqualified name that matches a CTE in scope is `alias-local`.
 *  - columns: qualified by alias / table name / `schema.table`, or unqualified across the FROM
 *    scope, innermost query first (correlated subqueries see the outer FROM). >1 match in one
 *    scope is `ambiguous`. A column of a CTE, subquery, function or unknown relation cannot be
 *    known and is `unchecked`; so is an unqualified column when such a source is in scope.
 *  - CTE bodies and subqueries are resolved like any other query; only the columns they
 *    PRODUCE are unchecked. ORDER BY / GROUP BY may name an output alias (`alias-local`).
 *  - functions: role `function`, always `unchecked` (the IR has no functions).
 *  - `*` / `t.*` emits no identifier; it touches every VISIBLE field of the source(s). A
 *    masked field is never enumerated, and neither is a restricted one.
 *  - DDL: the object a CREATE names is `unchecked` (it does not exist yet, by design).
 *
 * Stubs and masked fields carry `name: ''` after redaction (doc 04 §10) and are skipped
 * explicitly as well, so no name — real or empty — ever resolves to one. `restrictedProbe` is
 * never called (§12.1, doc 05 L13 / P8): a hidden object and a typo are both `unknown`, and
 * `hiddenReferences` is always empty.
 */

const DEFAULT_SCHEMA = CAPABILITIES.defaultNamespaceName ?? 'public';

const DML_KINDS: Readonly<Record<string, string>> = {
  InsertStmt: 'INSERT',
  UpdateStmt: 'UPDATE',
  DeleteStmt: 'DELETE',
  MergeStmt: 'MERGE',
};

/** One entry of a FROM scope. `entity: null` = opaque (CTE, subquery, function, unknown). */
interface Source {
  readonly key: string;
  readonly entity: Entity | null;
  /** referenced by an alias rather than by its own name */
  readonly aliased: boolean;
}

interface Scope {
  readonly parent: Scope | null;
  readonly sources: Source[];
  readonly ctes: Set<string>;
  /** output-column names, visible to ORDER BY / GROUP BY only */
  readonly outputAliases: ReadonlySet<string>;
}

/** One dotted part of a name as written, absolute UTF-16 offsets into the whole query. */
interface Part {
  readonly start: number;
  readonly end: number;
  /** the name PostgreSQL sees: quoted verbatim, unquoted lower-cased; '*' for a star */
  readonly value: string;
}

function newScope(parent: Scope | null): Scope {
  return { parent, sources: [], ctes: new Set(), outputAliases: new Set() };
}

const IDENT_START = /[A-Za-z_\u0080-￿]/;
const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;

/** Skip whitespace and comments. */
function skipSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const char = text[i] ?? '';
    if (/\s/.test(char)) i += 1;
    else if ((char === '-' && text[i + 1] === '-') || (char === '/' && text[i + 1] === '*')) {
      i = skipNonCode(text, i) ?? i + 1;
    } else break;
  }
  return i;
}

/** One identifier (or `*`) at `i`, or null. */
function partAt(text: string, i: number): Part | null {
  const char = text[i];
  if (char === '*') return { start: i, end: i + 1, value: '*' };
  if (char === '"') {
    let j = i + 1;
    let value = '';
    while (j < text.length) {
      if (text[j] === '"') {
        if (text[j + 1] !== '"') return { start: i, end: j + 1, value };
        value += '"';
        j += 2;
      } else {
        value += text[j] ?? '';
        j += 1;
      }
    }
    return null;
  }
  if (char === undefined || !IDENT_START.test(char)) return null;
  let j = i + 1;
  while (j < text.length && IDENT_CHAR.test(text[j] ?? '')) j += 1;
  return { start: i, end: j, value: text.slice(i, j).toLowerCase() };
}

/** `a . "B" . c` starting at `from`. */
function partsAt(text: string, from: number): Part[] {
  const parts: Part[] = [];
  let i = from;
  for (;;) {
    const part = partAt(text, i);
    if (part === null) return parts;
    parts.push(part);
    const dot = skipSpace(text, part.end);
    if (text[dot] !== '.' || part.value === '*') return parts;
    i = skipSpace(text, dot + 1);
  }
}

/** Index just past the `)` matching the `(` at `open`. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const skip = skipNonCode(text, i);
    if (skip !== null) {
      i = skip;
      continue;
    }
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return text.length;
}

/** libpg-query `location`s are UTF-8 BYTE offsets; SourceRange wants UTF-16 code units. */
function byteMapper(text: string): (byte: number) => number {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7f]/.test(text)) return (byte) => Math.min(byte, text.length);
  const map: number[] = [];
  for (let i = 0; i < text.length; ) {
    const char = String.fromCodePoint(text.codePointAt(i) ?? 0);
    for (let k = 0; k < utf8ByteLength(char); k += 1) map.push(i);
    i += char.length;
  }
  map.push(text.length);
  return (byte) => map[byte] ?? text.length;
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      next.push(Math.min((row[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, (row[j - 1] ?? 0) + cost));
    }
    row = next;
  }
  return row[b.length] ?? 0;
}

/** Up to three near misses, closest first, then alphabetical. */
function nearMisses(written: string, candidates: Iterable<{ key: string; label: string }>): string[] {
  const limit = written.length <= 3 ? 1 : Math.max(2, Math.floor(written.length / 3));
  const scored = new Map<string, number>();
  for (const { key, label } of candidates) {
    if (key === written) continue;
    const distance = editDistance(written, key);
    if (distance <= limit && (scored.get(label) ?? Infinity) > distance) scored.set(label, distance);
  }
  return [...scored]
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 3)
    .map(([label]) => label);
}

function visibleName(object: { readonly name: string; readonly restricted?: boolean }): boolean {
  return object.restricted !== true && object.name !== '';
}

class Walk {
  readonly identifiers: IdentifierResolution[] = [];
  readonly touches: { pos: number; type: 'entity' | 'field'; id: string }[] = [];
  private chunk: SourceChunk = { text: '', start: 0, end: 0 };
  private toIndex: (byte: number) => number = (byte) => byte;
  private readonly fieldCache = new Map<string, readonly Field[]>();

  constructor(
    private readonly query: string,
    private readonly ix: ModelIndex,
  ) {}

  enter(chunk: SourceChunk): void {
    this.chunk = chunk;
    this.toIndex = byteMapper(chunk.text);
  }

  at(location: number | undefined): number {
    return this.chunk.start + this.toIndex(location ?? 0);
  }

  // --- the model ------------------------------------------------------------------------

  private fold(name: string): string {
    return this.ix.normalizeName(name);
  }

  private entityNamed(schema: string | undefined, name: string): Entity | undefined {
    const entity = findEntityByName(this.ix, schema ?? DEFAULT_SCHEMA, name);
    return entity !== undefined && visibleName(entity) ? entity : undefined;
  }

  private fieldsOf(entity: Entity): readonly Field[] {
    let fields = this.fieldCache.get(entity.id);
    if (fields === undefined) {
      fields = fieldsOf(this.ix, entity.id).filter(visibleName);
      this.fieldCache.set(entity.id, fields);
    }
    return fields;
  }

  private fieldNamed(entity: Entity, name: string): Field | undefined {
    const key = this.fold(name);
    return this.fieldsOf(entity).find((f) => this.fold(f.name) === key);
  }

  private entityLabel(entity: Entity): string {
    const ns = this.ix.model.objects.namespace[entity.namespaceId];
    return ns === undefined || ns.isDefault ? entity.name : `${ns.name}.${entity.name}`;
  }

  // --- output ---------------------------------------------------------------------------

  private emit(
    parts: readonly Part[],
    role: IdentifierRole,
    status: ResolutionStatus,
    extra: {
      targetId?: string;
      entityId?: string;
      messageCode?: string;
      messageParams?: Record<string, DiagnosticParam>;
      suggestions?: readonly string[];
    } = {},
  ): string {
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (first === undefined || last === undefined) return '';
    const text = this.query.slice(first.start, last.end);
    this.identifiers.push({
      text,
      range: rangeOf(this.query, first.start, last.end),
      role,
      status,
      targetId: extra.targetId ?? null,
      entityId: extra.entityId ?? null,
      messageCode: extra.messageCode ?? null,
      messageParams: extra.messageParams ?? {},
      suggestions: extra.suggestions ?? [],
    });
    return text;
  }

  private touch(pos: number, type: 'entity' | 'field', id: string): void {
    this.touches.push({ pos, type, id });
  }

  private touchAll(pos: number, entity: Entity): void {
    for (const field of this.fieldsOf(entity)) this.touch(pos, 'field', field.id);
  }

  // --- statements -----------------------------------------------------------------------

  statement(statement: unknown): string {
    const tag = nodeTag(statement) ?? '';
    const body = unwrap(statement, tag) ?? {};
    const kind = DML_KINDS[tag] ?? classify(statement).kind;
    const root = newScope(null);

    switch (tag) {
      case 'SelectStmt':
        this.select(body, null);
        break;
      case 'InsertStmt':
      case 'UpdateStmt':
      case 'DeleteStmt':
        this.dml(tag, body, null);
        break;
      case 'CreateStmt':
        this.creates(asNode(body.relation), root);
        this.visitExcept(body, ['relation'], root);
        break;
      case 'ViewStmt':
        this.creates(asNode(body.view), root);
        this.visit(body.query, root);
        break;
      case 'CreateTableAsStmt':
        this.creates(asNode(unwrap(body.into, 'IntoClause')?.rel), root);
        this.visit(body.query, root);
        break;
      default: {
        // ALTER TABLE, CREATE INDEX, MERGE, …: the statement's own relation is a FROM source,
        // so a column in an ADD CHECK or an index expression resolves against it.
        const relation = asNode(body.relation);
        if (relation !== undefined) this.relation(relation, root, true);
        this.visitExcept(body, ['relation'], root);
      }
    }
    return kind;
  }

  /** The object a CREATE names: not in the IR yet, by design. Opaque source for its CHECKs. */
  private creates(relation: AstNode | undefined, scope: Scope): void {
    if (relation === undefined) return;
    const name = str(relation, 'relname') ?? '';
    this.emit(partsAt(this.query, this.at(int(relation, 'location'))), 'entity', 'unchecked');
    scope.sources.push({ key: this.fold(name), entity: null, aliased: false });
  }

  private ctes(withClause: unknown, scope: Scope): void {
    const ctes = children(unwrap(withClause, 'WithClause') ?? asNode(withClause) ?? {}, 'ctes')
      .map((wrapper) => unwrap(wrapper, 'CommonTableExpr'))
      .filter((cte): cte is AstNode => cte !== undefined);
    // Every name first: a recursive CTE sees itself, a later one sees an earlier one.
    for (const cte of ctes) {
      scope.ctes.add(this.fold(str(cte, 'ctename') ?? ''));
      const part = partAt(this.query, this.at(int(cte, 'location')));
      if (part !== null) this.emit([part], 'alias', 'alias-local');
    }
    for (const cte of ctes) this.visit(cte.ctequery, scope);
  }

  private select(node: AstNode, parent: Scope | null): void {
    const scope = newScope(parent);
    this.ctes(node.withClause, scope);

    const op = str(node, 'op');
    if (op !== undefined && op !== 'SETOP_NONE') {
      this.select(unwrap(node.larg, 'SelectStmt') ?? asNode(node.larg) ?? {}, scope);
      this.select(unwrap(node.rarg, 'SelectStmt') ?? asNode(node.rarg) ?? {}, scope);
      // ORDER BY on a set operation names output columns, which are not known here.
      scope.sources.push({ key: '', entity: null, aliased: true });
      this.visitExcept(node, ['withClause', 'larg', 'rarg'], scope);
      return;
    }

    for (const item of asArray(node.fromClause)) this.fromItem(item, scope);

    const outputAliases = new Set<string>();
    for (const target of children(node, 'targetList')) {
      const name = str(unwrap(target, 'ResTarget') ?? {}, 'name');
      if (name !== undefined) outputAliases.add(this.fold(name));
    }
    const sortScope: Scope = { ...scope, outputAliases };

    for (const [key, value] of Object.entries(node)) {
      if (key === 'withClause' || key === 'fromClause') continue;
      this.visit(value, key === 'sortClause' || key === 'groupClause' ? sortScope : scope);
    }
  }

  private dml(tag: string, node: AstNode, parent: Scope | null): void {
    const base = newScope(parent);
    this.ctes(node.withClause, base);

    if (tag === 'InsertStmt') {
      // INSERT … SELECT does not see the target; RETURNING and ON CONFLICT do.
      const scope = newScope(base);
      const relation = asNode(node.relation);
      const target = relation === undefined ? null : this.relation(relation, scope, true);
      if (target !== null) scope.sources.push({ ...target, key: 'excluded', aliased: true });
      for (const col of children(node, 'cols')) this.targetColumn(unwrap(col, 'ResTarget'), target);
      this.visit(node.selectStmt, base);
      this.visit(node.onConflictClause, scope);
      this.visit(node.returningList, scope);
      return;
    }

    const relation = asNode(node.relation);
    const target = relation === undefined ? null : this.relation(relation, base, true);
    for (const item of asArray(node.fromClause ?? node.usingClause)) this.fromItem(item, base);
    for (const wrapper of children(node, 'targetList')) {
      const set = unwrap(wrapper, 'ResTarget');
      this.targetColumn(set, target);
      this.visit(set?.val, base);
    }
    this.visit(node.whereClause, base);
    this.visit(node.returningList, base);
  }

  /** An INSERT column list entry or an UPDATE SET target: a column of the target table. */
  private targetColumn(target: AstNode | undefined, source: Source | null): void {
    if (target === undefined) return;
    const part = partAt(this.query, this.at(int(target, 'location')));
    if (part === null) return;
    this.column(str(target, 'name') ?? part.value, [part], source);
  }

  // --- FROM -----------------------------------------------------------------------------

  private fromItem(item: unknown, scope: Scope): void {
    const tag = nodeTag(item);
    const node = tag === undefined ? undefined : unwrap(item, tag);
    if (node === undefined) return;

    switch (tag) {
      case 'RangeVar':
        this.relation(node, scope, true);
        return;
      case 'JoinExpr':
        this.fromItem(node.larg, scope);
        this.fromItem(node.rarg, scope);
        this.visit(node.quals, scope);
        return;
      case 'RangeSubselect': {
        this.visit(node.subquery, scope);
        // The subquery's `(` is the last one before its first located token (only keywords such
        // as SELECT sit between); the alias follows the matching `)`. A miss emits no alias.
        const first = minLocation(node.subquery);
        const open = first === undefined ? -1 : this.query.lastIndexOf('(', this.at(first));
        const end = this.query[open] === '(' ? closeParen(this.query, open) : -1;
        this.opaqueAlias(node, end, scope);
        return;
      }
      case 'RangeFunction': {
        this.visit(node.functions, scope);
        const first = minLocation(node.functions);
        let end = -1;
        if (first !== undefined) {
          const name = partsAt(this.query, this.at(first));
          const open = skipSpace(this.query, name[name.length - 1]?.end ?? 0);
          if (this.query[open] === '(') end = closeParen(this.query, open);
        }
        this.opaqueAlias(node, end, scope);
        return;
      }
      default:
        this.visit(item, scope);
    }
  }

  private opaqueAlias(node: AstNode, end: number, scope: Scope): void {
    const alias = str(unwrap(node.alias, 'Alias') ?? asNode(node.alias) ?? {}, 'aliasname');
    if (alias === undefined) return;
    if (end >= 0) this.aliasAfter(end, alias);
    scope.sources.push({ key: this.fold(alias), entity: null, aliased: true });
  }

  /** Emit `[AS] alias` found just after `end`, if the text there really is that alias. */
  private aliasAfter(end: number, alias: string): void {
    let i = skipSpace(this.query, end);
    if (/^as(?![A-Za-z0-9_$])/i.test(this.query.slice(i, i + 3))) i = skipSpace(this.query, i + 2);
    const part = partAt(this.query, i);
    if (part !== null && part.value === alias) this.emit([part], 'alias', 'alias-local');
  }

  /** A RangeVar: a CTE, a visible entity, or unknown. Returns its FROM source. */
  private relation(node: AstNode, scope: Scope, asSource: boolean): Source | null {
    const schema = str(node, 'schemaname');
    const name = str(node, 'relname') ?? '';
    const parts = partsAt(this.query, this.at(int(node, 'location')));
    const alias = str(unwrap(node.alias, 'Alias') ?? asNode(node.alias) ?? {}, 'aliasname');

    let entity: Entity | null = null;
    if (schema === undefined && this.cteInScope(this.fold(name), scope)) {
      this.emit(parts, 'alias', 'alias-local');
    } else {
      entity = this.entityNamed(schema, name) ?? null;
      if (entity !== null) {
        this.emit(parts, 'entity', 'resolved', { targetId: entity.id });
        this.touch(parts[0]?.start ?? 0, 'entity', entity.id);
      } else {
        const text = this.query.slice(parts[0]?.start ?? 0, parts[parts.length - 1]?.end ?? 0);
        const written = this.fold(name);
        this.emit(parts, 'entity', 'unknown', {
          messageCode: CODE.queryUnknownRelation,
          messageParams: { name: text },
          suggestions: nearMisses(
            written,
            Object.values(this.ix.model.objects.entity)
              .filter(visibleName)
              .map((e) => ({ key: this.fold(e.name), label: this.entityLabel(e) })),
          ),
        });
      }
    }

    if (alias !== undefined) this.aliasAfter(parts[parts.length - 1]?.end ?? 0, alias);
    const source: Source = {
      key: this.fold(alias ?? name),
      entity,
      aliased: alias !== undefined,
    };
    if (asSource) scope.sources.push(source);
    return source;
  }

  private cteInScope(name: string, scope: Scope | null): boolean {
    for (let s = scope; s !== null; s = s.parent) if (s.ctes.has(name)) return true;
    return false;
  }

  // --- expressions ----------------------------------------------------------------------

  private visit(value: unknown, scope: Scope): void {
    if (Array.isArray(value)) {
      for (const item of value) this.visit(item, scope);
      return;
    }
    const node = asNode(value);
    if (node === undefined) return;
    const tag = nodeTag(node);
    const body = tag !== undefined && /^[A-Z]/.test(tag) ? unwrap(node, tag) : undefined;
    if (tag === undefined || body === undefined) {
      for (const child of Object.values(node)) this.visit(child, scope);
      return;
    }

    switch (tag) {
      case 'ColumnRef':
        this.columnRef(body, scope);
        return;
      case 'FuncCall':
        if (str(body, 'funcformat') !== 'COERCE_SQL_SYNTAX') {
          this.emit(partsAt(this.query, this.at(int(body, 'location'))), 'function', 'unchecked');
        }
        this.visitExcept(body, ['funcname'], scope);
        return;
      case 'SelectStmt':
        this.select(body, scope);
        return;
      case 'InsertStmt':
      case 'UpdateStmt':
      case 'DeleteStmt':
        this.dml(tag, body, scope);
        return;
      case 'RangeVar':
        this.relation(body, scope, false);
        return;
      default:
        for (const child of Object.values(body)) this.visit(child, scope);
    }
  }

  private visitExcept(node: AstNode, skip: readonly string[], scope: Scope): void {
    for (const [key, value] of Object.entries(node)) if (!skip.includes(key)) this.visit(value, scope);
  }

  private columnRef(node: AstNode, scope: Scope): void {
    const names = children(node, 'fields').map((f) =>
      unwrap(f, 'A_Star') !== undefined ? '*' : (str(unwrap(f, 'String') ?? {}, 'sval') ?? ''),
    );
    const start = this.at(int(node, 'location'));
    const written = partsAt(this.query, start);
    // A shape the scanner cannot line up (U&"…" identifiers) degrades to one whole-ref range.
    const parts: Part[] =
      written.length === names.length
        ? written
        : names.map((value) => ({ start, end: written[written.length - 1]?.end ?? start, value }));

    const column = names[names.length - 1] ?? '';
    const qualifier = names.slice(0, -1);
    const source =
      qualifier.length === 0 ? undefined : this.qualifier(qualifier, parts.slice(0, -1), scope);
    const columnPart = parts.slice(-1);

    if (column === '*') {
      const pos = columnPart[0]?.start ?? start;
      if (source === undefined) {
        for (const s of scope.sources) if (s.entity !== null) this.touchAll(pos, s.entity);
      } else if (source !== null && source.entity !== null) this.touchAll(pos, source.entity);
      return;
    }
    if (source === undefined) this.unqualified(column, columnPart, scope);
    else this.column(column, columnPart, source);
  }

  /** The `t` / `s.t` in `t.col`. null = not in the FROM clause. */
  private qualifier(names: readonly string[], parts: readonly Part[], scope: Scope): Source | null {
    const table = this.fold(names[names.length - 1] ?? '');
    const schema = names.length > 1 ? this.fold(names[names.length - 2] ?? '') : undefined;

    for (let s: Scope | null = scope; s !== null; s = s.parent) {
      const found = s.sources.find((source) => {
        if (source.key !== table) return false;
        if (schema === undefined) return true;
        if (source.aliased || source.entity === null) return false;
        const ns = this.ix.model.objects.namespace[source.entity.namespaceId];
        return ns !== undefined && this.fold(ns.name) === schema;
      });
      if (found === undefined) continue;
      if (found.entity !== null && !found.aliased) {
        this.emit(parts, 'entity', 'resolved', { targetId: found.entity.id });
        this.touch(parts[0]?.start ?? 0, 'entity', found.entity.id);
      } else this.emit(parts, 'alias', 'alias-local');
      return found;
    }

    const keys: { key: string; label: string }[] = [];
    for (let s: Scope | null = scope; s !== null; s = s.parent) {
      for (const source of s.sources) if (source.key !== '') keys.push({ key: source.key, label: source.key });
    }
    const text = this.query.slice(parts[0]?.start ?? 0, parts[parts.length - 1]?.end ?? 0);
    this.emit(parts, 'alias', 'unknown', {
      messageCode: CODE.queryUnknownQualifier,
      messageParams: { name: text },
      suggestions: nearMisses(table, keys),
    });
    return null;
  }

  /** A column of a known source (or of none, when the qualifier did not resolve). */
  private column(name: string, parts: readonly Part[], source: Source | null): void {
    if (source?.entity == null) {
      this.emit(parts, 'field', 'unchecked');
      return;
    }
    const entity = source.entity;
    const field = this.fieldNamed(entity, name);
    if (field !== undefined) {
      this.emit(parts, 'field', 'resolved', { targetId: field.id, entityId: entity.id });
      this.touch(parts[0]?.start ?? 0, 'field', field.id);
      return;
    }
    const text = this.query.slice(parts[0]?.start ?? 0, parts[parts.length - 1]?.end ?? 0);
    this.emit(parts, 'field', 'unknown', {
      messageCode: CODE.queryUnknownColumnOn,
      messageParams: { name: text, table: entity.name },
      suggestions: nearMisses(
        this.fold(name),
        this.fieldsOf(entity).map((f) => ({ key: this.fold(f.name), label: f.name })),
      ),
    });
  }

  private unqualified(name: string, parts: readonly Part[], scope: Scope): void {
    const key = this.fold(name);
    if (scope.outputAliases.has(key)) {
      this.emit(parts, 'alias', 'alias-local');
      return;
    }

    const candidates: { key: string; label: string }[] = [];
    for (let s: Scope | null = scope; s !== null; s = s.parent) {
      const matches: { entity: Entity; field: Field }[] = [];
      for (const source of s.sources) {
        if (source.entity === null) continue;
        const field = this.fieldNamed(source.entity, name);
        if (field !== undefined) matches.push({ entity: source.entity, field });
        for (const f of this.fieldsOf(source.entity)) candidates.push({ key: this.fold(f.name), label: f.name });
      }
      const text = this.query.slice(parts[0]?.start ?? 0, parts[parts.length - 1]?.end ?? 0);
      const [only] = matches;
      if (matches.length > 1) {
        this.emit(parts, 'field', 'ambiguous', {
          messageCode: CODE.queryAmbiguousColumn,
          messageParams: {
            name: text,
            count: matches.length,
            tables: matches.map((m) => m.entity.name).join(', '),
          },
        });
        return;
      }
      if (only !== undefined) {
        this.emit(parts, 'field', 'resolved', { targetId: only.field.id, entityId: only.entity.id });
        this.touch(parts[0]?.start ?? 0, 'field', only.field.id);
        return;
      }
      // An opaque source in this scope may well own it; nothing further out can be claimed.
      if (s.sources.some((source) => source.entity === null)) {
        this.emit(parts, 'field', 'unchecked');
        return;
      }
    }

    const text = this.query.slice(parts[0]?.start ?? 0, parts[parts.length - 1]?.end ?? 0);
    this.emit(parts, 'field', 'unknown', {
      messageCode: CODE.queryUnknownColumn,
      messageParams: { name: text },
      suggestions: nearMisses(key, candidates),
    });
  }
}

/** Where a parser error points: the token at the cursor, or the last character at EOF. */
function errorRange(query: string, chunk: SourceChunk, error: unknown): QueryParseError {
  const details = asNode(asNode(error)?.sqlDetails);
  const cursor = details === undefined ? undefined : int(details, 'cursorPosition');
  let start = chunk.start + byteMapper(chunk.text)(cursor ?? 0);
  if (start >= chunk.end) start = Math.max(chunk.start, chunk.end - 1);
  const token = /^[^\s;]+/.exec(query.slice(start, chunk.end))?.[0].length ?? 1;
  const end = Math.min(chunk.end, start + Math.max(1, token));
  const message = error instanceof Error ? error.message : 'the query could not be parsed';
  return { message, range: rangeOf(query, start, end) };
}

export const QUERY_VALIDATOR: QueryValidator = {
  async validate(input: QueryValidationInput): Promise<QueryValidationResult> {
    // `input.restrictedProbe` is deliberately never read (§12.1).
    const query = input.query;
    const ix = createIndex(input.model, { normalizeName });
    const walk = new Walk(query, ix);
    const parseErrors: QueryParseError[] = [];
    const statementKinds: string[] = [];

    let parser: Awaited<ReturnType<typeof loadSqlParser>> | undefined;
    try {
      parser = await loadSqlParser();
    } catch (error) {
      parseErrors.push({
        message: error instanceof Error ? error.message : 'the SQL parser could not be loaded',
        range: rangeOf(query, 0, query.length),
      });
    }

    for (const chunk of parser === undefined ? [] : splitStatements(query)) {
      walk.enter(chunk);
      try {
        for (const statement of statementsOf(await parser?.parse(chunk.text))) {
          statementKinds.push(walk.statement(statement));
        }
      } catch (error) {
        parseErrors.push(errorRange(query, chunk, error));
      }
    }

    const identifiers = [...walk.identifiers].sort((a, b) => a.range.start - b.range.start);
    const touches = [...walk.touches].sort((a, b) => a.pos - b.pos);
    const entities = new Set<string>();
    const fields = new Set<string>();
    for (const t of touches) (t.type === 'entity' ? entities : fields).add(t.id);

    return {
      parsed: parseErrors.length === 0,
      parseErrors,
      identifiers,
      touchedEntityIds: [...entities],
      touchedFieldIds: [...fields],
      hiddenReferences: [],
      statementKinds,
    };
  },
};
