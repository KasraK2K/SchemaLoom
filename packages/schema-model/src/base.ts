import { z } from 'zod';
import { IdSchema } from './ids.js';

/**
 * The engine-owned bag (C4). Core validates the CONTAINER only; the engine's
 * `propsSchemas` validate the contents on write (§11.2). Arrays and null are rejected
 * here so `{ ...engineProps }` is always safe.
 *
 * The one hard constraint (§2.1): `engineProps` must never contain a reference to
 * another IR object — core could not cascade, validate or redact it. Enforced by review
 * of each engine's `propsSchemas`, not by a runtime scan.
 */
export const EnginePropsSchema = z.record(z.string(), z.unknown());

export type EngineProps = z.infer<typeof EnginePropsSchema>;

/**
 * Every IR object this object's engine-owned expressions textually reference — a CHECK
 * body, a partial-index predicate, a default, a generated-column expression, an index
 * column's expression. Produced by the engine's `extractReferences` (doc 03 §3.1) on
 * every write and import, and read by doc 05's R27, which blanks `engineProps` when any
 * referenced object is invisible. Absent or empty = no cross-object expression.
 * SERVER-OWNED (§8.3).
 */
export const ObjectRefsSchema = z.object({
  entityIds: z.array(IdSchema).max(500),
  fieldIds: z.array(IdSchema).max(2000),
});

export type ObjectRefs = z.infer<typeof ObjectRefsSchema>;

/**
 * Shared by all eight object schemas. `kind` is NOT here: three types have none.
 * `doc` is NOT here: only three types can carry one (§2.2). `position` and `area` are
 * not here either — only canvas-placed objects have geometry.
 */
export const IrBaseShape = {
  id: IdSchema,
  /** Empty string is legal: links and constraints are often unnamed, and a redacted
   *  stub blanks its name. `EMPTY_NAME` (§11.1) warns only where a name is required. */
  name: z.string().max(255),
  /** C7. The value the client must echo as `expectedVersion` on the next write. */
  version: z.number().int().nonnegative(),
  engineProps: EnginePropsSchema,
  /**
   * RECONCILIATION R-1 (overrides doc 04 §2.2's `restricted?: RestrictionMark`).
   *
   * This object is hidden from the viewer: an entity stub, a masked field, or a
   * badge-only index/constraint. Which of the three is recoverable from the object's
   * TYPE, so there is no `level`. Only ever set by `VisibilityFilter` (§10).
   */
  restricted: z.literal(true).optional(),
  /**
   * RECONCILIATION R-1. This object's `engineProps` were blanked because an expression
   * inside them named something the viewer may not see (doc 05 R27).
   *
   * ORTHOGONAL to `restricted`, not a grade of it: a fully visible object — one the
   * viewer has every right to see — can carry this. Folding it into a three-value
   * `level` would make `if (obj.restricted)` start hiding objects the viewer is allowed
   * to see.
   */
  propsRedacted: z.literal(true).optional(),
  refs: ObjectRefsSchema.optional(),
};

export const IrBaseSchema = z.object(IrBaseShape);

export type IrBase = z.infer<typeof IrBaseSchema>;
