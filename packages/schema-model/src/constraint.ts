import { z } from 'zod';
import { IrBaseShape } from './base.js';
import { IdSchema } from './ids.js';

/**
 * PK / UNIQUE / CHECK / EXCLUDE (§2.9). A foreign key is a `Link`, not a `Constraint`.
 *
 * `engineProps`: `expression` (the CHECK / EXCLUDE body), `deferrable`,
 * `initiallyDeferred`, `noInherit`, `usingIndex`, exclusion operators. The `fieldIds`
 * are core because the canvas PK badge, the diff, the cascade rules and link validity
 * depend on them; the expression is not, because only the engine can parse it.
 */
export const ConstraintSchema = z.object({
  ...IrBaseShape,
  entityId: IdSchema,
  /** Engine-defined (§3): "primaryKey" | "unique" | "check" | "exclusion" … */
  kind: z.string().max(64),
  /** Ordered participating fields. Empty for a table-level CHECK or EXCLUDE — which is
   *  why `logicalKey` falls back to the name for a fieldless constraint (§6.1). */
  fieldIds: z.array(IdSchema),
});

export type Constraint = z.infer<typeof ConstraintSchema>;
