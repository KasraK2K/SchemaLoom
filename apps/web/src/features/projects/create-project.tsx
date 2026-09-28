'use client';

import { Button, FilePlus2, Upload } from '@schemaloom/ui';
import { useState } from 'react';
import { z } from 'zod';
import { ApiError, apiFetch } from '@/lib/api-client';
import type { EngineOption, ProjectSummary, WorkspaceSummary } from './projects-api';

const CreatedSchema = z.object({ id: z.string() });

/** Doc 00 Q22: the API imports up to 5 MB inline; anything larger goes through its job. */
const SYNC_IMPORT_MAX_BYTES = 5_000_000;
const POLL_MS = 1_500;
const NEW_WORKSPACE = '__new';
const NEW_PROJECT = '__new';

const JobSchema = z.object({
  state: z.string(),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
});

const ImportedSchema = z.object({
  existing: z.array(z.string()).default([]),
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
export type Imported = z.infer<typeof ImportedSchema>;
type Skipped = Imported['report']['statements'];

/**
 * Up to 5 MB inline; above that the source is queued as `text/plain` and the job polled
 * until BullMQ reports it done. Both paths answer the same `{ report, existing }`.
 */
export async function importInto(projectId: string, source: string): Promise<Imported> {
  const base = `/projects/${encodeURIComponent(projectId)}/import`;
  if (new Blob([source]).size <= SYNC_IMPORT_MAX_BYTES) {
    return ImportedSchema.parse(await apiFetch<unknown>(base, { method: 'POST', body: { source } }));
  }
  const { id } = CreatedSchema.parse(
    await apiFetch<unknown>(`${base}/jobs`, { method: 'POST', text: source }),
  );
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const job = JobSchema.parse(await apiFetch<unknown>(`${base}/jobs/${encodeURIComponent(id)}`));
    if (job.state === 'completed') return ImportedSchema.parse(job.result);
    if (job.state === 'failed') {
      throw new ApiError(422, 'import_failed', job.error ?? 'The import failed.');
    }
  }
}

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
 * which ways in exist. Each card opens the same form; "Import SQL" adds a source field and
 * a target — a new project, or an existing one the import is merged into (additively: the
 * API adds what is missing and leaves existing tables alone).
 *
 * The engine list comes from `GET /engines` (the page fetches it) — no engine id is ever
 * written in `apps/web`. No workspace chosen → the API picks the org's default.
 */
export function NoProjects({
  orgId,
  orgSlug,
  engines,
  workspaces = [],
  canManageWorkspaces = false,
  importTargets = [],
}: {
  orgId: string;
  orgSlug: string;
  engines: readonly EngineOption[];
  workspaces?: readonly WorkspaceSummary[];
  /** Doc 05 §3.2: owner and admin may create workspaces. */
  canManageWorkspaces?: boolean;
  /** Existing projects the caller may edit, offered as import targets. */
  importTargets?: readonly ProjectSummary[];
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [target, setTarget] = useState(NEW_PROJECT);
  const [name, setName] = useState('');
  const [engineId, setEngineId] = useState(engines[0]?.id ?? '');
  const [engineVersion, setEngineVersion] = useState('');
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? '');
  const [workspaceName, setWorkspaceName] = useState('');
  const [source, setSource] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<{
    href: string;
    statements: Skipped;
    existing: readonly string[];
  } | null>(null);

  const engine = engines.find((candidate) => candidate.id === engineId);
  const importFormat = engine?.importFormats[0];
  const canImport = engines.some((candidate) => candidate.importFormats.length > 0);
  const intoExisting = mode === 'import' && target !== NEW_PROJECT;

  if (skipped !== null) {
    return (
      <div className="mt-6 flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-panel">
        <h2 className="text-sm font-medium text-text">
          Imported, with {skipped.statements.length} statement
          {skipped.statements.length === 1 ? '' : 's'} not applied
        </h2>
        {skipped.existing.length > 0 && (
          <p className="text-xs text-text-muted">
            Already in the project, left unchanged: {skipped.existing.join(', ')}
          </p>
        )}
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

  const createProject = async (): Promise<string> => {
    // `POST /projects` admits only the session's ACTIVE org; make this one active first.
    await apiFetch('/auth/switch-org', { method: 'POST', body: { organizationId: orgId } });
    let workspace: string | undefined = workspaceId === '' ? undefined : workspaceId;
    if (workspaceId === NEW_WORKSPACE) {
      workspace = CreatedSchema.parse(
        await apiFetch<unknown>(`/organizations/${encodeURIComponent(orgSlug)}/workspaces`, {
          method: 'POST',
          body: { name: workspaceName },
        }),
      ).id;
      // A retry after a failed create must not mint a second workspace.
      setWorkspaceId(workspace);
    }
    return CreatedSchema.parse(
      await apiFetch<unknown>('/projects', {
        method: 'POST',
        body: { organizationId: orgId, workspaceId: workspace, name, engineId, engineVersion },
      }),
    ).id;
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      // Reused on a retry, so a failed import never leaves a second empty project behind.
      const id = intoExisting ? target : (createdId ?? (await createProject()));
      if (!intoExisting) setCreatedId(id);
      const href = `/${encodeURIComponent(orgSlug)}/p/${encodeURIComponent(id)}`;
      if (mode === 'import') {
        const { report, existing } = await importInto(id, source);
        const notApplied = report.statements.filter((s) => s.status !== 'applied');
        if (notApplied.length > 0 || existing.length > 0) {
          setSkipped({ href, statements: notApplied, existing });
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
      {mode === 'import' && importTargets.length > 0 && (
        <label className="flex flex-col gap-1 text-sm text-text">
          Into
          <select
            value={target}
            disabled={createdId !== null}
            onChange={(e) => {
              setTarget(e.target.value);
            }}
            className={inputClass}
          >
            <option value={NEW_PROJECT}>A new project</option>
            {importTargets.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name} (adds what is missing)
              </option>
            ))}
          </select>
        </label>
      )}
      {!intoExisting && (
        <>
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
          {(workspaces.length > 0 || canManageWorkspaces) && (
            <label className="flex flex-col gap-1 text-sm text-text">
              Workspace
              <select
                value={workspaceId}
                disabled={createdId !== null}
                onChange={(e) => {
                  setWorkspaceId(e.target.value);
                }}
                className={inputClass}
              >
                {workspaces.length === 0 && <option value="">Default</option>}
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
                {canManageWorkspaces && <option value={NEW_WORKSPACE}>New workspace…</option>}
              </select>
            </label>
          )}
          {workspaceId === NEW_WORKSPACE && (
            <label className="flex flex-col gap-1 text-sm text-text">
              Workspace name
              <input
                required
                maxLength={120}
                value={workspaceName}
                onChange={(e) => {
                  setWorkspaceName(e.target.value);
                }}
                className={inputClass}
              />
            </label>
          )}
        </>
      )}
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
          {busy
            ? 'Working…'
            : mode === 'blank'
              ? 'Create project'
              : intoExisting
                ? 'Import'
                : 'Create and import'}
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
