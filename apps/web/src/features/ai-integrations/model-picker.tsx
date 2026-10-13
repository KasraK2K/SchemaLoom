'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { aiErrorMessage } from '@/features/ai/ai-api';
import { ApiError } from '@/lib/api-client';
import { getOptions, listMyChoices, putChoice, stepLabel } from './ai-integrations-api';

/**
 * Roadmap 24 §5.4 — which model a feature uses for the caller, in the feature itself. A pick is
 * the caller's own choice for this project; the org's and project's defaults stay in settings.
 */
export function ModelPicker({
  projectId,
  orgSlug,
  ability,
}: {
  readonly projectId: string;
  readonly orgSlug: string;
  readonly ability: string;
}) {
  const queryClient = useQueryClient();
  const options = useQuery({
    queryKey: ['ai-options', projectId],
    queryFn: () => getOptions(projectId),
  });
  const [failed, setFailed] = useState(false);
  const entry = options.data?.abilities.find((a) => a.id === ability);
  const empty = entry?.resolved === null && entry.lock === null;
  // Same key as the Account page's per-org list, so the two share one fetch.
  const policy = useQuery({
    queryKey: ['ai-integrations', { kind: 'me' }, 'usable', orgSlug],
    queryFn: () => listMyChoices({ kind: 'me', orgSlug, projectId: null }),
    enabled: empty,
  });
  if (options.data === undefined || entry === undefined) return null;
  if (entry.resolved === null) {
    if (entry.lock !== null)
      return (
        <span className="text-xs text-text-muted">
          Your admin set a model for this that is no longer available.
        </span>
      );
    if (policy.data === undefined) return null;
    return (
      <span className="text-xs text-text-muted">
        {policy.data.personalAllowed ? (
          <>
            No AI model is available here. Add your own key in{' '}
            <Link href="/settings/security" className="underline">
              Account settings
            </Link>
            .
          </>
        ) : (
          'Ask an admin to add an AI integration.'
        )}
      </span>
    );
  }
  const { resolved, lock } = entry;
  const pairs = options.data.integrations.flatMap((i) =>
    i.models.map((model) => ({ integrationId: i.id, name: i.name, model })),
  );
  const current = pairs.findIndex(
    (p) => p.integrationId === resolved.integrationId && p.model === resolved.model,
  );
  const provider = options.data.integrations.find((i) => i.id === resolved.integrationId);
  const choose = (index: number) => {
    const pair = pairs[index];
    if (pair === undefined) return;
    setFailed(false);
    putChoice(
      { kind: 'me', orgSlug, projectId },
      { ability, integrationId: pair.integrationId, model: pair.model, locked: false },
    )
      .then(() => queryClient.invalidateQueries({ queryKey: ['ai-options'] }))
      .catch(() => {
        setFailed(true);
      });
  };

  return (
    <div className="flex flex-col gap-1 text-xs text-text-muted">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          {resolved.model} · {stepLabel(resolved.step)}
        </span>
        {lock !== null ? (
          <span>Set by your admin</span>
        ) : (
          <select
            aria-label="Model"
            className="h-7 rounded-md border border-border bg-surface px-1 text-xs text-text"
            value={current === -1 ? '' : String(current)}
            onChange={(e) => {
              choose(Number(e.target.value));
            }}
          >
            {current === -1 && <option value="">{resolved.model}</option>}
            {pairs.map((p, i) => (
              <option key={`${p.integrationId}:${p.model}`} value={String(i)}>
                {p.name} · {p.model}
              </option>
            ))}
          </select>
        )}
      </div>
      {entry.strictOutput && provider?.capabilities.fallback === false && (
        <span>This model may not follow the strict output format; check the result.</span>
      )}
      {failed && (
        <span role="alert" className="text-danger-text">
          Could not save that choice. Try again.
        </span>
      )}
    </div>
  );
}

/**
 * An AI error as text; "no model" also says where to fix it. The panels don't know the org role,
 * so the link goes to the account page, where anyone can add a key if the org allows it.
 */
export function AiErrorText({ error }: { readonly error: unknown }) {
  return (
    <>
      {aiErrorMessage(error)}
      {error instanceof ApiError && error.code === 'ai_no_model' && (
        <>
          {' '}
          <Link href="/settings/security" className="underline">
            Open your AI settings
          </Link>
        </>
      )}
    </>
  );
}
