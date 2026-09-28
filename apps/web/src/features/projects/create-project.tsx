'use client';

import { Button, FilePlus2, Upload } from '@schemaloom/ui';
import { useState } from 'react';
import { z } from 'zod';
import { ApiError, apiFetch } from '@/lib/api-client';
import type { EngineOption } from './projects-api';

const CreatedSchema = z.object({ id: z.string() });

const ImportedSchema = z.object({
  report: z.object({
    statementCount: z.number(),
    statements: z.array(
      z.object({
        ordinal: z.number(),
        excerpt: z.string(),
        status: z.string(),
        reason: z.string().nullable(),
      }),
    ),
  }),
});
type Skipped = z.infer<typeof ImportedSchema>['report']['statements'];

const STARTING_POINTS = [
  {
    mode: 'blank',
    icon: FilePlus2,
    title: 'Start blank',
    body: 'An empty canvas. Drop a first table and grow the schema by hand.',
    action: 'New project',
  },
  {
    mode: 'import',
    icon: Upload,
    title: 'Import SQL',
    body: 'Paste a dump or a migration file and start from the schema you already run.',
    action: 'Import',
  },
] as const;

type Mode = (typeof STARTING_POINTS)[number]['mode'];

const inputClass = 'rounded-md border border-border bg-surface px-3 py-2 text-sm text-text';

/**
 * A teaching empty state, not a placeholder: "No projects" tells a new user nothing about
 * which ways in exist. Each card opens the same form; "Import SQL" adds a source field and,
 * after the project is created, posts it to `/projects/:id/import`.
 *
 * The engine list comes from `GET /engines` (the page fetches it) — no engine id is ever
 * written in `apps/web`. The workspace is left to the API, which picks the org's default.
 */
export function NoProjects({
  orgId,
  orgSlug,
  engines,
}: {
  orgId: string;
  orgSlug: string;
  engines: readonly EngineOption[];
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [name, setName] = useState('');
  const [engineId, setEngineId] = useState(engines[0]?.id ?? '');
  const [engineVersion, setEngineVersion] = useState('');
  const [source, setSource] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<{ href: string; statements: Skipped } | null>(null);

  const engine = engines.find((candidate) => candidate.id === engineId);
  const importFormat = engine?.importFormats[0];
  const canImport = engines.some((candidate) => candidate.importFormats.length > 0);

  if (skipped !== null) {
    return (
      <div className="mt-6 flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-panel">
        <h2 className="text-sm font-medium text-text">
          Imported, with {skipped.statements.length} statement
          {skipped.statements.length === 1 ? '' : 's'} not applied
        </h2>
        <ul className="flex max-h-64 flex-col gap-2 overflow-auto text-xs">
          {skipped.statements.map((statement) => (
            <li key={statement.ordinal}>
              <code className="block truncate text-text">{statement.excerpt}</code>
              <span className="text-text-muted">
                {statement.status}: {statement.reason}
              </span>
            </li>
          ))}
        </ul>
        <Button
          variant="primary"
          size="sm"
          className="self-start"
          onClick={() => {
            window.location.assign(skipped.href);
          }}
        >
          Open project
        </Button>
      </div>
    );
  }

  if (mode === null) {
    return (
      <ul className="mt-6 grid gap-3 sm:grid-cols-2">
        {STARTING_POINTS.map((point) => (
          <li
            key={point.title}
            className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 shadow-panel"
          >
            <point.icon className="size-5 text-accent-text" aria-hidden="true" />
            <h2 className="text-sm font-medium text-text">{point.title}</h2>
            <p className="text-sm text-text-muted">{point.body}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-auto self-start"
              disabled={engines.length === 0 || (point.mode === 'import' && !canImport)}
              onClick={() => {
                setMode(point.mode);
                if (point.mode === 'import' && importFormat === undefined) {
                  setEngineId(engines.find((c) => c.importFormats.length > 0)?.id ?? engineId);
                }
              }}
            >
              {point.action}
            </Button>
          </li>
        ))}
      </ul>
    );
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      // Reused on a retry, so a failed import never leaves a second empty project behind.
      const id =
        createdId ??
        CreatedSchema.parse(
          await apiFetch<unknown>('/projects', {
            method: 'POST',
            body: { organizationId: orgId, name, engineId, engineVersion },
          }),
        ).id;
      setCreatedId(id);
      const href = `/${encodeURIComponent(orgSlug)}/p/${encodeURIComponent(id)}`;
      if (mode === 'import') {
        const { report } = ImportedSchema.parse(
          await apiFetch<unknown>(`/projects/${encodeURIComponent(id)}/import`, {
            method: 'POST',
            body: { source },
          }),
        );
        const notApplied = report.statements.filter((s) => s.status !== 'applied');
        if (notApplied.length > 0) {
          setSkipped({ href, statements: notApplied });
          return;
        }
      }
      window.location.assign(href);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  };

  return (
    <form
      className="mt-6 flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-panel"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2 className="text-sm font-medium text-text">
        {mode === 'blank' ? 'New project' : 'Import SQL'}
      </h2>
      <label className="flex flex-col gap-1 text-sm text-text">
        Name
        <input
          autoFocus
          required
          disabled={createdId !== null}
          maxLength={200}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
          className={inputClass}
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-1 flex-col gap-1 text-sm text-text">
          Engine
          <select
            value={engineId}
            onChange={(e) => {
              setEngineId(e.target.value);
            }}
            className={inputClass}
          >
            {engines
              .filter((candidate) => mode === 'blank' || candidate.importFormats.length > 0)
              .map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.displayName}
                </option>
              ))}
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm text-text">
          Target version
          <input
            required
            maxLength={32}
            value={engineVersion}
            onChange={(e) => {
              setEngineVersion(e.target.value);
            }}
            className={inputClass}
          />
        </label>
      </div>
      {mode === 'import' && (
        <>
          <label className="flex flex-col gap-1 text-sm text-text">
            SQL
            <textarea
              required
              rows={10}
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
              }}
              className={`${inputClass} font-mono text-xs`}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-muted">
            …or choose a file
            <input
              type="file"
              accept={importFormat?.fileExtensions.join(',')}
              onChange={(e) => {
                void e.target.files?.[0]?.text().then(setSource);
              }}
            />
          </label>
        </>
      )}
      {createdId !== null && (
        <p className="text-xs text-text-muted">
          The project exists; submitting again retries only the import.
        </p>
      )}
      {error !== null && (
        <p role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={busy}>
          {busy ? 'Working…' : mode === 'blank' ? 'Create project' : 'Create and import'}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || createdId !== null}
          onClick={() => {
            setMode(null);
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
