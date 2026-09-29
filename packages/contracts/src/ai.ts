import { z } from 'zod';

/** Doc 02 §7 — `ai_threads.selection`: the canvas selection an AI thread was started from.
 *  Also the request body type for the AI endpoint. Ids are best-effort (Open question 5). */
export const selectionSchema = z
  .object({
    entityIds: z.array(z.string()).max(500).default([]),
    fieldIds: z.array(z.string()).max(2_000).default([]),
    linkIds: z.array(z.string()).max(1_000).default([]),
    areaIds: z.array(z.string()).max(100).default([]),
  })
  .strict();
export type Selection = z.infer<typeof selectionSchema>;

/** Doc 02 §7 — `ai_messages.metadata`. */
export const aiMessageMetaSchema = z
  .object({
    assumptions: z.array(z.string().max(500)).max(20).default([]),
    /** Engine queryValidator result. */
    validation: z
      .object({
        ok: z.boolean(),
        unknownIdentifiers: z.array(z.string()).max(100).default([]),
      })
      .nullable()
      .default(null),
    /** Entities the produced query touches — drives the canvas glow. */
    usedEntityIds: z.array(z.string()).max(200).default([]),
    /** Visible-but-unselected entities the join path needs. */
    suggestedEntityIds: z.array(z.string()).max(50).default([]),
    finishReason: z.string().max(50).nullable().default(null),
  })
  .strict();
export type AiMessageMeta = z.infer<typeof aiMessageMetaSchema>;
