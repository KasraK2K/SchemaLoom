import {
  APPEARANCE_THEMES,
  DEFAULT_APPEARANCE,
  isAppearanceVariant,
  type AppearanceTheme,
} from '@schemaloom/contracts';

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_STORAGE_KEY = 'sl-theme';
/** The appearance theme and colour variant, as JSON `{ theme, variant }`. */
export const LOOK_STORAGE_KEY = 'sl-appearance';

/** The part of an appearance that is not the light/dark mode. */
export interface Look {
  readonly theme: AppearanceTheme;
  readonly variant: string;
}

export const DEFAULT_LOOK: Look = {
  theme: DEFAULT_APPEARANCE.theme,
  variant: DEFAULT_APPEARANCE.variant,
};

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

export function isLook(value: unknown): value is Look {
  if (typeof value !== 'object' || value === null) return false;
  const { theme, variant } = value as { theme?: unknown; variant?: unknown };
  return (
    typeof theme === 'string' &&
    theme in APPEARANCE_THEMES &&
    typeof variant === 'string' &&
    isAppearanceVariant(theme as AppearanceTheme, variant)
  );
}

export function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : 'system';
  } catch {
    // Private mode, blocked storage. A missing preference is not an error.
    return 'system';
  }
}

export function readStoredLook(): Look {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(LOOK_STORAGE_KEY) ?? 'null');
    return isLook(stored) ? stored : DEFAULT_LOOK;
  } catch {
    return DEFAULT_LOOK;
  }
}

export function prefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Writes the resolved theme class onto <html>. theme.css keys every token off it. */
export function applyTheme(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && prefersDark());
  const classes = document.documentElement.classList;
  classes.toggle('dark', dark);
  classes.toggle('light', !dark);
}

/** Writes the appearance theme and variant onto <html>. themes.css keys off them. */
export function applyLook(look: Look): void {
  document.documentElement.dataset.theme = look.theme;
  document.documentElement.dataset.variant = look.variant;
}

/**
 * Runs synchronously in <head>, BEFORE the first paint and long before React
 * hydrates. Doing this in an effect instead is what produces the white flash on a
 * dark-theme reload: the browser has already painted the light default by then.
 *
 * Deliberately duplicates `applyTheme` and `applyLook` rather than importing them: this
 * string is inlined into the HTML document, not into the JS bundle. Keep them in step.
 * The theme table is the contract's, serialised in, so a stale or tampered value in
 * storage falls back to the default instead of naming a theme that has no CSS.
 */
export const THEME_INIT_SCRIPT = `(function(){var e=document.documentElement;try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t!=='light'&&t!=='dark')t='system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);e.classList.toggle('dark',d);e.classList.toggle('light',!d);}catch(x){}var k=${JSON.stringify(
  APPEARANCE_THEMES,
)},l=${JSON.stringify(DEFAULT_LOOK)};try{var s=JSON.parse(localStorage.getItem(${JSON.stringify(
  LOOK_STORAGE_KEY,
)})||'null');if(s&&k[s.theme]&&k[s.theme].indexOf(s.variant)>=0)l=s;}catch(x){}e.dataset.theme=l.theme;e.dataset.variant=l.variant;})();`;
