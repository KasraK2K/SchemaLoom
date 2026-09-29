import { z } from 'zod';

/** Doc 02 `TargetType`: what a `docs` row can document. */
export const DOC_TARGET_TYPES = ['project', 'area', 'entity', 'field'] as const;
export const docTargetTypeSchema = z.enum(DOC_TARGET_TYPES);
export type DocTargetType = (typeof DOC_TARGET_TYPES)[number];

/**
 * Doc 02 §7 — TipTap output. The envelope and the size, not every node type: a full
 * ProseMirror schema mirror in zod would rot the first time a mark is added. The
 * node/mark allow-list is applied by the docs write pipeline, before this parse.
 */
export const richTextSchema = z
  .looseObject({ type: z.literal('doc'), content: z.array(z.unknown()).max(5_000).optional() })
  .refine((d) => JSON.stringify(d).length <= 512_000, 'document too large');

/**
 * Doc 02 §7 — only `entity` and `field` have structured facts; a project- or area-level
 * doc has `structured = NULL`.
 */
export const structuredDocSchema = z.discriminatedUnion('targetType', [
  z.strictObject({
    targetType: z.literal('entity'),
    ownerUserId: z.string().nullable().default(null),
    businessMeaning: z.string().max(4_000).default(''),
  }),
  z.strictObject({
    targetType: z.literal('field'),
    businessMeaning: z.string().max(4_000).default(''),
    allowedValues: z
      .array(z.object({ value: z.string().max(200), meaning: z.string().max(500) }))
      .max(200)
      .default([]),
    examples: z.array(z.string().max(500)).max(20).default([]),
    unit: z.string().max(50).nullable().default(null),
    ownerUserId: z.string().nullable().default(null),
  }),
]);
export type StructuredDoc = z.infer<typeof structuredDocSchema>;
export type FieldDocFacts = Extract<StructuredDoc, { targetType: 'field' }>;
