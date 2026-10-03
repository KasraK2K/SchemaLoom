'use client';

import type { Appearance } from '@schemaloom/contracts';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { apiFetch, apiUrl } from '@/lib/api-client';
import {
  DEFAULT_LOOK,
  LOOK_STORAGE_KEY,
  THEME_STORAGE_KEY,
  applyLook,
  applyTheme,
  isLook,
  isTheme,
  readStoredLook,
  readStoredTheme,
  type Look,
  type Theme,
} from '@/lib/theme';

interface ThemeContextValue {
  /** The light/dark/system mode. */
  theme: Theme;
  setTheme: (theme: Theme) => void;
  /** The appearance theme and colour variant. */
  look: Look;
  /** Theme, variant and mode together, saved to the account as one value. */
  setAppearance: (look: Look, mode: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) throw new Error('useTheme must be used inside <ThemeProvider>');
  return value;
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Blocked storage: the choice still applies to this tab, it just will not stick here.
  }
}

/** Best effort: the account keeps the choice for other devices. */
function saveToAccount(appearance: Appearance): void {
  apiFetch('/auth/me/appearance', { method: 'PUT', body: appearance }).catch(() => undefined);
}

/**
 * The account's appearance, or null when nobody is signed in. A plain fetch on purpose:
 * `apiFetch` answers a 401 by refreshing and then sending the browser to /login, and this
 * runs on the sign-in pages too.
 */
async function accountAppearance(): Promise<Partial<Appearance> | null> {
  const response = await fetch(apiUrl('/auth/me'), { credentials: 'include' });
  if (!response.ok) return null;
  const me = (await response.json()) as { appearance?: Partial<Appearance> };
  return me.appearance ?? null;
}

/**
 * State only. The <html> class and data attributes are already correct before this
 * mounts (the inline script in layout.tsx set them from storage), so the first effect
 * here is a read, not a paint. Then the account's appearance wins, so a choice made on
 * another device arrives here too.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  // Defaults on both server and first client render; the real values are adopted in the
  // effect below. Reading localStorage during render would desync SSR and hydration.
  const [theme, setThemeState] = useState<Theme>('system');
  const [look, setLookState] = useState<Look>(DEFAULT_LOOK);
  // Only a signed-in visitor's choice is saved to an account.
  const signedIn = useRef(false);

  useEffect(() => {
    setThemeState(readStoredTheme());
    setLookState(readStoredLook());
    let cancelled = false;
    accountAppearance()
      .then((a) => {
        if (cancelled || a === null) return;
        signedIn.current = true;
        const fromAccount = { theme: a.theme, variant: a.variant };
        if (isLook(fromAccount)) {
          setLookState(fromAccount);
          applyLook(fromAccount);
          store(LOOK_STORAGE_KEY, JSON.stringify(fromAccount));
        }
        if (isTheme(a.mode)) {
          setThemeState(a.mode);
          applyTheme(a.mode);
          store(THEME_STORAGE_KEY, a.mode);
        }
      })
      .catch(() => undefined); // signed out, or offline: the stored choice stands
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      applyTheme('system');
    };
    media.addEventListener('change', onChange);
    return () => {
      media.removeEventListener('change', onChange);
    };
  }, [theme]);

  const setAppearance = useCallback((nextLook: Look, nextMode: Theme) => {
    setLookState(nextLook);
    setThemeState(nextMode);
    applyLook(nextLook);
    applyTheme(nextMode);
    store(LOOK_STORAGE_KEY, JSON.stringify(nextLook));
    store(THEME_STORAGE_KEY, nextMode);
    if (signedIn.current) saveToAccount({ ...nextLook, mode: nextMode });
  }, []);

  const setTheme = useCallback(
    (next: Theme) => {
      setAppearance(look, next);
    },
    [look, setAppearance],
  );

  return <ThemeContext value={{ theme, setTheme, look, setAppearance }}>{children}</ThemeContext>;
}
