import type { SourceRange } from '@schemaloom/engine-sdk';

/**
 * Splitting a MySQL source into statements, and the text clean-up node-sql-parser needs first
 * (design §4; the 9a parser spike found each of these).
 */

export interface SourceChunk {
  /** the statement, without its terminator */
  readonly text: string;
  /** absolute offsets in the original source; `end` is exclusive */
  readonly start: number;
  readonly end: number;
}

/**
 * Splits on `;`, or on whatever a `DELIMITER` line set (mysqldump writes routines between
 * `DELIMITER ;;` and `DELIMITER ;`). Quotes (`'`, `"`, backtick) and comments (`--`, `#`,
 * `/* *\/`) are skipped; a version comment `/*!50001 … *\/` is NOT a comment to MySQL, but
 * nothing inside one ends a statement either, so treating it as opaque here is right.
 * Chunks that hold only whitespace and comments are dropped.
 */
export function splitStatements(source: string): readonly SourceChunk[] {
  const chunks: SourceChunk[] = [];
  let delimiter = ';';
  let start = 0;
  let i = 0;

  const push = (end: number) => {
    const text = source.slice(start, end);
    if (stripComments(text).trim() !== '') {
      const lead = text.length - text.trimStart().length;
      const trail = text.length - text.trimEnd().length;
      chunks.push({ text: text.trim(), start: start + lead, end: end - trail });
    }
  };

  while (i < source.length) {
    // `DELIMITER x` is a client command, on a line of its own.
    if (
      (i === 0 || source[i - 1] === '\n') &&
      /^[ \t]*delimiter[ \t]+/i.test(source.slice(i, i + 32))
    ) {
      const eol = source.indexOf('\n', i);
      const line = source.slice(i, eol === -1 ? source.length : eol);
      push(i);
      delimiter = line.trim().split(/\s+/)[1] ?? ';';
      i = eol === -1 ? source.length : eol + 1;
      start = i;
      continue;
    }
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuoted(source, i, ch);
      continue;
    }
    if ((ch === '-' && next === '-' && /\s/.test(source[i + 2] ?? ' ')) || ch === '#') {
      const eol = source.indexOf('\n', i);
      i = eol === -1 ? source.length : eol + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? source.length : close + 2;
      continue;
    }
    if (source.startsWith(delimiter, i)) {
      push(i);
      i += delimiter.length;
      start = i;
      continue;
    }
    i += 1;
  }
  push(source.length);
  return chunks;
}

function skipQuoted(source: string, open: number, quote: string): number {
  let i = open + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\' && quote !== '`') {
      i += 2;
      continue;
    }
    if (ch === quote) {
      if (source[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return source.length;
}

/** Plain comments removed, version comments kept. For classifying, never for parsing. */
export function stripComments(text: string): string {
  return text.replace(/\/\*(?![M!])[\s\S]*?\*\//g, ' ').replace(/(^|\n)\s*(--\s|#)[^\n]*/g, '$1');
}

/**
 * MySQL executes `/*!NNNNN body *\/` (and MariaDB `/*M!NNNNN body *\/`) as SQL; a parser
 * treats it as a comment, which would make every view in a mysqldump file disappear.
 */
export function unwrapVersionComments(text: string): string {
  return text.replace(/\/\*M?!\d{0,6}\s?([\s\S]*?)\*\//g, ' $1 ');
}

/** The first `count` keywords, upper-cased, comments stripped: `CREATE DEFINER=… TRIGGER`. */
export function leadingWords(text: string, count = 6): readonly string[] {
  return unwrapVersionComments(stripComments(text))
    .replace(/DEFINER\s*=\s*(`[^`]*`|'[^']*'|\S+?)(@(`[^`]*`|'[^']*'|\S+))?(?=\s)/gi, ' ')
    .trim()
    .split(/[\s(]+/)
    .slice(0, count)
    .map((w) => w.toUpperCase());
}

export interface Normalised {
  /** what to hand the parser */
  readonly text: string;
  /** what was dropped on the way, for the report's `partial` reason */
  readonly losses: readonly string[];
  /** column → attributes the parser cannot read, recovered from the column's own line */
  readonly columnAttributes: ReadonlyMap<
    string,
    { readonly srid?: number; readonly invisible?: true }
  >;
  /** CHECK constraint names declared `NOT ENFORCED` */
  readonly notEnforced: ReadonlySet<string>;
}

/**
 * Text fixes before parsing, each one a gap the 9a spike found in node-sql-parser:
 * `PARTITION BY` (dropped, reported partial), `SRID n` and `INVISIBLE` on a column (recovered
 * per line, then removed), `NOT ENFORCED` on a CHECK (recovered, then removed), and
 * `DOUBLE PRECISION` (spelled `DOUBLE`).
 */
export function normaliseForParser(raw: string): Normalised {
  let text = unwrapVersionComments(raw);
  const losses: string[] = [];
  const columnAttributes = new Map<string, { srid?: number; invisible?: true }>();
  const notEnforced = new Set<string>();

  const partition = topLevelIndexOf(text, /\bPARTITION\s+BY\b/i);
  if (partition !== -1) {
    text = text.slice(0, partition);
    losses.push('Partitioning is not kept');
  }

  for (const line of text.split('\n')) {
    const column = /^\s*`((?:[^`]|``)+)`/.exec(line)?.[1]?.replace(/``/g, '`');
    if (column === undefined) continue;
    const srid = /\bSRID\s+(\d+)/i.exec(line)?.[1];
    const invisible = /\bINVISIBLE\b/i.test(line) && !/\bKEY\b|\bINDEX\b/i.test(line);
    if (srid !== undefined || invisible) {
      columnAttributes.set(column, {
        ...(srid === undefined ? {} : { srid: Number(srid) }),
        ...(invisible ? { invisible: true as const } : {}),
      });
    }
  }
  if (/\bSRID\s+\d+/i.test(text) && columnAttributes.size === 0) losses.push('SRID is not kept');
  text = text.replace(/\bSRID\s+\d+/gi, ' ');

  for (const match of text.matchAll(/CONSTRAINT\s+(`(?:[^`]|``)+`|\w+)\s+CHECK\s*\(/gi)) {
    const close = closingParen(text, match.index + match[0].length - 1);
    if (close !== -1 && /^\s*NOT\s+ENFORCED/i.test(text.slice(close + 1))) {
      notEnforced.add((match[1] ?? '').replace(/^`|`$/g, '').replace(/``/g, '`'));
    }
  }
  text = text.replace(/\)\s*NOT\s+ENFORCED\b/gi, ')').replace(/\)\s*ENFORCED\b/gi, ')');
  text = text.replace(/\bDOUBLE\s+PRECISION\b/gi, 'DOUBLE');
  // INVISIBLE on a column; an index's INVISIBLE is understood by the parser and kept.
  text = text
    .split('\n')
    .map((line) =>
      /^\s*`/.test(line) && !/\bKEY\b|\bINDEX\b/i.test(line)
        ? line.replace(/\bINVISIBLE\b/gi, ' ')
        : line,
    )
    .join('\n');

  return { text, losses, columnAttributes, notEnforced };
}

/** Offset of `re` outside quotes and parentheses, or -1. */
function topLevelIndexOf(text: string, re: RegExp): number {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuoted(text, i, ch) - 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (
      depth === 0 &&
      re.test(text.slice(i, i + 32)) &&
      (i === 0 || /\s/.test(text[i - 1] ?? ''))
    ) {
      return i;
    }
  }
  return -1;
}

/** Offset of the `)` closing the `(` at `open`, or -1. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuoted(text, i, ch) - 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')' && (depth -= 1) === 0) return i;
  }
  return -1;
}

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
