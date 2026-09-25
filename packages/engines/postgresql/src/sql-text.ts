import { RESERVED_WORDS } from './reserved-words.js';

/**
 * Writing PostgreSQL text: identifiers, string literals and comment bodies.
 *
 * Every rule here is about the OUTPUT being valid and STABLE. The exporter's contract is
 * byte-identical DDL for the same input on every machine (§10.1), so nothing in this file may
 * branch on locale, environment or iteration order.
 */

const RESERVED: ReadonlySet<string> = new Set(RESERVED_WORDS);

/** `capabilities.identifiers.validUnquoted`, compiled once. */
const UNQUOTED = /^[a-z_][a-z0-9_$]*$/;

/**
 * Quote only when PostgreSQL would otherwise read the name as something else: an uppercase
 * letter (the server folds it), a punctuation character, a leading digit, or a reserved word.
 *
 * Quoting everything unconditionally would also be correct DDL, and it was the first draft.
 * It is rejected because the exported file is something a human reads and diffs: `"orders"`
 * on every line is noise, and the one name that genuinely needed quoting stops standing out.
 */
export function quoteIdentifier(name: string): string {
  if (UNQUOTED.test(name) && !RESERVED.has(name)) return name;
  return `"${name.replace(/"/g, '""')}"`;
}

/** `schema.table`, with each part quoted independently. An empty namespace name — the shape
 *  an engine with `supportsNamespaces: false` gets — yields the bare object name. */
export function qualify(namespaceName: string, objectName: string): string {
  const object = quoteIdentifier(objectName);
  return namespaceName === '' ? object : `${quoteIdentifier(namespaceName)}.${object}`;
}

/** A single-quoted literal with embedded quotes doubled. */
export function quoteLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * §10.2's escaping rule for a `COMMENT ON` body: single quotes doubled, and dollar-quoting
 * once the text contains a quote.
 *
 * The tag widens deterministically (`$doc$`, `$doc1$`, `$doc2$`, …) until it does not occur in
 * the text, so the same excerpt always produces the same bytes — which is what makes a
 * documentation change show up as one line in a diff of two exports.
 */
export function quoteDocText(text: string): string {
  if (!text.includes("'")) return quoteLiteral(text);
  let suffix = 0;
  let tag = '$doc$';
  while (text.includes(tag)) {
    suffix += 1;
    tag = `$doc${String(suffix)}$`;
  }
  return `${tag}${text}${tag}`;
}
