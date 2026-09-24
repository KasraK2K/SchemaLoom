/**
 * Engine-supplied identifier folding (§6.3) — the ONE pure function core takes from an
 * engine, now the only one since `renderType` went with `TypeRef.display`.
 *
 * Pure, total, idempotent: `normalizeName(normalizeName(s)) === normalizeName(s)`.
 * PostgreSQL's is `s => s.toLowerCase()` for unquoted identifiers; MongoDB's is the
 * identity.
 *
 * Why core needs it: the matcher that decides insert-versus-update on import IS core.
 * Without folding, importing `CREATE TABLE Orders (…)` into a project that already holds
 * `orders` produces different logical keys, so the importer inserts a duplicate entity,
 * `NAME_COLLISION` (exact) does not fire, and the export emits DDL that fails in the
 * user's terminal.
 *
 * DO NOT implement engine rules here. This package declares the seam; the engine
 * supplies the function and the caller injects it (C10 — never imported).
 */
export type NormalizeName = (name: string) => string;

/**
 * The default. `createIndex(model, { normalizeName: engine.normalizeName })` is what the
 * API builds per request; anything without an engine in hand folds nothing.
 */
export const identityNormalizeName: NormalizeName = (name) => name;

/**
 * Which matcher runs where (§6.2):
 *
 * | Situation                                  | Strategy          |
 * |--------------------------------------------|-------------------|
 * | Two snapshots of the same project           | `id-then-logical` |
 * | Live model vs a snapshot of the same project| `id-then-logical` |
 * | Snapshot restore after hard delete (C8)     | `id-then-logical` |
 * | Import of external DDL / JSON               | `logical`         |
 * | Cross-project compare (staging vs prod)     | `logical`         |
 *
 * `id-then-logical` matches by id first and rescues the leftovers by logical key, which
 * is what re-creates the pairing when C8's hard delete minted new cuids for the same
 * logical objects. `logical` is for the two cases where ids are absent or unrelated.
 */
export type MatchStrategy = 'id-then-logical' | 'logical';
