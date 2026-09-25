/**
 * The `libpg-query` seam — set up now, used from build-order step 21 (the importer).
 *
 * THE ONE RULE: this import stays DYNAMIC. `libpg-query` is a multi-megabyte WASM build
 * of the real PostgreSQL parser, and `./static` must never reach it (doc 03 §1.1). A
 * static `import { parse } from 'libpg-query'` added later would land in the browser
 * bundle silently — nothing would fail until the canvas stops loading — so the seam
 * exists before the first caller, and `static-boundary.spec.ts` asserts that nothing in
 * `static.ts`'s import graph can see this module.
 *
 * The WASM module loads once per process: the promise is the cache, so a second caller
 * awaits the first load rather than starting another.
 */

/** Just enough of libpg-query's surface to compile against. Step 21 widens it. */
export interface SqlParser {
  parse(sql: string): Promise<unknown>;
}

let parser: Promise<SqlParser> | undefined;

export function loadSqlParser(): Promise<SqlParser> {
  // The module's own types are `any`-heavy; one widening cast at the boundary keeps the
  // rest of the package honest.
  parser ??= import('libpg-query').then((module): SqlParser => module as unknown as SqlParser);
  return parser;
}
