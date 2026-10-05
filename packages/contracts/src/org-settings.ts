import { z } from 'zod';
import { appearanceInputSchema } from './appearance.js';

/**
 * `organizations.settings` (doc 02 §7). Same split as `projects.settings`: `Input` (.strict())
 * is what a write must satisfy, `Stored` (.strip()) reads a row back so a renamed key or a
 * hand-edited value never turns into an outage.
 *
 * `defaultAppearance` (docs/phase17/ORG-DEFAULT.md): the look a new account starts on when it
 * is created through the org. `null` means Studio Jade, as before.
 */
export const orgSettingsInputSchema = z
  .object({
    allowGuestInvites: z.boolean().default(true),
    defaultAppearance: appearanceInputSchema.nullable().default(null),
  })
  .strict();
export const orgSettingsStoredSchema = z.object({
  allowGuestInvites: z.boolean().catch(true).default(true),
  defaultAppearance: appearanceInputSchema.nullable().catch(null).default(null),
});
export type OrgSettings = z.infer<typeof orgSettingsInputSchema>;

/** `PATCH /organizations/:orgSlug/settings` — only the keys sent change. */
export const orgSettingsPatchSchema = z
  .object({
    allowGuestInvites: z.boolean(),
    defaultAppearance: appearanceInputSchema.nullable(),
  })
  .partial()
  .strict();
export type OrgSettingsPatch = z.infer<typeof orgSettingsPatchSchema>;

/** A stored row, tolerant of anything: unreadable values fall back to their defaults. */
export function readOrgSettings(raw: unknown): OrgSettings {
  return orgSettingsStoredSchema.parse(raw ?? {});
}

/** A stored row with a patch applied, re-validated by the strict input schema. */
export function applyOrgSettingsPatch(raw: unknown, patch: OrgSettingsPatch): OrgSettings {
  return orgSettingsInputSchema.parse({ ...readOrgSettings(raw), ...patch });
}
