import { z } from 'zod';
import { IrBaseShape } from './base.js';
import { IdSchema } from './ids.js';

/**
 * One side of a `Link` (§2.7).
 *
 * `LinkEndpoint.role` is deliberately absent: it had no column in doc 02, and it was
 * redundant — two links between the same pair are already distinguished by their
 * `fieldIds`, and the edge label the canvas wants is `Link.name`.
 */
export const LinkEndpointSchema = z.object({
  entityId: IdSchema,
  /** Ordered. Composite links pair `from.fieldIds[i]` with `to.fieldIds[i]`; array index
   *  IS the pairing, so both sides always have equal length — structurally guaranteed by
   *  the store, where ONE `link_endpoints` row carries both ids.
   *
   *  May be empty on BOTH sides for an entity-level link: a graph edge with no key
   *  columns, a link the user drew before choosing columns, an N:M before its junction
   *  table exists, or a redacted link. */
  fieldIds: z.array(IdSchema),
});

export type LinkEndpoint = z.infer<typeof LinkEndpointSchema>;

/**
 * A foreign key / reference / graph edge (§2.7). One user-visible concept, one object:
 * the canvas draws it, the exporter emits `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY`
 * from it, the AI join-path search walks it.
 *
 * `from.entityId === to.entityId` is legal — the canvas renders a loop edge and
 * `Link.name` labels it.
 *
 * `onDelete`, `onUpdate`, `deferrable`, `matchFull` are `engineProps`: the action names
 * are PostgreSQL's, and MongoDB has none.
 */
export const LinkSchema = z.object({
  ...IrBaseShape,
  /** Engine-defined (§3). */
  kind: z.string().max(64),
  /** The referencing / child / source side. */
  from: LinkEndpointSchema,
  /** The referenced / parent / target side. */
  to: LinkEndpointSchema,
  cardinality: z.enum(['1:1', '1:N', 'N:1', 'N:M']),
});

export type Link = z.infer<typeof LinkSchema>;

export type Cardinality = Link['cardinality'];
