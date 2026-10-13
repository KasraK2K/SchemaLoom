'use client';

import { Button } from '@schemaloom/ui';
import { useState, type SyntheticEvent } from 'react';
import {
  AI_PROVIDER_IDS,
  createIntegration,
  modelsFound,
  providerLabel,
  testIntegration,
  updateIntegration,
  type Integration,
  type IntegrationBase,
} from './ai-integrations-api';
import { INPUT, Message, useRun } from './use-run';

/**
 * Add or edit one integration. Fetching the provider's model list needs a saved row (the
 * server holds the key), so a new integration starts from hand-typed model ids.
 */
export function IntegrationForm({
  base,
  existing,
  onDone,
  onSaved,
}: {
  readonly base: IntegrationBase;
  readonly existing: Integration | null;
  readonly onDone: () => void;
  readonly onSaved: () => Promise<unknown>;
}) {
  const [provider, setProvider] = useState<string>(existing?.provider ?? AI_PROVIDER_IDS[0]);
  const [name, setName] = useState(existing?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<string[]>(existing?.models ?? []);
  const [offered, setOffered] = useState<string[]>(existing?.models ?? []);
  const [typed, setTyped] = useState('');
  const { busy, message, setMessage, run } = useRun(onSaved);
  const compatible = provider === 'openai_compatible';
  const hasKey = existing?.keyHint != null;

  const addTyped = () => {
    const id = typed.trim();
    if (id === '') return;
    if (!offered.includes(id)) setOffered([...offered, id]);
    if (!models.includes(id)) setModels([...models, id]);
    setTyped('');
  };

  const onSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    const key = apiKey.trim();
    const common = {
      name: name.trim(),
      ...(compatible ? { baseUrl: baseUrl.trim() } : {}),
      ...(key === '' ? {} : { apiKey: key }),
      models,
    };
    void run(async () => {
      if (existing === null) await createIntegration(base, { provider, ...common });
      else await updateIntegration(base, existing.id, common);
    }).then((ok) => {
      if (ok) onDone();
    });
  };

  const fetchModels = () => {
    if (existing === null) return;
    void run(async () => {
      const result = await testIntegration(base, existing.id);
      setOffered([...new Set([...result.fetchedModels, ...models])]);
      setMessage(
        result.status === 'ok'
          ? {
              text: `Connected. ${modelsFound(result.fetchedModels.length)}.`,
              error: false,
            }
          : { text: `The test failed: ${result.lastError ?? 'unknown error'}.`, error: true },
      );
    });
  };

  const hintId = `test-hint-${existing?.id ?? 'new'}`;
  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-border p-3"
      onSubmit={onSubmit}
      aria-label={existing === null ? 'Add integration' : `Edit ${existing.name}`}
    >
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Provider"
          className={`${INPUT} flex-[1_1_10rem]`}
          value={provider}
          disabled={existing !== null}
          onChange={(e) => {
            setProvider(e.target.value);
          }}
        >
          {AI_PROVIDER_IDS.map((p) => (
            <option key={p} value={p}>
              {providerLabel(p)}
            </option>
          ))}
        </select>
        <input
          required
          maxLength={100}
          aria-label="Name"
          placeholder="Name"
          className={`${INPUT} min-w-0 flex-[2_1_12rem]`}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
      </div>
      {compatible && (
        <input
          required
          type="url"
          maxLength={2000}
          aria-label="Base URL"
          placeholder="https://host.example/v1"
          className={`${INPUT} min-w-0`}
          value={baseUrl}
          onChange={(e) => {
            setBaseUrl(e.target.value);
          }}
        />
      )}
      <input
        type="password"
        required={existing === null && !compatible}
        maxLength={4000}
        autoComplete="off"
        aria-label="API key"
        placeholder={
          hasKey ? `•••• ${existing.keyHint ?? ''}` : compatible ? 'API key (optional)' : 'API key'
        }
        className={`${INPUT} min-w-0`}
        value={apiKey}
        onChange={(e) => {
          setApiKey(e.target.value);
        }}
      />
      {hasKey && (
        <p className="text-xs text-text-muted">Leave the key blank to keep the saved one.</p>
      )}

      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs font-medium text-text">Models people may use</legend>
        {offered.length === 0 ? (
          <p className="text-xs text-text-muted">
            Add at least one model id, save, then Test to fetch the full list.
          </p>
        ) : (
          offered.map((m) => (
            <label key={m} className="flex items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={models.includes(m)}
                onChange={(e) => {
                  setModels(e.target.checked ? [...models, m] : models.filter((x) => x !== m));
                }}
              />
              <span className="font-mono text-xs">{m}</span>
            </label>
          ))
        )}
        <div className="flex gap-2">
          <input
            maxLength={200}
            aria-label="Model id"
            placeholder="Model id"
            className={`${INPUT} min-w-0 flex-1 font-mono`}
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTyped();
              }
            }}
          />
          <Button type="button" size="sm" variant="outline" onClick={addTyped}>
            Add model id
          </Button>
        </div>
      </fieldset>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy || models.length === 0}>
          {existing === null ? 'Save integration' : 'Save'}
        </Button>
        {existing !== null && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={fetchModels}
            aria-describedby={hintId}
          >
            Test &amp; fetch models
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <p id={hintId} className="text-xs text-text-muted">
        {existing === null
          ? 'Test & fetch models appears once the integration is saved.'
          : 'Test checks the key and lists the provider’s models. Save to keep your selection.'}
      </p>
      <Message message={message} />
    </form>
  );
}
