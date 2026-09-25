'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { applyTheme, readStoredTheme, THEME_STORAGE_KEY, type Theme } from '@/lib/theme';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) throw new Error('useTheme must be used inside <ThemeProvider>');
  return value;
}

/**
 * State only. The <html> class is already correct before this mounts — the inline
 * script in layout.tsx set it — so the first effect here is a read, not a paint.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  // 'system' on both server and first client render; the real value is adopted in the
  // effect below. Reading localStorage during render would desync SSR and hydration.
  const [theme, setThemeState] = useState<Theme>('system');

  useEffect(() => {
    setThemeState(readStoredTheme());
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

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    applyTheme(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Blocked storage: the choice still applies to this tab, it just will not stick.
    }
  }, []);

  return <ThemeContext value={{ theme, setTheme }}>{children}</ThemeContext>;
}
