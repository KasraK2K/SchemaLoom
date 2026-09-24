import { z } from 'zod';
import { IrBaseShape } from './base.js';
import { IdSchema } from './ids.js';

/**
 * A user-defined type: enum, domain, composite (§2.10).
 *
 * Everything that varies by kind — enum labels and their order, a domain's base type and
 * checks, a composite's attributes — is `engineProps`. Core needs only identity, name,
 * namespace and kind: enough to render a chip, resolve `TypeRef.customTypeId`, order the
 * export, and warn when something still references a type being deleted.
 */
export const CustomTypeSchema = z.object({
  ...IrBaseShape,
  /** Non-null in the IR even though `custom_types.namespace_id` is nullable in the
   *  store: assembly resolves `null` to the default namespace's id. The IR is always
   *  explicit; the store may be sparse. */
  namespaceId: IdSchema,
  /** Engine-defined (§3): "enum" | "domain" | "composite" … Core never branches on it. */
  kind: z.string().max(64),
});

export type CustomType = z.infer<typeof CustomTypeSchema>;
