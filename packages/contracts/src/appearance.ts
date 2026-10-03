import { z } from 'zod';

/**
 * A user's appearance: a theme (layout, density, type and colour family), one of that
 * theme's colour variants, and the light/dark mode. Stored on the user so it follows them
 * across devices; the browser keeps a copy so the first paint needs no request.
 *
 * The first variant of each theme is its default.
 */
export const APPEARANCE_THEMES = {
  studio: ['jade', 'cobalt', 'amber', 'rose'],
  blueprint: ['blue', 'graphite', 'olive'],
  float: ['mist', 'dusk', 'moss'],
  compact: ['phosphor', 'amber', 'ice'],
} as const;

export type AppearanceTheme = keyof typeof APPEARANCE_THEMES;
export const APPEARANCE_THEME_IDS = Object.keys(APPEARANCE_THEMES) as AppearanceTheme[];

export const APPEARANCE_MODES = ['system', 'light', 'dark'] as const;
export type AppearanceMode = (typeof APPEARANCE_MODES)[number];

export interface Appearance {
  readonly theme: AppearanceTheme;
  readonly variant: string;
  readonly mode: AppearanceMode;
}

export const DEFAULT_APPEARANCE: Appearance = { theme: 'studio', variant: 'jade', mode: 'system' };

/** A variant belongs to its theme: `blueprint` + `jade` is not a combination. */
export function isAppearanceVariant(theme: AppearanceTheme, variant: string): boolean {
  return (APPEARANCE_THEMES[theme] as readonly string[]).includes(variant);
}

/** What a client may write. Strict: an unknown key is a 400, not silently dropped. */
export const appearanceInputSchema = z
  .object({
    theme: z.enum(APPEARANCE_THEME_IDS as [AppearanceTheme, ...AppearanceTheme[]]),
    variant: z.string().min(1).max(32),
    mode: z.enum(APPEARANCE_MODES),
  })
  .strict()
  .refine((a) => isAppearanceVariant(a.theme, a.variant), {
    message: 'That colour variant does not belong to that theme',
    path: ['variant'],
  });

/** Reading a stored value back: anything unrecognisable becomes the default, never an error. */
export function readAppearance(raw: unknown): Appearance {
  const parsed = appearanceInputSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_APPEARANCE;
}
