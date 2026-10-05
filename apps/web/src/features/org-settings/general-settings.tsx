'use client';

import { Button, cn } from '@schemaloom/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AppearancePicker } from '@/components/appearance-picker';
import { apiFetch } from '@/lib/api-client';
import type { Look, Theme } from '@/lib/theme';
import { orgAdminMessage } from './messages';
import type { OrgSettings } from './org-settings-api';

/**
 * Settings → General. Appearance for new members (docs/phase17/ORG-DEFAULT.md): the look a
 * new account starts on when it is created through this org. A default, not a lock, and it
 * never changes anyone who already has an account. The API re-checks owner/admin on save.
 */
export function GeneralSettings({
  orgSlug,
  settings,
}: {
  readonly orgSlug: string;
  readonly settings: OrgSettings;
}) {
  const router = useRouter();
  const saved = settings.defaultAppearance;
  const [look, setLook] = useState<Look | null>(
    saved === null ? null : { theme: saved.theme, variant: saved.variant },
  );
  const [mode, setMode] = useState<Theme>(saved?.mode ?? 'system');
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);

  const dirty =
    look?.theme !== saved?.theme ||
    look?.variant !== saved?.variant ||
    (look !== null && mode !== saved?.mode);

  const save = async () => {
    setState('saving');
    setError(null);
    try {
      await apiFetch(`/organizations/${encodeURIComponent(orgSlug)}/settings`, {
        method: 'PATCH',
        body: { defaultAppearance: look === null ? null : { ...look, mode } },
      });
      setState('saved');
      router.refresh();
    } catch (caught) {
      setError(orgAdminMessage(caught));
      setState('idle');
    }
  };

  return (
    <section aria-labelledby="new-member-appearance" className="flex flex-col gap-3">
      <div>
        <h2 id="new-member-appearance" className="text-sm font-semibold text-text">
          Appearance for new members
        </h2>
        <p className="mt-1 text-sm text-text-muted">
          New accounts created through an invitation or single sign-on start on this look. People
          who already have an account keep theirs, and anyone can change their own at any time.
        </p>
      </div>

      {error !== null && (
        <p
          role="alert"
          className="rounded-md border border-danger px-3 py-2 text-sm text-danger-text"
        >
          {error}
        </p>
      )}

      <button
        type="button"
        role="radio"
        aria-checked={look === null}
        onClick={() => {
          setLook(null);
          setState('idle');
        }}
        className={cn(
          'rounded-lg border bg-surface p-3 text-left text-sm',
          look === null ? 'border-accent ring-[3px] ring-accent/20' : 'border-border',
        )}
      >
        <span className="block font-semibold text-text">None</span>
        <span className="block text-xs text-text-subtle">
          New people start on Studio Jade, as they do today.
        </span>
      </button>

      <AppearancePicker
        look={look}
        mode={mode}
        onChange={(nextLook, nextMode) => {
          setLook(nextLook);
          setMode(nextMode);
          setState('idle');
        }}
      />

      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={!dirty || state === 'saving'}
          onClick={() => {
            void save();
          }}
        >
          {state === 'saving' ? 'Saving…' : 'Save'}
        </Button>
        {state === 'saved' && !dirty && (
          <span role="status" className="text-sm text-text-muted">
            Saved
          </span>
        )}
      </div>
    </section>
  );
}
