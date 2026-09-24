import { z } from 'zod';
import { IrBaseShape } from './base.js';

/**
 * A schema / database / collection-group (§2.4).
 *
 * No `doc` (no `TargetType` entry) and no `kind` — a namespace is a namespace in every
 * paradigm; only its *label* differs, and labels come from the engine's terminology map,
 * not from data. `engineProps`: owner, default privileges, MongoDB collation defaults.
 */
export const NamespaceSchema = z.object({
  ...IrBaseShape,
  /** Exactly one namespace per project has `isDefault === true`. It is where entities
   *  with no explicit namespace land, where stub entities land in a redacted model
   *  (§10.2 / RECONCILIATION R-2), and what the "new table" dialog preselects. Engines
   *  with `capabilities.supportsNamespaces === false` get exactly this one, named "", so
   *  every entity has a parent and logical keys have one shape. */
  isDefault: z.boolean(),
});

export type Namespace = z.infer<typeof NamespaceSchema>;
