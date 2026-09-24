import { z } from 'zod';
import { IdSchema } from './ids.js';

/**
 * A field's type (§2.6). Core because the generic card, docs mode, search ("find every
 * `uuid` column") and the diff all need it, and because the migration generator's most
 * important question — "did this type change?" — must be answerable structurally rather
 * than by string-comparing a rendered label.
 *
 * There is deliberately NO `display` property. An engine-rendered label the client had
 * to mint on create while the server also computed it is two renderers, guaranteed to
 * drift on the first edge case (`varchar(255)` vs `character varying(255)`). Rendering a
 * type label is engine work; deleting it also makes `assembleModel` entirely engine-free.
 */
export const TypeRefSchema = z.object({
  /** The type identifier as the engine spells it: "varchar", "numeric", "uuid", or the
   *  name of a CustomType. Not `.min(1)`: a redacted masked field blanks it to ""
   *  (§10.2). The engine validator rejects an empty type name on a live model. */
  name: z.string().max(255),
  /** Type parameters in declaration order: varchar(255) -> [255], numeric(10,2) ->
   *  [10, 2]. Core, and a real column (`fields.type_args`). */
  args: z.array(z.union([z.string(), z.number()])).optional(),
  /** Set when `name` resolves to a CustomType in this model (enum / domain / composite).
   *  Core needs the edge for dangling-reference validation, delete warnings, and export
   *  topological order. */
  customTypeId: IdSchema.nullish(),
  /** 0 or absent = scalar, 1 = array, 2 = array of arrays. One optional number, so
   *  array-ness never has to be smuggled into `name` (which would make diffs lie) or
   *  into `engineProps` (which core cannot read). */
  dimensions: z.number().int().min(0).max(4).optional(),
});

export type TypeRef = z.infer<typeof TypeRefSchema>;
