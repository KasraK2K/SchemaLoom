import type { SourceRange } from '@schemaloom/engine-sdk';

/**
 * Reading PostgreSQL text without parsing it.
 *
 * Two jobs, one lexer, because both need the same answer to the same question — "is this
 * character code, or is it inside a string, a dollar-quoted body, a quoted identifier or a
 * comment?":
 *
 *  1. SPLITTING the source into statements. The importer parses each statement on its own
 *     rather than handing the whole file to `libpg-query`, so that ONE syntax error is one
 *     `failed` statement in the report instead of a whole refused file (§9 invariant 4).
 *  2. RECOVERING EXPRESSION TEXT. `libpg-query` parses; it does not deparse. A `DEFAULT`,
 *     a `CHECK` body and a partial-index predicate are stored as engine-syntax STRINGS
 *     (doc 04 §2.6), so the text has to come back out of the source by offset.
 *
 * Nothing here is a SQL parser and nothing here should become one: the real parser is one
 * dynamic `import()` away in `parser.ts`. This is a lexer over five bracket-ish constructs.
 */

/** A `$tag$` opener at `i`, or null. Tags are `$$` or `$word$` — a digit may not lead. */
function dollarTagAt(source: string, i: number): string | null {
  if (source[i] !== '$') return null;
  let j = i + 1;
  while (j < source.length) {
    const char = source[j];
    if (char === '$') return source.slice(i, j + 1);
    if (char === undefined || !/[A-Za-z_\u0080-￿0-9]/.test(char)) return null;
    if (j === i + 1 && /[0-9]/.test(char)) return null;
    j += 1;
  }
  return null;
}

/**
 * If a non-code element starts at `i`, return the index just past it; otherwise null.
 * Total and non-throwing: an unterminated literal runs to end of source, which is the
 * behaviour that makes the splitter degrade into "one statement" rather than throw.
 */
export function skipNonCode(source: string, i: number): number | null {
  const char = source[i];

  if (char === "'" || char === '"') {
    let j = i + 1;
    while (j < source.length) {
      if (source[j] === char) {
        // '' and "" are escapes for the delimiter, not a close followed by an open.
        if (source[j + 1] === char) j += 2;
        else return j + 1;
      } else if (char === "'" && source[j] === '\\') j += 2;
      else j += 1;
    }
    return source.length;
  }

  if (char === '-' && source[i + 1] === '-') {
    const end = source.indexOf('\n', i);
    return end === -1 ? source.length : end;
  }

  if (char === '/' && source[i + 1] === '*') {
    // PostgreSQL block comments nest.
    let depth = 1;
    let j = i + 2;
    while (j < source.length && depth > 0) {
      if (source[j] === '/' && source[j + 1] === '*') {
        depth += 1;
        j += 2;
      } else if (source[j] === '*' && source[j + 1] === '/') {
        depth -= 1;
        j += 2;
      } else j += 1;
    }
    return j;
  }

  const tag = dollarTagAt(source, i);
  if (tag !== null) {
    const end = source.indexOf(tag, i + tag.length);
    return end === -1 ? source.length : end + tag.length;
  }

  return null;
}

export interface SourceChunk {
  /** the statement's text, WITHOUT its terminating separator */
  readonly text: string;
  /** absolute offset of `text` in the original source */
  readonly start: number;
  /** exclusive */
  readonly end: number;
}

/**
 * Split on `;` at bracket depth 0, outside every quoting construct. Leading whitespace and
 * comments are trimmed off the front of each chunk so that a statement's reported `range`
 * points at the statement and not at the blank line above it.
 *
 * A chunk that is only whitespace or only comments is dropped: it is not a statement, and
 * reporting it would put "0 statements could not be applied" next to a list of comments.
 */
export function splitStatements(source: string): readonly SourceChunk[] {
  const chunks: SourceChunk[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;

  const push = (from: number, to: number): void => {
    const trimmed = trimToCode(source, from, to);
    if (trimmed !== null) {
      chunks.push({ text: source.slice(trimmed.start, trimmed.end), ...trimmed });
    }
  };

  while (i < source.length) {
    const skip = skipNonCode(source, i);
    if (skip !== null) {
      i = skip;
      continue;
    }
    const char = source[i];
    if (char === '(') depth += 1;
    else if (char === ')' && depth > 0) depth -= 1;
    else if (char === ';' && depth === 0) {
      push(start, i);
      start = i + 1;
    }
    i += 1;
  }
  push(start, source.length);

  return chunks;
}

/** Narrow `[from, to)` to the first code character and the last non-whitespace one, or null
 *  when the span holds nothing but whitespace and comments. */
function trimToCode(source: string, from: number, to: number): { start: number; end: number } | null {
  let start = from;
  while (start < to) {
    const char = source[start];
    if (char !== undefined && /\s/.test(char)) {
      start += 1;
      continue;
    }
    // Only comments are skipped here; a string or a dollar-quote is real statement text.
    const isComment =
      (char === '-' && source[start + 1] === '-') || (char === '/' && source[start + 1] === '*');
    if (!isComment) break;
    const skip = skipNonCode(source, start);
    if (skip === null || skip <= start) break;
    start = Math.min(skip, to);
  }
  let end = to;
  while (end > start) {
    const char = source[end - 1];
    if (char === undefined || !/\s/.test(char)) break;
    end -= 1;
  }
  return end > start ? { start, end } : null;
}

/**
 * The text of one expression starting at `from`.
 *
 * It ends at whichever comes first: `limit` (the caller's own boundary — the next sibling
 * element in a `CREATE TABLE` element list, which is how `DEFAULT now() NOT NULL` stops at
 * `now()` and does not swallow `NOT NULL`), or the first `,` / `)` / `;` at depth 0.
 */
export function expressionText(source: string, from: number, limit?: number): string {
  const ceiling = Math.min(limit ?? source.length, source.length);
  let depth = 0;
  let i = from;

  while (i < ceiling) {
    const skip = skipNonCode(source, i);
    if (skip !== null) {
      i = Math.min(skip, ceiling);
      continue;
    }
    const char = source[i];
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') {
      if (depth === 0) break;
      depth -= 1;
    } else if ((char === ',' || char === ';') && depth === 0) break;
    i += 1;
  }

  return source.slice(from, i).trim();
}

/**
 * Everything after the first `AS` keyword at depth 0 — a view body, which `libpg-query` gives
 * us as a parse tree it cannot turn back into SQL.
 *
 * ponytail: a keyword scan, not a grammar. It handles `CREATE [OR REPLACE] [MATERIALIZED]
 * VIEW name [(cols)] [WITH (...)] AS <body> [WITH [NO] DATA]`, which is every view shape the
 * type catalog and props schemas can represent. A body whose own text contains a top-level
 * `AS` before the view's would need the real deparser — upgrade path is `pg-query-deparser`
 * behind the same dynamic seam as the parser.
 */
export function viewBodyAfterAs(statement: string): string | null {
  let depth = 0;
  let i = 0;

  while (i < statement.length) {
    const skip = skipNonCode(statement, i);
    if (skip !== null) {
      i = skip;
      continue;
    }
    const char = statement[i];
    if (char === '(') depth += 1;
    else if (char === ')' && depth > 0) depth -= 1;
    else if (depth === 0 && (char === 'a' || char === 'A') && isWordAt(statement, i, 'as')) {
      const body = statement
        .slice(i + 2)
        .trim()
        .replace(/;\s*$/, '')
        .replace(/\s+with\s+(no\s+)?data\s*$/i, '');
      return body.length > 0 ? body : null;
    }
    i += 1;
  }
  return null;
}

/** `word` occurs at `i` as a whole word, case-insensitively. */
function isWordAt(source: string, i: number, word: string): boolean {
  if (source.slice(i, i + word.length).toLowerCase() !== word) return false;
  const before = i === 0 ? ' ' : (source[i - 1] ?? ' ');
  const after = source[i + word.length] ?? ' ';
  return !/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after);
}

/** Offsets are UTF-16 code units, 1-based line and column — exactly what CodeMirror wants
 *  for a decoration range (doc 03 §2.2). */
export function rangeOf(source: string, start: number, end: number): SourceRange {
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

/** §9's `excerpt`: the first 200 characters, whitespace collapsed. */
export function excerptOf(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= 200 ? collapsed : `${collapsed.slice(0, 199)}…`;
}
