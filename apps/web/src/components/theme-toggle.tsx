'use client';

import { Button, Monitor, Moon, Sun, type LucideIcon } from '@schemaloom/ui';
import { useState } from 'react';
import { AppearanceDialog } from '@/components/appearance-dialog';
import { useTheme } from '@/components/theme-provider';
import type { Theme } from '@/lib/theme';

const ICONS: Record<Theme, LucideIcon> = { system: Monitor, light: Sun, dark: Moon };
const LABELS: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };

/**
 * The top bar's appearance button. Its icon shows the current mode; it opens the
 * Appearance dialog, where the mode sits next to the theme and its colour.
 */
export function ThemeToggle() {
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);
  const CurrentIcon = ICONS[theme];

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Appearance"
        title={`Appearance (${LABELS[theme]})`}
        onClick={() => {
          setOpen(true);
        }}
      >
        <CurrentIcon className="size-4" aria-hidden="true" />
      </Button>
      <AppearanceDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
