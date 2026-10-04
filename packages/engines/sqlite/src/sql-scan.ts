/**
 * Phase 13 §4.1 — splitting SQLite source into statements, classifying each one against the
 * allowlist, and reading the few facts PRAGMAs don't return out of a stored `CREATE TABLE`
 * (CHECK bodies, generated expressions, AUTOINCREMENT, COLLATE). Quotes ('', "", ``, []),
 * comments and a trigger's `BEGIN … END` are honoured throughout.
 */

export interface Chunk {
  readonly text: string;
  /** offsets into the source: `text` is `source.slice(start, end)` */
  readonly start: number;
  readonly end: number;
}

/** Skips a quoted run or a comment starting at `i`; returns the index after it, or `i`. */
function skip(source: string, i: number): number {
  const c = source[i];
  if (c === "'" || c === '"' || c === '`') {
    let j = i + 1;
    while (j < source.length) {
      if (source[j] === c) {
        if (source[j + 1] === c) j += 2;
        else return j + 1;
      } else j += 1;
    }
    return source.length;
  }
  if (c === '[') {
    const end = source.indexOf(']', i + 1);
    return end === -1 ? source.length : end + 1;
  }
  if (source.startsWith('--', i)) {
    const end = source.indexOf('\n', i);
    return end === -1 ? source.length : end + 1;
  }
  if (source.startsWith('/*', i)) {
    const end = source.indexOf('*/', i + 2);
    return end === -1 ? source.length : end + 2;
  }
  return i;
}

/** Statements in order; empty and comment-only chunks are dropped. */
export function splitStatements(source: string): Chunk[] {
  const chunks: Chunk[] = [];
  let start = 0;
  let i = 0;
  let depth = 0; // trigger BEGIN … END nesting
  let words: string[] = [];
  const push = (end: number) => {
    const text = source.slice(start, end);
    if (stripComments(text).trim() !== '') {
      const lead = text.length - text.trimStart().length;
      chunks.push({
        text: text.trim(),
        start: start + lead,
        end: start + lead + text.trim().length,
      });
    }
    start = end;
    words = [];
  };
  while (i < source.length) {
    const next = skip(source, i);
    if (next !== i) {
      i = next;
      continue;
    }
    const word = /^[A-Za-z_]+/.exec(source.slice(i, i + 32))?.[0];
    if (word !== undefined) {
      const upper = word.toUpperCase();
      words.push(upper);
      const isTrigger = words[0] === 'CREATE' && words.slice(0, 4).includes('TRIGGER');
      if (isTrigger && upper === 'BEGIN') depth += 1;
      if (isTrigger && upper === 'END' && depth > 0) depth -= 1;
      i += word.length;
      continue;
    }
    if (source[i] === ';' && depth === 0) {
      push(i + 1);
      i += 1;
      continue;
    }
    i += 1;
  }
  push(source.length);
  return chunks;
}

export function stripComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const next = skip(text, i);
    if (next !== i) {
      const piece = text.slice(i, next);
      out += piece.startsWith('--') || piece.startsWith('/*') ? ' ' : piece;
      i = next;
    } else {
      out += text[i] ?? '';
      i += 1;
    }
  }
  return out;
}

export type StatementClass =
  /** executed in the in-memory database */
  | { readonly action: 'run'; readonly kind: string; readonly partial?: string }
  | {
      readonly action: 'ignored' | 'unsupported' | 'failed';
      readonly kind: string;
      readonly reason: string;
    };

/**
 * THE SECURITY BOUNDARY (§4.1): only these statement kinds are ever executed. Everything else
 * is reported and never reaches SQLite — `ATTACH` creates files, `VACUUM INTO` writes one, and
 * `CREATE TABLE … AS SELECT` runs a query.
 */
export function classify(text: string): StatementClass {
  const words = stripComments(text)
    .trim()
    .split(/[\s(;]+/)
    .slice(0, 6)
    .map((w) => w.toUpperCase());
  const [first = '', second = '', third = ''] = words;
  const kind = words.slice(0, 2).join(' ') || 'unparsed';
  if (first === 'CREATE') {
    const temp = second === 'TEMP' || second === 'TEMPORARY';
    const what = temp ? third : second;
    if (temp)
      return {
        action: 'unsupported',
        kind,
        reason: 'Temporary objects are not part of the schema',
      };
    if (what === 'TABLE') {
      if (isCreateTableAs(text)) {
        return {
          action: 'unsupported',
          kind: 'CREATE TABLE',
          reason: 'CREATE TABLE … AS SELECT copies data; define the table with its columns',
        };
      }
      return { action: 'run', kind: 'CREATE TABLE' };
    }
    if (what === 'INDEX' || (what === 'UNIQUE' && third === 'INDEX')) {
      return { action: 'run', kind: 'CREATE INDEX' };
    }
    if (what === 'VIEW') return { action: 'run', kind: 'CREATE VIEW' };
    if (what === 'TRIGGER') {
      return {
        action: 'unsupported',
        kind: 'CREATE TRIGGER',
        reason: 'Triggers are not part of the schema model',
      };
    }
    if (what === 'VIRTUAL') {
      return {
        action: 'unsupported',
        kind: 'CREATE VIRTUAL TABLE',
        reason: 'Virtual tables (FTS5, R*Tree…) are not part of the schema model',
      };
    }
  }
  if (first === 'ALTER' && second === 'TABLE') return { action: 'run', kind: 'ALTER TABLE' };
  if (first === 'DROP' && ['TABLE', 'INDEX', 'VIEW'].includes(second)) {
    return { action: 'run', kind: `DROP ${second}` };
  }
  if (first === 'DROP' && second === 'TRIGGER') {
    return {
      action: 'ignored',
      kind: 'DROP TRIGGER',
      reason: 'Triggers are not part of the schema model',
    };
  }
  const ignored: Readonly<Record<string, string>> = {
    PRAGMA: 'Connection settings, not schema',
    BEGIN: 'Transaction control',
    COMMIT: 'Transaction control',
    END: 'Transaction control',
    ROLLBACK: 'Transaction control',
    SAVEPOINT: 'Transaction control',
    RELEASE: 'Transaction control',
    INSERT: 'Data, not schema',
    REPLACE: 'Data, not schema',
    UPDATE: 'Data, not schema',
    DELETE: 'Data, not schema',
    SELECT: 'A query, not schema',
    ANALYZE: 'Statistics, not schema',
    REINDEX: 'Maintenance, not schema',
  };
  const reason = ignored[first];
  if (reason !== undefined) return { action: 'ignored', kind: first, reason };
  return { action: 'failed', kind, reason: 'Not part of a schema, so it is not run' };
}

// --- identifiers ----------------------------------------------------------------------------

const IDENT = /^\s*("(?:[^"]|"")+"|\[[^\]]+\]|`(?:[^`]|``)+`|[\w$]+)/;

/** An identifier at the start of `text`, unquoted, and the rest after it. */
export function readIdentifier(text: string): { name: string; rest: string } | null {
  const m = IDENT.exec(text);
  if (m?.[1] === undefined) return null;
  return { name: unquote(m[1]), rest: text.slice(m[0].length) };
}

export function unquote(token: string): string {
  const first = token[0];
  if (first === '"') return token.slice(1, -1).replace(/""/g, '"');
  if (first === '`') return token.slice(1, -1).replace(/``/g, '`');
  if (first === '[') return token.slice(1, -1);
  return token;
}

/** `[schema.]name`, skipping the schema. */
function readQualified(text: string): { name: string; rest: string } | null {
  const first = readIdentifier(text);
  if (first === null) return null;
  if (first.rest.trimStart().startsWith('.'))
    return readIdentifier(first.rest.trimStart().slice(1));
  return first;
}

/** `CREATE TABLE t AS SELECT …`: `AS` where the column list would be. */
function isCreateTableAs(text: string): boolean {
  const body = stripComments(text).trim();
  const head = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i.exec(body);
  const table = head === null ? null : readQualified(body.slice(head[0].length));
  return table !== null && /^\s*AS\b/i.test(table.rest);
}

/** The object a statement names, for the import report: table, index, view. */
export function targetOf(text: string): { readonly name: string; readonly column?: string } | null {
  const body = stripComments(text).trim();
  const create = /^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?/i.exec(
    body,
  );
  if (create !== null) return readQualified(body.slice(create[0].length));
  const alter = /^ALTER\s+TABLE\s+/i.exec(body);
  if (alter !== null) {
    const table = readQualified(body.slice(alter[0].length));
    if (table === null) return null;
    const add = /^\s*ADD\s+(?:COLUMN\s+)?/i.exec(table.rest);
    const column = add === null ? null : readIdentifier(table.rest.slice(add[0].length));
    return column === null ? { name: table.name } : { name: table.name, column: column.name };
  }
  return null;
}

// --- a stored CREATE TABLE ------------------------------------------------------------------

/** The text between `(` at `open` and its matching `)`. */
export function balanced(text: string, open: number): { body: string; end: number } | null {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const next = skip(text, i);
    if (next !== i) {
      i = next;
      continue;
    }
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(open + 1, i), end: i + 1 };
    }
    i += 1;
  }
  return null;
}

/** Splits on commas at depth 0. */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const next = skip(text, i);
    if (next !== i) {
      i = next;
      continue;
    }
    const c = text[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
    i += 1;
  }
  parts.push(text.slice(start).trim());
  return parts.filter((p) => p !== '');
}

export interface ColumnFacts {
  readonly autoIncrement: boolean;
  readonly collation: string | undefined;
  readonly generated:
    { readonly expression: string; readonly kind: 'VIRTUAL' | 'STORED' } | undefined;
  readonly checks: readonly { readonly name: string | undefined; readonly expression: string }[];
}

export interface TableFacts {
  readonly columns: ReadonlyMap<string, ColumnFacts>;
  readonly checks: readonly { readonly name: string | undefined; readonly expression: string }[];
  /** `CONSTRAINT name` of the table's PRIMARY KEY, when it has one */
  readonly primaryKeyName: string | undefined;
}

const TABLE_CONSTRAINT =
  /^(?:CONSTRAINT\s+("(?:[^"]|"")+"|\[[^\]]+\]|`(?:[^`]|``)+`|[\w$]+)\s+)?(PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i;

/** Every `CHECK (…)` in a piece of a definition, with the `CONSTRAINT name` before it. */
function checksIn(text: string): { name: string | undefined; expression: string }[] {
  const out: { name: string | undefined; expression: string }[] = [];
  const plain = text;
  let from = 0;
  for (;;) {
    const at = plain.slice(from).search(/\bCHECK\s*\(/i);
    if (at === -1) break;
    const start = from + at;
    const open = plain.indexOf('(', start);
    const inner = balanced(plain, open);
    if (inner === null) break;
    const before = /CONSTRAINT\s+("(?:[^"]|"")+"|\[[^\]]+\]|`(?:[^`]|``)+`|[\w$]+)\s*$/i.exec(
      plain.slice(0, start),
    );
    out.push({
      name: before?.[1] === undefined ? undefined : unquote(before[1]),
      expression: inner.body.trim(),
    });
    from = inner.end;
  }
  return out;
}

export function tableFacts(createTable: string): TableFacts {
  const text = stripComments(createTable);
  const open = text.indexOf('(');
  const body = open === -1 ? null : balanced(text, open);
  const columns = new Map<string, ColumnFacts>();
  const checks: { name: string | undefined; expression: string }[] = [];
  let primaryKeyName: string | undefined;
  for (const part of body === null ? [] : splitTopLevel(body.body)) {
    const constraint = TABLE_CONSTRAINT.exec(part);
    if (constraint !== null) {
      if (constraint[2]?.toUpperCase() === 'CHECK') checks.push(...checksIn(part));
      if (constraint[2]?.toUpperCase() === 'PRIMARY' && constraint[1] !== undefined) {
        primaryKeyName = unquote(constraint[1]);
      }
      continue;
    }
    const column = readIdentifier(part);
    if (column === null) continue;
    const rest = column.rest;
    const generatedAt = rest.search(/\b(?:GENERATED\s+ALWAYS\s+)?AS\s*\(/i);
    let generated: ColumnFacts['generated'];
    if (generatedAt !== -1) {
      const inner = balanced(rest, rest.indexOf('(', generatedAt));
      if (inner !== null) {
        generated = {
          expression: inner.body.trim(),
          kind: /^\s*STORED\b/i.test(rest.slice(inner.end)) ? 'STORED' : 'VIRTUAL',
        };
      }
    }
    const collation = /\bCOLLATE\s+("(?:[^"]|"")+"|[\w$]+)/i.exec(rest)?.[1];
    columns.set(column.name.toLowerCase(), {
      autoIncrement: /\bAUTOINCREMENT\b/i.test(rest),
      collation: collation === undefined ? undefined : unquote(collation),
      generated,
      checks: checksIn(rest),
    });
  }
  return { columns, checks, primaryKeyName };
}

/** The SELECT of a `CREATE VIEW … AS select`. */
export function viewBody(createView: string): string | undefined {
  const m =
    /^\s*CREATE\s+(?:TEMP\w*\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"(?:[^"]|"")+"|\[[^\]]+\]|`(?:[^`]|``)+`|[\w$.]+)(?:\s*\([^)]*\))?\s+AS\s+/i.exec(
      createView,
    );
  if (m === null) return undefined;
  return createView.slice(m[0].length).trim().replace(/;\s*$/, '');
}

/** The predicate of a partial index, and its columns' text in order (expressions included). */
export function indexFacts(createIndex: string): { where: string | undefined; columns: string[] } {
  const text = stripComments(createIndex);
  const on = /\bON\s+(?:"(?:[^"]|"")+"|\[[^\]]+\]|`(?:[^`]|``)+`|[\w$.]+)\s*/i.exec(text);
  if (on === null) return { where: undefined, columns: [] };
  const open = text.indexOf('(', on.index + on[0].length - 1);
  const list = open === -1 ? null : balanced(text, open);
  if (list === null) return { where: undefined, columns: [] };
  const where = /^\s*WHERE\s+([\s\S]+?)\s*;?\s*$/i.exec(text.slice(list.end))?.[1];
  return {
    where,
    columns: splitTopLevel(list.body).map((c) =>
      c
        .replace(/\s+(ASC|DESC)\s*$/i, '')
        .replace(/\s+COLLATE\s+\S+$/i, '')
        .trim(),
    ),
  };
}
