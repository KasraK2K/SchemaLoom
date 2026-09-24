import { z } from 'zod';
import { IrBaseShape } from './base.js';
import { DocRefSchema } from './doc-ref.js';
import { IdSchema, type Id } from './ids.js';
import { TypeRefSchema } from './type-ref.js';

/**
 * A column / attribute / property (§2.6).
 *
 * Not core, therefore `engineProps`: `default`, `identity`, `generatedExpression`,
 * `collation`, `storage`, `compression`. Notably `default` is `engineProps` — core never
 * renders or reasons about a default expression and its syntax is pure engine.
 *
 * PK / FK / UNIQUE badges are NOT field flags. They are derived from `Constraint` and
 * `Link` objects through the index, so the truth lives in exactly one place and no
 * denormalized flag can go stale.
 */
export const FieldSchema = z.object({
  ...IrBaseShape,
  entityId: IdSchema,
  /** null = top level. Nesting is flat-with-a-parent-pointer, mirroring the
   *  `fields.parent_field_id` column exactly. Depth is bounded by `MAX_FIELD_DEPTH`. */
  parentFieldId: IdSchema.nullable(),
  /** Unique and DENSE among siblings (same `entityId` + same `parentFieldId`): 0…n-1.
   *  C11. Assigned by the SERVER on create (append). */
  ordinal: z.number().int().nonnegative(),
  type: TypeRefSchema,
  isNullable: z.boolean(),
  /** Core columns because core filters, badges and (for `isRestricted`) redacts on them
   *  — the C4 exception. All three are engine-neutral: every paradigm has optional
   *  values, personal data, and deprecation. */
  isRestricted: z.boolean(),
  isPii: z.boolean(),
  isDeprecated: z.boolean(),
  doc: DocRefSchema.nullable(),
});

export type Field = z.infer<typeof FieldSchema>;

/**
 * CANONICAL addressing (§4.1). Root-to-leaf chain of ids, stable across every rename
 * because ids never change (C1). This is what anything persisted or compared uses: diff
 * entries, comment targets, doc targets, AI citations, selection chips. Single-element in
 * v1, because PostgreSQL's `capabilities.supportsNestedFields` is false.
 */
export type FieldPath = readonly Id[];

/**
 * DISPLAY ONLY. Derived on demand; changes when anyone renames anything. Rendered by
 * joining with "." — v1 has one segment, so there is nothing to escape.
 */
export type FieldNamePath = readonly string[];
