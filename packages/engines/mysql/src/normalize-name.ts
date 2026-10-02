/**
 * Phase 9 Q3: MySQL names are compared CASE-INSENSITIVELY and stored as written.
 *
 * Column names are always case-insensitive in MySQL. Table names depend on the server's
 * `lower_case_table_names`: insensitive on Windows, macOS and most managed services, sensitive
 * on a default Linux install. Treating them as insensitive everywhere keeps a schema portable;
 * the cost is that a Linux database with two tables differing only by case cannot be imported.
 */
export function normalizeName(name: string): string {
  return name.toLowerCase();
}

/** MySQL identifiers are at most 64 characters (not bytes). */
export const MAX_IDENTIFIER_LENGTH = 64;
