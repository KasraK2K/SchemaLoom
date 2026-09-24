import { z } from 'zod';
import { IrBaseShape } from './base.js';
import { DocRefSchema } from './doc-ref.js';
import { IdSchema } from './ids.js';

/** Canvas geometry. Only canvas-placed objects have it, so it is not on `IrBase`. */
export const PointSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export type Point = z.infer<typeof PointSchema>;

/**
 * A table / view / collection (§2.5).
 *
 * `kind` is core although only the engine knows its values: core must group, count,
 * filter ("show only views") and pick a renderer by kind, and the diff must treat a kind
 * change as structural. Core stores it; core never branches on its value.
 *
 * `viewDefinition` is `engineProps` even though it is arguably the most important
 * property of a view — it is engine-specific SQL and core has no use for it. Likewise
 * `unlogged`, `tablespace`, `partitionBy`, `inherits`, `rowLevelSecurity`.
 */
export const EntitySchema = z.object({
  ...IrBaseShape,
  /** Non-null in the IR: assembly resolves a null `entities.namespace_id` to the default
   *  namespace's id. */
  namespaceId: IdSchema,
  /** Engine-defined (§3): "table" | "view" | "materializedView" … */
  kind: z.string().max(64),
  /** Explicit membership, not geometric containment — Areas are permission resources
   *  (C5), so "which Area is this in" must never depend on pixels. Changing it is a
   *  `governance` severity change (§7.4), never cosmetic. */
  areaId: IdSchema.nullable(),
  position: PointSchema,
  /** User-resized card box. Both optional; absent means content-derived. */
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  /** Per-entity colour override (Radix palette token). Null = inherit the Area's. */
  color: z.string().max(32).nullable(),
  doc: DocRefSchema.nullable(),
});

export type Entity = z.infer<typeof EntitySchema>;
