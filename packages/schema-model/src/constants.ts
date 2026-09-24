/**
 * Ceiling on field nesting depth (a top-level field is depth 1).
 *
 * Owned here, not in `contracts`, because C10 makes the dependency
 * `contracts -> schema-model` and `validateModel` is the primary consumer.
 * `contracts` re-exports it so the API layer has one import site.
 *
 * Enforced in the APPLICATION, not the database: `fields.depth` and its CHECKs
 * were deliberately cut (doc 02), so the recursive CTE in `createField` /
 * `reparentField` rejects a move past this ceiling with a 422 rather than
 * surfacing a constraint violation as a raw 500. The CTE's own guard is
 * `WHERE lvl < MAX_FIELD_DEPTH + 1`, so a malformed tree still terminates.
 *
 * Only relevant to engines with `capabilities.nestedFields`; PostgreSQL never
 * nests, so in Phase 1 every field is depth 1.
 */
export const MAX_FIELD_DEPTH = 8;

/** Ceiling on the recursive CTE, so a cycle cannot spin. */
export const MAX_FIELD_DEPTH_CTE_GUARD = MAX_FIELD_DEPTH + 1;
