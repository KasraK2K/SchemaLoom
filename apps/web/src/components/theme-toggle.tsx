'use client';

import {
  Button,
  Check,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Monitor,
  Moon,
  Sun,
  type LucideIcon,
} from '@schemaloom/ui';
import { useTheme } from '@/components/theme-provider';
import { THEMES, type Theme } from '@/lib/theme';

const ICONS: Record<Theme, LucideIcon> = { system: Monitor, light: Sun, dark: Moon };
const LABELS: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const CurrentIcon = ICONS[theme];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Theme: ${LABELS[theme]}`}>
          <CurrentIcon className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {THEMES.map((option) => {
          const Icon = ICONS[option];
          return (
            <DropdownMenuItem
              key={option}
              onSelect={() => {
                setTheme(option);
              }}
            >
              <Icon className="size-4" aria-hidden="true" />
              {LABELS[option]}
              {option === theme && <Check className="ml-auto size-3.5" aria-hidden="true" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
