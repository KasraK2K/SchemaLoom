/**
 * Phase 13 §4 — SQLite compares identifiers without case for ASCII letters (`Orders` and
 * `orders` are one table) and keeps the spelling as written. Identity folds to lower case.
 */
export function normalizeName(name: string): string {
  return name.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** SQLite has no identifier limit; this is the IR's own name cap. */
export const MAX_IDENTIFIER_LENGTH = 255;
