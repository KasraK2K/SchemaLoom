import { z } from 'zod';
import { IrBaseShape } from './base.js';
import { DocRefSchema } from './doc-ref.js';

/**
 * A canvas grouping and a permission resource (C5) (§2.11).
 *
 * `Area` IS an `IrBase` and carries `engineProps`, permanently `{}`. Making it the one
 * exception costs code: because `IrObject` is a union including `Area`, every generic
 * routine — the deep diff's `['engineProps', …]` walk, redaction's blanking, `applyOps`
 * — would need a `hasEngineProps(type)` narrowing first. Five guards to avoid one `{}`.
 * The engine's `propsSchemas` simply has no `area` entry.
 *
 * There is no `rect`: the canvas derives an Area's drawn region from the bounding box of
 * its member entities (`Entity.areaId`) plus a fixed padding, so the region is a pure
 * function of data that already exists and can never disagree with membership.
 */
export const AreaSchema = z.object({
  ...IrBaseShape,
  /** A theme token name, not a hex value: `area-1` … `area-8`, so light/dark and every
   *  appearance theme stay with the design tokens. Older projects hold a Radix name
   *  ("indigo" | "amber" | …); the canvas reads those too (`area-color.ts`). */
  color: z.string().min(1).max(32),
  /** C11 — order in the sidebar legend and in the Area filter list. */
  ordinal: z.number().int().nonnegative(),
  doc: DocRefSchema.nullable(),
});

export type Area = z.infer<typeof AreaSchema>;
