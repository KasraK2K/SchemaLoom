import { z } from 'zod';

/**
 * `projects.settings` (doc 02 §7). Declared once, exported twice: `Input` (.strict()) is
 * what a write must satisfy, `Stored` (.strip()) reads a row back so a renamed key never
 * turns into an outage. `restrictedFieldMode` is a real column, not a key here.
 */
const projectSettingsShape = {
  ai: z
    .object({
      /** Project kill switch, ANDed with the `ai:use` atom at the call site. */
      enabled: z.boolean().default(true),
      includeDocsInContext: z.boolean().default(true),
    })
    .strict()
    .default({ enabled: true, includeDocsInContext: true }),
};
export const projectSettingsInputSchema = z.object(projectSettingsShape).strict();
export const projectSettingsStoredSchema = z.object(projectSettingsShape);
export type ProjectSettings = z.infer<typeof projectSettingsStoredSchema>;

/** `PATCH /projects/:id/settings` — only the keys sent change; no defaults applied. */
export const projectSettingsPatchSchema = z
  .object({
    ai: z.object({ enabled: z.boolean(), includeDocsInContext: z.boolean() }).partial().strict(),
  })
  .partial()
  .strict();
export type ProjectSettingsPatch = z.infer<typeof projectSettingsPatchSchema>;

/** A stored row with a patch applied, re-validated by the strict input schema. */
export function applyProjectSettingsPatch(
  raw: unknown,
  patch: ProjectSettingsPatch,
): ProjectSettings {
  const parsed = projectSettingsStoredSchema.safeParse(raw ?? {});
  const current = parsed.success ? parsed.data : projectSettingsStoredSchema.parse({});
  return projectSettingsInputSchema.parse({ ...current, ai: { ...current.ai, ...patch.ai } });
}
