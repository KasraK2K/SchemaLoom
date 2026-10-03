'use client';

import { APPEARANCE_THEME_IDS, type AppearanceTheme } from '@schemaloom/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  cn,
} from '@schemaloom/ui';
import { useEffect, useState, type CSSProperties } from 'react';
import { useTheme } from '@/components/theme-provider';
import { THEME_INFO, variantsOf } from '@/lib/appearance';
import type { Theme } from '@/lib/theme';

const MODES: readonly Theme[] = ['light', 'dark', 'system'];
const MODE_LABEL: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'System' };

/**
 * Pick a theme, its colour and the mode. Nothing changes until Apply, so a look can be
 * tried out in the previews without the app flickering under the dialog.
 */
export function AppearanceDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { look, theme, setAppearance } = useTheme();
  const [draftTheme, setDraftTheme] = useState<AppearanceTheme>(look.theme);
  const [draftVariant, setDraftVariant] = useState(look.variant);
  const [draftMode, setDraftMode] = useState<Theme>(theme);

  // Opening starts from what is applied now, not from the last unapplied draft.
  useEffect(() => {
    if (!open) return;
    setDraftTheme(look.theme);
    setDraftVariant(look.variant);
    setDraftMode(theme);
  }, [open, look, theme]);

  const chooseTheme = (next: AppearanceTheme) => {
    setDraftTheme(next);
    // A theme's own default colour, unless the current one belongs to it.
    if (!variantsOf(next).includes(draftVariant)) setDraftVariant(variantsOf(next)[0] ?? '');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogTitle>Appearance</DialogTitle>
        <DialogDescription>
          A theme changes the layout, density and type, not only the colour. Your choice follows
          your account.
        </DialogDescription>

        <div
          role="radiogroup"
          aria-label="Theme"
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        >
          {APPEARANCE_THEME_IDS.map((id) => {
            const info = THEME_INFO[id];
            const chosen = draftTheme === id;
            return (
              <div
                key={id}
                className={cn(
                  'flex flex-col gap-2 rounded-lg border bg-surface p-2 transition-shadow',
                  chosen ? 'border-accent ring-[3px] ring-accent/20' : 'border-border',
                )}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={chosen}
                  aria-label={info.label}
                  onClick={() => {
                    chooseTheme(id);
                  }}
                  className="flex flex-col gap-2 rounded-md text-left"
                >
                  <ThemePreview
                    theme={id}
                    accent={
                      info.variants[chosen ? draftVariant : (variantsOf(id)[0] ?? '')]?.swatch
                    }
                  />
                  <span>
                    <span className="block text-sm font-semibold text-text">{info.label}</span>
                    <span className="block text-xs text-text-subtle">{info.summary}</span>
                  </span>
                </button>
                <div role="radiogroup" aria-label={`${info.label} colour`} className="flex gap-1.5">
                  {variantsOf(id).map((variant) => {
                    const v = info.variants[variant];
                    const on = chosen && draftVariant === variant;
                    return (
                      <button
                        key={variant}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        aria-label={v?.label ?? variant}
                        title={v?.label ?? variant}
                        onClick={() => {
                          setDraftTheme(id);
                          setDraftVariant(variant);
                        }}
                        style={{ backgroundColor: v?.swatch }}
                        className={cn(
                          'size-5 rounded-full border-2 border-surface transition-shadow',
                          on
                            ? 'shadow-[0_0_0_2px_var(--color-text)]'
                            : 'shadow-[0_0_0_1px_var(--color-border-strong)]',
                        )}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-sm text-text-muted">Mode</span>
          <div
            role="radiogroup"
            aria-label="Mode"
            className="inline-flex rounded-lg border border-border bg-surface-sunken p-0.5"
          >
            {MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={draftMode === mode}
                onClick={() => {
                  setDraftMode(mode);
                }}
                className={cn(
                  'rounded-md px-3 py-1 text-sm font-medium transition-colors',
                  draftMode === mode
                    ? 'bg-surface-raised text-text shadow-panel'
                    : 'text-text-muted hover:text-text',
                )}
              >
                {MODE_LABEL[mode]}
              </button>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setAppearance({ theme: draftTheme, variant: draftVariant }, draftMode);
              onOpenChange(false);
            }}
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A small drawing of each theme's layout: where its panels sit and how its tables look.
 * Fixed dark colours on purpose, so the four read as the same kind of picture whatever
 * theme the dialog itself is drawn in. Decorative: the label beside it names the theme.
 */
function ThemePreview({
  theme,
  accent,
}: {
  readonly theme: AppearanceTheme;
  readonly accent?: string;
}) {
  const a = accent ?? '#29a383';
  const box = (style: CSSProperties) => (
    <span aria-hidden="true" className="absolute" style={style} />
  );
  const frame = 'relative h-20 overflow-hidden rounded-md';
  if (theme === 'blueprint') {
    return (
      <span
        className={frame}
        style={{
          background:
            '#0b1a2e linear-gradient(rgb(120 170 230 / .14) 1px, transparent 1px) 0 0 / 10px 10px, #0b1a2e linear-gradient(90deg, rgb(120 170 230 / .14) 1px, transparent 1px) 0 0 / 10px 10px',
        }}
      >
        {box({ left: 10, top: 12, width: 44, height: 28, border: '1px solid #3a6597' })}
        {box({ left: 64, top: 36, width: 44, height: 32, border: `1px solid ${a}` })}
        {box({
          right: 0,
          top: 0,
          bottom: 0,
          width: 30,
          background: '#0e2038',
          borderLeft: '1px solid #22426a',
        })}
      </span>
    );
  }
  if (theme === 'float') {
    return (
      <span
        className={frame}
        style={{
          background:
            '#0f1216 radial-gradient(rgb(255 255 255 / .08) 1px, transparent 1px) 0 0 / 9px 9px',
        }}
      >
        {box({
          left: 5,
          top: 5,
          right: 5,
          height: 11,
          borderRadius: 6,
          background: 'rgb(255 255 255 / .09)',
        })}
        {box({
          left: 5,
          top: 22,
          width: 12,
          height: 34,
          borderRadius: 5,
          background: 'rgb(255 255 255 / .07)',
        })}
        {box({
          left: 26,
          top: 30,
          width: 40,
          height: 28,
          borderRadius: 8,
          background: '#1a1f26',
          border: `1px solid ${a}`,
        })}
        {box({
          right: 5,
          top: 22,
          bottom: 5,
          width: 30,
          borderRadius: 7,
          background: 'rgb(255 255 255 / .08)',
        })}
      </span>
    );
  }
  if (theme === 'compact') {
    return (
      <span className={frame} style={{ background: '#0b0c0d' }}>
        {box({
          left: 0,
          top: 0,
          bottom: 0,
          width: 10,
          background: '#0f1112',
          borderRight: '1px solid #23272a',
        })}
        {box({ left: 16, top: 8, width: 36, height: 34, border: '1px solid #3a4045' })}
        {box({ left: 58, top: 8, width: 36, height: 42, border: `1px solid ${a}` })}
        {box({ left: 16, top: 48, width: 36, height: 24, border: '1px solid #3a4045' })}
        {box({
          right: 0,
          top: 0,
          bottom: 0,
          width: 26,
          background: '#0f1112',
          borderLeft: '1px solid #23272a',
        })}
      </span>
    );
  }
  return (
    <span
      className={frame}
      style={{ background: '#0c0e0d radial-gradient(#2a2f2d 1px, transparent 1px) 0 0 / 8px 8px' }}
    >
      {box({
        left: 0,
        top: 0,
        bottom: 0,
        width: 16,
        background: '#101211',
        borderRight: '1px solid #2e3130',
      })}
      {box({
        left: 24,
        top: 12,
        width: 40,
        height: 28,
        borderRadius: 5,
        background: '#171918',
        border: '1px solid #444947',
      })}
      {box({
        left: 72,
        top: 38,
        width: 40,
        height: 30,
        borderRadius: 5,
        background: '#171918',
        border: `1px solid ${a}`,
      })}
      {box({
        right: 0,
        top: 0,
        bottom: 0,
        width: 30,
        background: '#101211',
        borderLeft: '1px solid #2e3130',
      })}
    </span>
  );
}
