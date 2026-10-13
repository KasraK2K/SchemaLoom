'use client';

import { Button } from '@schemaloom/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { orgAdminMessage } from '@/features/org-settings/messages';
import {
  clearChoice,
  getOptions,
  listAbilities,
  listChoices,
  listMyChoices,
  putChoice,
  stepLabel,
  type Ability,
  type Choice,
  type ChoiceTarget,
  type Options,
} from './ai-integrations-api';
import { INPUT, Message, useRun } from './use-run';

interface Pickable {
  readonly id: string;
  readonly name: string;
  readonly models: readonly string[];
}

function AbilityRow({
  target,
  ability,
  choice,
  integrations,
  refresh,
}: {
  readonly target: ChoiceTarget;
  readonly ability: Ability;
  readonly choice: Choice | undefined;
  readonly integrations: readonly Pickable[];
  readonly refresh: () => Promise<unknown>;
}) {
  const [integrationId, setIntegrationId] = useState(choice?.integrationId ?? '');
  const [model, setModel] = useState(choice?.model ?? '');
  const [locked, setLocked] = useState(choice?.locked ?? false);
  const { busy, message, run } = useRun(refresh);
  const models = integrations.find((i) => i.id === integrationId)?.models ?? [];
  const ready = integrationId === '' || model !== '';
  const idBase = `choice-${ability.id}`;

  const save = () => {
    void run(async () => {
      if (integrationId === '') await clearChoice(target, ability.id);
      else await putChoice(target, { ability: ability.id, integrationId, model, locked });
    });
  };

  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-40 text-sm font-medium text-text">{ability.label}</span>
        <select
          aria-label={`${ability.label} integration`}
          className={INPUT}
          value={integrationId}
          onChange={(e) => {
            const next = integrations.find((i) => i.id === e.target.value);
            setIntegrationId(e.target.value);
            setModel(next?.models[0] ?? '');
          }}
        >
          <option value="">— none —</option>
          {integrations.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
        <select
          aria-label={`${ability.label} model`}
          className={INPUT}
          disabled={integrationId === ''}
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
          }}
        >
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          {/* A saved model the integration no longer lists stays visible until replaced. */}
          {model !== '' && !models.includes(model) && <option value={model}>{model}</option>}
        </select>
        {target.kind !== 'me' && (
          <label htmlFor={`${idBase}-lock`} className="flex items-center gap-1 text-xs text-text">
            <input
              id={`${idBase}-lock`}
              type="checkbox"
              checked={locked}
              onChange={(e) => {
                setLocked(e.target.checked);
              }}
            />
            Lock
          </label>
        )}
        <Button type="button" size="sm" disabled={busy || !ready} onClick={save}>
          Save
        </Button>
      </div>
      <Message message={message} />
    </li>
  );
}

/** What the org locked, read-only, on the project page. */
function OrgLocks({ options }: { readonly options: Options }) {
  const locked = options.abilities.filter((a) => a.lock?.scope === 'org');
  if (locked.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {locked.map((a) => (
        <li key={a.id} className="text-sm text-text-muted">
          <span className="font-medium text-text">{a.label}</span>: Locked by the org
          {a.resolved !== null && ` (${a.resolved.model}, ${stepLabel(a.resolved.step)})`}
          {a.lock?.usable === false && ' and currently unavailable'}.
        </li>
      ))}
    </ul>
  );
}

/**
 * Roadmap 24 §5.2 — one row per ability: which integration and model, and (org and project)
 * whether the choice is locked. The project target also shows what the org has locked.
 */
export function AbilityChoices({
  target,
  integrations,
}: {
  readonly target: ChoiceTarget;
  readonly integrations: readonly Pickable[];
}) {
  const queryKey = ['ai-choices', target];
  const queryClient = useQueryClient();
  const abilities = useQuery({ queryKey: ['ai-abilities'], queryFn: listAbilities });
  const choices = useQuery({
    queryKey,
    queryFn: async () =>
      target.kind === 'me' ? (await listMyChoices(target)).choices : listChoices(target),
  });
  const options = useQuery({
    queryKey: ['ai-options', target],
    queryFn: () => getOptions(target.kind === 'project' ? target.projectId : ''),
    enabled: target.kind === 'project',
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey });
  const scopeProject = target.kind === 'org' ? null : target.projectId;
  const failure = abilities.error ?? choices.error;

  return (
    <section
      aria-labelledby="ai-choices"
      className="mb-8 flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <h2 id="ai-choices" className="text-sm font-semibold text-text">
        Model for each feature
      </h2>
      {failure !== null ? (
        <p role="alert" className="text-sm text-danger-text">
          {orgAdminMessage(failure)}
        </p>
      ) : abilities.data === undefined || choices.data === undefined ? (
        <p className="text-sm text-text-subtle">Loading�</p>
      ) : (
        <>
          {options.data !== undefined && <OrgLocks options={options.data} />}
          <ul className="flex flex-col divide-y divide-border">
            {abilities.data.map((a) => {
              const choice = choices.data.find(
                (c) => c.ability === a.id && c.projectId === scopeProject,
              );
              return (
                <AbilityRow
                  // Remount when the saved choice changes so the row's fields follow it.
                  key={`${a.id}:${choice?.integrationId ?? ''}:${choice?.model ?? ''}:${String(choice?.locked ?? false)}`}
                  target={target}
                  ability={a}
                  choice={choice}
                  integrations={integrations}
                  refresh={refresh}
                />
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
