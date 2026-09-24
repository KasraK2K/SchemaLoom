import { z } from 'zod';

/**
 * All ids are cuid strings (C1) and are the same values as the database row ids, so an
 * IR loaded from the DB round-trips without an id map. This holds in a redacted model
 * too: a stub or masked object carries the REAL cuid of the row it stands for (§10, doc
 * 05 §7.10), so there is no second id space and no prefix for a write route to reject.
 *
 * There is exactly ONE id type. Ten per-object aliases (`EntityId`, `FieldId`, …) were
 * all `= string`, so TypeScript happily accepted a field id where an entity id was
 * wanted; they prevented nothing. Parameter names carry the same documentation for free.
 */
export type Id = string;

export const IdSchema = z.string().min(1).max(64);
