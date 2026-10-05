'use client';

import { APPEARANCE_THEME_IDS, type AppearanceTheme } from '@schemaloom/contracts';
import { cn } from '@schemaloom/ui';
import type { CSSProperties } from 'react';
import { THEME_INFO, variantsOf } from '@/lib/appearance';
import type { Look, Theme } from '@/lib/theme';

const MODES: readonly Theme[] = ['light', 'dark', 'system'];
const MODE_LABEL: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'System' };

/**
 * The theme cards, their colour swatches and the mode switch. Controlled: the personal
 * Appearance panel applies a click at once, the org default (Settings → General) holds it
 * until Save. `look` is null when nothing is chosen, so no card is marked.
 */
export function AppearancePicker({
  look,
  mode,
  onChange,
}: {
  readonly look: Look | null;
  readonly mode: Theme;
  readonly onChange: (look: Look, mode: Theme) => void;
}) {
  // A theme's own default colour, unless the current one belongs to it.
  const lookOf = (id: AppearanceTheme): Look => ({
    theme: id,
    variant: look?.theme === id ? look.variant : (variantsOf(id)[0] ?? ''),
  });
  const current = look ?? lookOf('studio');

  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label="Theme" className="flex flex-col gap-2">
        {APPEARANCE_THEME_IDS.map((id) => {
          const info = THEME_INFO[id];
          const chosen = look?.theme === id;
          return (
            <div
              key={id}
              className={cn(
                'flex gap-3 rounded-lg border bg-surface p-2 transition-shadow',
                chosen ? 'border-accent ring-[3px] ring-accent/20' : 'border-border',
              )}
            >
              <button
                type="button"
                role="radio"
                aria-checked={chosen}
                aria-label={info.label}
                onClick={() => {
                  onChange(lookOf(id), mode);
                }}
                className="flex min-w-0 flex-1 gap-3 rounded-md text-left"
              >
                <ThemePreview theme={id} accent={info.variants[lookOf(id).variant]?.swatch} />
                <span className="min-w-0 pt-0.5">
                  <span className="block text-sm font-semibold text-text">{info.label}</span>
                  <span className="block text-xs text-text-subtle">{info.summary}</span>
                </span>
              </button>
              <div
                role="radiogroup"
                aria-label={`${info.label} colour`}
                className="flex flex-col justify-center gap-1.5"
              >
                {variantsOf(id).map((variant) => {
                  const v = info.variants[variant];
                  const on = chosen && current.variant === variant;
                  return (
                    <button
                      key={variant}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      aria-label={v?.label ?? variant}
                      title={v?.label ?? variant}
                      onClick={() => {
                        onChange({ theme: id, variant }, mode);
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
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => {
                onChange(current, m);
              }}
              className={cn(
                'rounded-md px-3 py-1 text-sm font-medium transition-colors',
                mode === m
                  ? 'bg-surface-raised text-text shadow-panel'
                  : 'text-text-muted hover:text-text',
              )}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * A small drawing of each theme: where its panels sit, how its tables and lines look.
 * Fixed dark colours on purpose, so the four read as the same kind of picture whatever
 * theme the panel itself is drawn in. Decorative: the label beside it names the theme.
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
  const frame = 'relative h-20 w-28 shrink-0 overflow-hidden rounded-md';
  if (theme === 'blueprint') {
    // Outline-only tables, a right-angled link, a major/minor ruled grid.
    const minor = 'rgb(120 170 230 / .12)';
    const major = 'rgb(120 170 230 / .3)';
    return (
      <span
        className={frame}
        style={{
          background: `linear-gradient(${major} 1px, transparent 1px) 0 0 / 40px 40px, linear-gradient(90deg, ${major} 1px, transparent 1px) 0 0 / 40px 40px, linear-gradient(${minor} 1px, transparent 1px) 0 0 / 8px 8px, linear-gradient(90deg, ${minor} 1px, transparent 1px) 0 0 / 8px 8px, #0b1a2e`,
        }}
      >
        {box({ left: 8, top: 10, width: 34, height: 26, border: '1px solid #8db4e2' })}
        {box({ left: 8, top: 16, width: 34, height: 1, background: '#8db4e2' })}
        {box({ left: 42, top: 24, width: 14, height: 1, background: a })}
        {box({ left: 56, top: 24, width: 1, height: 24, background: a })}
        {box({ left: 56, top: 48, width: 10, height: 1, background: a })}
        {box({ left: 66, top: 38, width: 34, height: 30, border: `1px solid ${a}` })}
        {box({ left: 66, top: 44, width: 34, height: 1, background: a })}
      </span>
    );
  }
  if (theme === 'float') {
    // Glass panels over a soft gradient: pill top bar, round dock, rounded cards.
    return (
      <span
        className={frame}
        style={{
          background: `radial-gradient(circle at 20% 15%, ${a}55, transparent 55%), radial-gradient(circle at 90% 95%, ${a}33, transparent 50%), #10141a`,
        }}
      >
        {box({
          left: 5,
          top: 5,
          right: 5,
          height: 10,
          borderRadius: 999,
          background: 'rgb(255 255 255 / .12)',
        })}
        {box({
          left: 5,
          top: 21,
          width: 10,
          height: 10,
          borderRadius: 999,
          background: 'rgb(255 255 255 / .12)',
        })}
        {box({
          left: 24,
          top: 28,
          width: 40,
          height: 32,
          borderRadius: 9,
          background: '#1c222b',
          boxShadow: '0 6px 14px rgb(0 0 0 / .5)',
          overflow: 'hidden',
          borderTop: `9px solid ${a}66`,
        })}
        {box({
          right: 5,
          top: 21,
          bottom: 5,
          width: 30,
          borderRadius: 9,
          background: 'rgb(255 255 255 / .1)',
        })}
      </span>
    );
  }
  if (theme === 'compact') {
    // Dense striped tables, straight links, thin chrome.
    const rows = (left: number, top: number, count: number, edge: string) => (
      <>
        {box({ left, top, width: 32, height: count * 5 + 5, border: `1px solid ${edge}` })}
        {Array.from({ length: count }, (_, i) =>
          i % 2 === 1 ? (
            <span
              key={i}
              aria-hidden="true"
              className="absolute"
              style={{
                left: left + 1,
                top: top + 5 + i * 5,
                width: 30,
                height: 5,
                background: '#1a1d1f',
              }}
            />
          ) : null,
        )}
      </>
    );
    return (
      <span className={frame} style={{ background: '#0b0c0d' }}>
        {box({ left: 0, top: 0, right: 0, height: 6, borderBottom: '1px solid #23272a' })}
        {box({ left: 0, top: 6, bottom: 0, width: 8, borderRight: '1px solid #23272a' })}
        {rows(14, 12, 8, '#3a4045')}
        {box({
          left: 46,
          top: 30,
          width: 20,
          height: 1,
          background: a,
          transform: 'rotate(12deg)',
          transformOrigin: 'left',
        })}
        {rows(66, 30, 7, a)}
        {box({ right: 0, top: 6, bottom: 0, width: 8, borderLeft: '1px solid #23272a' })}
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
        width: 14,
        background: '#101211',
        borderRight: '1px solid #2e3130',
      })}
      {box({
        left: 20,
        top: 12,
        width: 34,
        height: 26,
        borderRadius: 5,
        background: '#171918',
        border: '1px solid #444947',
      })}
      {box({
        left: 52,
        top: 38,
        width: 34,
        height: 30,
        borderRadius: 5,
        background: '#171918',
        border: `1px solid ${a}`,
      })}
      {box({
        right: 0,
        top: 0,
        bottom: 0,
        width: 22,
        background: '#101211',
        borderLeft: '1px solid #2e3130',
      })}
    </span>
  );
}
