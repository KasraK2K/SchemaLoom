'use client';

import { Button } from '@schemaloom/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '@/lib/api-client';
import { orgAdminMessage } from '@/features/org-settings/messages';
import { AI_PROVIDER_IDS, providerLabel } from './ai-integrations-api';
import { Message, useRun } from './use-run';

/** The `ai` block of `GET /organizations/:slug/settings`; the full schema lives in a server-only module. */
const PolicySchema = z.object({
  ai: z.object({ allowPersonalIntegrations: z.boolean(), personalProviders: z.array(z.string()) }),
});

/**
 * Roadmap 24 §5.1 — whether members may bring their own AI keys, and which providers. The
 * PATCH replaces the whole `ai` object, so both fields go every time.
 */
export function PersonalPolicy({ orgSlug }: { readonly orgSlug: string }) {
  const headingId = useId();
  const path = `/organizations/${encodeURIComponent(orgSlug)}/settings`;
  const queryKey = ['org-settings', orgSlug];
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey,
    queryFn: async () => PolicySchema.parse(await apiFetch<unknown>(path)),
  });
  const { busy, message, setMessage, run } = useRun(() =>
    queryClient.invalidateQueries({ queryKey }),
  );
  const [allow, setAllow] = useState(false);
  const [providers, setProviders] = useState<string[]>([]);
  const saved = settings.data?.ai;
  useEffect(() => {
    if (saved === undefined) return;
    setAllow(saved.allowPersonalIntegrations);
    setProviders(saved.personalProviders);
  }, [saved]);

  const save = () => {
    void run(async () => {
      await apiFetch(path, {
        method: 'PATCH',
        body: { ai: { allowPersonalIntegrations: allow, personalProviders: providers } },
      });
      setMessage({ text: 'Saved.', error: false });
    });
  };

  return (
    <section
      aria-labelledby={headingId}
      className="mb-8 flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <h2 id={headingId} className="text-sm font-semibold text-text">
        Personal AI keys
      </h2>
      {settings.isPending ? (
        <p className="text-sm text-text-subtle">Loading…</p>
      ) : settings.isError ? (
        <p role="alert" className="text-sm text-danger-text">
          {orgAdminMessage(settings.error)}
        </p>
      ) : (
        <>
          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={allow}
              onChange={(e) => {
                setAllow(e.target.checked);
              }}
            />
            Allow members to use their own AI keys in this organisation
          </label>
          <fieldset disabled={!allow} className="flex flex-col gap-1">
            <legend className="mb-1 text-xs text-text-muted">
              Providers they may use. With none ticked, any provider is allowed.
            </legend>
            {AI_PROVIDER_IDS.map((p) => (
              <label key={p} className="flex items-center gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  checked={providers.includes(p)}
                  onChange={(e) => {
                    setProviders(
                      e.target.checked ? [...providers, p] : providers.filter((x) => x !== p),
                    );
                  }}
                />
                {providerLabel(p)}
              </label>
            ))}
            {providers.length === 0 && (
              <span className="text-xs text-text-muted">Any provider</span>
            )}
          </fieldset>
          <div>
            <Button type="button" size="sm" disabled={busy} onClick={save}>
              Save
            </Button>
          </div>
          <Message message={message} />
        </>
      )}
    </section>
  );
}
