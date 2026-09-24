import { z } from 'zod';
import { IdSchema } from './ids.js';

/** Ceiling on `DocRef.excerpt` before the "…" suffix (§2.3). */
export const DOC_EXCERPT_CHARS = 200;

/**
 * Documentation reference (§2.3). Only `Area`, `Entity` and `Field` carry one, because
 * doc 02's `TargetType` is `project | area | entity | field` — a permanently-null `doc`
 * on the other five types would be a lie repeated in every snapshot.
 *
 * `doc === null` is the canvas's "undocumented" state and the coverage meter's
 * denominator input. A doc row whose text is empty still yields a `DocRef` — the object
 * *is* documented.
 *
 * The full text, the rich JSON and the structured facts are fetched by `id` from the
 * docs endpoint; shipping them here would be megabytes of prose in every project open.
 * SERVER-OWNED in every write path (§8.3).
 */
export const DocRefSchema = z.object({
  id: IdSchema,
  /** A bounded excerpt of the flattened TipTap text: at most `DOC_EXCERPT_CHARS`, cut on
   *  a word boundary, suffixed with "…" when truncated. Max is 240 — the ceiling plus
   *  room for the ellipsis and a wide word boundary. */
  excerpt: z.string().max(240),
});

export type DocRef = z.infer<typeof DocRefSchema>;
