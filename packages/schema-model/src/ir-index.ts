import { z } from 'zod';
import { IrBaseShape, EnginePropsSchema } from './base.js';
import { IdSchema } from './ids.js';

/**
 * One column of an `Index` (§2.8).
 *
 * An `IndexColumn` is not an IR *object* — it has no id and no version — but it is the
 * one nested structure that carries a props bag, which is why `EnginePropsKind` has an
 * `'indexColumn'` member.
 */
export const IndexColumnSchema = z
  .object({
    /** C11, dense 0…n-1. */
    ordinal: z.number().int().nonnegative(),
    /** Exactly one of `fieldId` / `expression` is set (INDEX_COLUMN_SOURCE, §11.1). */
    fieldId: IdSchema.nullable(),
    /** Expression-index body, engine syntax. */
    expression: z.string().max(4000).nullable(),
    /** 'key' participates in the index; 'include' is a payload column (PostgreSQL
     *  INCLUDE). Core carries this distinction because the reference to a field must
     *  live in a core structure (§2.1) so that deleting the field cascades out of the
     *  INCLUDE list. */
    role: z.enum(['key', 'include']),
    direction: z.enum(['asc', 'desc']).optional(),
    /** Per-column engine vocabulary: operator class, collation, NULLS FIRST/LAST. */
    engineProps: EnginePropsSchema,
  })
  .refine((c) => (c.fieldId === null) !== (c.expression === null), {
    // Mirrors INDEX_COLUMN_SOURCE (§11.1) and doc 02's CHECK on index_columns.
    message: 'exactly one of fieldId / expression must be set',
  });

export type IndexColumn = z.infer<typeof IndexColumnSchema>;

/**
 * A physical index (§2.8). `engineProps`: `where` (partial predicate), `opclass`,
 * `nullsOrder`, `fillfactor`, `concurrently`, `tablespace`.
 */
export const IndexSchema = z.object({
  ...IrBaseShape,
  entityId: IdSchema,
  /** Engine access method (§3): "btree" | "gin" | … */
  kind: z.string().max(64),
  /** Core: drives the field UNIQUE badge. */
  isUnique: z.boolean(),
  /** Ordered by `ordinal`. */
  columns: z.array(IndexColumnSchema),
});

export type Index = z.infer<typeof IndexSchema>;
