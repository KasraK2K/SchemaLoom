/**
 * PostgreSQL identifier folding — the one pure function core takes from an engine
 * (doc 03 §3, doc 04 §6.3). Load-bearing: without it the import matcher inserts a
 * duplicate `Orders` beside `orders`, `NAME_COLLISION` never fires, and the exporter
 * emits DDL PostgreSQL rejects.
 *
 * Two rules, both from the server:
 *   1. an unquoted identifier folds to LOWER case;
 *   2. an identifier is truncated to NAMEDATALEN - 1 = 63 **bytes**, not characters.
 *
 * No Node built-in here — not even `Buffer` or `TextEncoder` — because this module is in
 * the `./static` graph and runs in the browser.
 */

/** NAMEDATALEN is 64; one byte goes to the terminator. */
export const NAMEDATALEN_BYTES = 63;

/** UTF-8 width of one code point. */
function codePointBytes(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** UTF-8 byte length of `s`. The validator's length rule counts in these units. */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (const char of s) bytes += codePointBytes(char.codePointAt(0) ?? 0);
  return bytes;
}

/**
 * Clip to `maxBytes` UTF-8 bytes on a code-point boundary, the way `pg_mbcliplen` does:
 * a multi-byte character is dropped whole rather than split into a broken sequence.
 */
export function truncateToBytes(s: string, maxBytes: number): string {
  let bytes = 0;
  let out = '';
  for (const char of s) {
    const width = codePointBytes(char.codePointAt(0) ?? 0);
    if (bytes + width > maxBytes) return out;
    bytes += width;
    out += char;
  }
  return out;
}

/**
 * Fold, then clip. In that order because folding can change the byte length
 * (`'İ'.toLowerCase()` is two code points), and the guarantee core needs is about the
 * OUTPUT: the result is always <= 63 bytes, and `normalizeName(normalizeName(s))` is
 * `normalizeName(s)`.
 */
export function normalizeName(name: string): string {
  return truncateToBytes(name.toLowerCase(), NAMEDATALEN_BYTES);
}
