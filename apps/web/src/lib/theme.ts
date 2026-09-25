export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_STORAGE_KEY = 'sl-theme';

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
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

/**
 * Runs synchronously in <head>, BEFORE the first paint and long before React
 * hydrates. Doing this in an effect instead is what produces the white flash on a
 * dark-theme reload: the browser has already painted the light default by then.
 *
 * Deliberately duplicates `applyTheme` rather than importing it — this string is
 * inlined into the HTML document, not into the JS bundle. Keep the two in step.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t!=='light'&&t!=='dark')t='system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var c=document.documentElement.classList;c.toggle('dark',d);c.toggle('light',!d);}catch(e){}})();`;
