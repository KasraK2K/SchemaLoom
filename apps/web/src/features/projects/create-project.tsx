'use client';

import { Button, Database, FilePlus2, LayoutGrid, Sparkles, Upload } from '@schemaloom/ui';
import { useState } from 'react';
import { z } from 'zod';
import { aiErrorMessage, draftSchema } from '@/features/ai/ai-api';
import { ApiError, apiFetch } from '@/lib/api-client';
import {
  ConnectionForm,
  connectionPayload,
  initialDraft,
  readsDatabase,
  type ConnectionDraft,
} from './connection-form';
import type {
  EngineOption,
  ProjectSummary,
  TemplateOption,
  WorkspaceSummary,
} from './projects-api';
import { saveConnection, type ConnectionSource } from './saved-connection';

const CreatedSchema = z.object({ id: z.string() });

/** Doc 00 Q22: the API imports up to 5 MB inline; anything larger goes through its job. */
const SYNC_IMPORT_MAX_BYTES = 5_000_000;
const POLL_MS = 1_500;
/** Ten minutes: an import still queued by then is stuck (worker gone), not slow. */
const POLL_LIMIT = 400;
const NEW_WORKSPACE = '__new';
const NEW_PROJECT = '__new';
/** The draft-schema route's own limit (`draftSchemaSchema`). */
const DESCRIPTION_MAX = 10_000;

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
/**
 * Phase 7b — `prisma` when the source is a Prisma schema and the engine reads one, else
 * undefined (the engine's first format, SQL). A Prisma file starts its blocks with
 * `datasource`, `generator` or `model`, which no SQL statement does.
 */
export function detectImportFormat(
  source: string,
  formats: readonly { readonly id: string }[],
): string | undefined {
  if (!formats.some((f) => f.id === 'prisma')) return undefined;
  return /^\s*(datasource|generator|model)\s+\w+\s*\{/m.test(source) ? 'prisma' : undefined;
}

/** What an import accepts, for labels: "SQL or Prisma" when the engine reads Prisma. */
export function importSourceName(formats: readonly { readonly id: string }[]): string {
  return formats.some((f) => f.id === 'prisma') ? 'SQL or Prisma' : 'SQL';
}

export async function importInto(
  projectId: string,
  source: string,
  renames: readonly ConfirmedRename[] = [],
  format?: string,
): Promise<Imported> {
  const base = `/projects/${encodeURIComponent(projectId)}/import`;
  // The queued path takes SQL only; a Prisma schema is never near its size.
  if (format !== undefined || new Blob([source]).size <= SYNC_IMPORT_MAX_BYTES) {
    return ImportedSchema.parse(
      await apiFetch<unknown>(base, {
        method: 'POST',
        body: { source, renames, ...(format === undefined ? {} : { format }) },
      }),
    );
  }
  // The queued body is the raw SQL, so confirmed renames ride as a query parameter.
  const query =
    renames.length === 0 ? '' : `?renames=${encodeURIComponent(JSON.stringify(renames))}`;
  const { id } = CreatedSchema.parse(
    await apiFetch<unknown>(`${base}/jobs${query}`, { method: 'POST', text: source }),
  );
  return pollImportJob(projectId, id);
}

/** Polls the import job until BullMQ reports it done. */
async function pollImportJob(projectId: string, id: string): Promise<Imported> {
  const path = `/projects/${encodeURIComponent(projectId)}/import/jobs/${encodeURIComponent(id)}`;
  for (let i = 0; i < POLL_LIMIT; i++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const job = JobSchema.parse(await apiFetch<unknown>(path));
    if (job.state === 'completed') return ImportedSchema.parse(job.result);
    if (job.state === 'failed') {
      throw new ApiError(422, 'import_failed', job.error ?? 'The import failed.');
    }
  }
  throw new ApiError(504, 'import_timeout', 'The import is taking too long. Try again later.');
}

const IntrospectedSchema = z.object({
  preview: z.lazy(() => PreviewSchema),
  sourceId: z.string(),
  serverVersion: z.string(),
  sshHostKey: z.string().optional(),
});
export type Introspected = z.infer<typeof IntrospectedSchema>;

/**
 * Phase 6 §4 — read a live database and preview importing it. The dump stays on the server
 * under `sourceId`; `importIntrospected` then queues the ordinary import job with it.
 */
export async function introspectPreview(
  projectId: string,
  source: ConnectionSource,
): Promise<Introspected> {
  const base = `/projects/${encodeURIComponent(projectId)}/introspect`;
  return IntrospectedSchema.parse(
    'upload' in source
      ? await apiFetch<unknown>(`${base}/upload/preview`, { method: 'POST', file: source.upload })
      : await apiFetch<unknown>(`${base}/preview`, { method: 'POST', body: source }),
  );
}

export async function importIntrospected(
  projectId: string,
  sourceId: string,
  renames: readonly ConfirmedRename[] = [],
): Promise<Imported> {
  const { id } = CreatedSchema.parse(
    await apiFetch<unknown>(`/projects/${encodeURIComponent(projectId)}/introspect/apply`, {
      method: 'POST',
      body: { sourceId, renames },
    }),
  );
  return pollImportJob(projectId, id);
}

/** Phase 4 §2.1 — a rename the user confirmed in the import dialog. */
export interface ConfirmedRename {
  readonly type: 'entity' | 'field';
  readonly fromId: string;
  readonly toName: string;
}

const RenameCandidateSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('entity'),
    fromId: z.string(),
    fromName: z.string(),
    toName: z.string(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal('field'),
    entityId: z.string(),
    entityName: z.string(),
    fromId: z.string(),
    fromName: z.string(),
    toName: z.string(),
    reason: z.string(),
  }),
]);
export type RenameCandidate = z.infer<typeof RenameCandidateSchema>;

const PreviewSchema = z.object({
  creates: z.array(z.string()),
  existing: z.array(z.string()),
  renameCandidates: z.array(RenameCandidateSchema),
});
export type ImportPreview = z.infer<typeof PreviewSchema>;

/**
 * What an import would do, with rename proposals. `null` above the synchronous cap: the
 * preview takes a JSON body, so a queued-size source imports without rename cards.
 */
export async function previewImport(
  projectId: string,
  source: string,
  format?: string,
): Promise<ImportPreview | null> {
  if (format === undefined && new Blob([source]).size > SYNC_IMPORT_MAX_BYTES) return null;
  return PreviewSchema.parse(
    await apiFetch<unknown>(`/projects/${encodeURIComponent(projectId)}/import/preview`, {
      method: 'POST',
      body: { source, ...(format === undefined ? {} : { format }) },
    }),
  );
}

/** Phase 12 — a template's SQL; the caller imports it like any pasted source. */
export async function fetchTemplate(engineId: string, templateId: string): Promise<string> {
  return z
    .object({ source: z.string() })
    .parse(
      await apiFetch<unknown>(
        `/engines/${encodeURIComponent(engineId)}/templates/${encodeURIComponent(templateId)}`,
      ),
    ).source;
}

/** The templates one engine offers, read from `GET /engines` in the browser. */
export async function listTemplates(engineId: string): Promise<TemplateOption[]> {
  const { available } = z
    .object({
      available: z.array(
        z.object({
          id: z.string(),
          templates: z
            .array(
              z.object({
                id: z.string(),
                title: z.string(),
                summary: z.string(),
                tableCount: z.number(),
              }),
            )
            .default([]),
        }),
      ),
    })
    .parse(await apiFetch<unknown>('/engines'));
  return available.find((engine) => engine.id === engineId)?.templates ?? [];
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
    mode: 'describe',
    icon: Sparkles,
    title: 'Describe your app',
    body: 'Explain what you are building, in as much detail as you like. AI drafts the tables and relations; you review them before anything is created.',
    action: 'Describe',
  },
  {
    mode: 'import',
    icon: Upload,
    title: 'Import SQL or Prisma',
    body: 'Paste a SQL dump, a migration or a schema.prisma and start from the schema you already run.',
    action: 'Import',
  },
  {
    mode: 'database',
    icon: Database,
    title: 'Read a database',
    body: 'Connect to a running database and import its schema. Only the schema is read.',
    action: 'Connect',
  },
  {
    mode: 'template',
    icon: LayoutGrid,
    title: 'Start from a template',
    body: 'A small, realistic schema to explore or build on. You can change everything.',
    action: 'Choose',
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
  compact = false,
}: {
  orgId: string;
  orgSlug: string;
  engines: readonly EngineOption[];
  workspaces?: readonly WorkspaceSummary[];
  /** Doc 05 §3.2: owner and admin may create workspaces. */
  canManageWorkspaces?: boolean;
  /** Existing projects the caller may edit, offered as import targets. */
  importTargets?: readonly ProjectSummary[];
  /** Under an existing project list: one row of small tiles instead of the teaching cards. */
  compact?: boolean;
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [target, setTarget] = useState(NEW_PROJECT);
  const [name, setName] = useState('');
  const [engineId, setEngineId] = useState(engines[0]?.id ?? '');
  const [engineVersion, setEngineVersion] = useState(engines[0]?.defaultTargetVersion ?? '');
  const [templateId, setTemplateId] = useState('');
  /** Pre-fills the name with the template's title, unless the user typed their own. */
  const chooseTemplate = (next: TemplateOption | undefined) => {
    const previous = engines.flatMap((e) => e.templates).find((t) => t.id === templateId);
    setTemplateId(next?.id ?? '');
    setName((current) =>
      next !== undefined && (current === '' || current === previous?.title) ? next.title : current,
    );
  };
  /** Switching engine resets the version to that engine's default: "16" means nothing to MySQL. */
  const chooseEngine = (next: EngineOption, m: Mode | null = mode) => {
    setEngineId(next.id);
    setEngineVersion(next.defaultTargetVersion ?? '');
    if (m === 'template') chooseTemplate(next.templates[0]);
  };
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? '');
  const [workspaceName, setWorkspaceName] = useState('');
  const [source, setSource] = useState('');
  const [description, setDescription] = useState('');
  const [draft, setDraft] = useState<ConnectionDraft>({});
  /** 6c — save the connection on the project, so it can Sync later */
  const [remember, setRemember] = useState(true);
  /** Phase 13 — the database file, for an engine that reads one */
  const [dbFile, setDbFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<{
    href: string;
    statements: Skipped;
    existing: readonly string[];
  } | null>(null);

  const engine = engines.find((candidate) => candidate.id === engineId);
  const canImport = engines.some((candidate) => candidate.importFormats.length > 0);
  const canRead = engines.some((candidate) => readsDatabase(candidate));
  const hasTemplates = engines.some((candidate) => candidate.templates.length > 0);
  const fromTemplate = mode === 'template';
  const importing = mode === 'import' || mode === 'database';
  const intoExisting = importing && target !== NEW_PROJECT;
  /** Engines each mode can use: import needs a format, database a connection form, template one. */
  const usable = (candidate: EngineOption, m: Mode = mode ?? 'blank') =>
    m === 'blank' ||
    (m === 'import' || m === 'describe'
      ? candidate.importFormats.length > 0
      : m === 'template'
        ? candidate.templates.length > 0
        : readsDatabase(candidate));

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
      <ul className={compact ? 'grid gap-2 sm:grid-cols-2' : 'mt-6 grid gap-3 sm:grid-cols-2'}>
        {STARTING_POINTS.map((point) => (
          <li
            key={point.title}
            className={
              compact
                ? 'flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5'
                : 'flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 shadow-panel'
            }
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-subtle text-accent-text">
              <point.icon className="size-4" aria-hidden="true" />
            </span>
            <h2
              className={
                compact
                  ? 'min-w-0 flex-1 truncate text-sm font-medium text-text'
                  : 'text-sm font-medium text-text'
              }
            >
              {point.title}
            </h2>
            {!compact && <p className="text-sm text-text-muted">{point.body}</p>}
            <Button
              variant="outline"
              size="sm"
              className={compact ? 'shrink-0' : 'mt-auto self-start'}
              disabled={
                engines.length === 0 ||
                ((point.mode === 'import' || point.mode === 'describe') && !canImport) ||
                (point.mode === 'database' && !canRead) ||
                (point.mode === 'template' && !hasTemplates)
              }
              onClick={() => {
                setMode(point.mode);
                const next =
                  engine !== undefined && usable(engine, point.mode)
                    ? engine
                    : engines.find((c) => usable(c, point.mode));
                if (next !== undefined && next.id !== engineId) chooseEngine(next, point.mode);
                else if (point.mode === 'template') chooseTemplate(next?.templates[0]);
                if (point.mode === 'database') setDraft(initialDraft(next?.connectionFields ?? []));
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

  /** Saves the connection on the project first when asked; a manager-only save that is
   *  refused (importing into someone else's project) falls back to the typed details. */
  const databaseSource = async (id: string): Promise<ConnectionSource> => {
    if (engine?.introspection === 'file') {
      if (dbFile === null)
        throw new ApiError(400, 'introspect.upload_empty', 'Choose a database file.');
      return { upload: dbFile };
    }
    const connection = connectionPayload(engine?.connectionFields ?? [], draft);
    if (!remember) return { connection };
    try {
      await saveConnection(id, connection);
      return { saved: true };
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 403) return { connection };
      throw caught;
    }
  };

  const describing = mode === 'describe';

  /** Phase 22 §1.2 — the AI's DDL lands in the SQL box for review; nothing is imported yet. */
  const draftInto = async (id: string) => {
    try {
      setSource((await draftSchema(id, description)).source);
    } catch (caught) {
      setError(aiErrorMessage(caught));
    }
    setBusy(false);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      // Reused on a retry, so a failed import never leaves a second empty project behind.
      const id = intoExisting ? target : (createdId ?? (await createProject()));
      if (!intoExisting) setCreatedId(id);
      const href = `/${encodeURIComponent(orgSlug)}/p/${encodeURIComponent(id)}`;
      if (describing && source === '') {
        await draftInto(id);
        return;
      }
      if (importing || fromTemplate || describing) {
        const { report, existing } =
          mode === 'database'
            ? await importIntrospected(
                id,
                (await introspectPreview(id, await databaseSource(id))).sourceId,
              )
            : fromTemplate
              ? await importInto(id, await fetchTemplate(engineId, templateId))
              : await importInto(
                  id,
                  source,
                  [],
                  detectImportFormat(source, engine?.importFormats ?? []),
                );
        // `ignored` is SET, COMMENT, GRANT…: nothing the schema lost, so it isn't a loss.
        const notApplied = report.statements.filter(
          (s) => s.status !== 'applied' && s.status !== 'ignored',
        );
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
        {mode === 'blank'
          ? 'New project'
          : mode === 'database'
            ? 'Read a database'
            : mode === 'template'
              ? 'Start from a template'
              : describing
                ? 'Describe your app'
                : `Import ${importSourceName(engine?.importFormats ?? [])}`}
      </h2>
      {fromTemplate && engine !== undefined && (
        <label className="flex flex-col gap-1 text-sm text-text">
          Template
          <select
            value={templateId}
            disabled={createdId !== null}
            onChange={(e) => {
              chooseTemplate(engine.templates.find((t) => t.id === e.target.value));
            }}
            className={inputClass}
          >
            {engine.templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.title}: {template.summary} ({template.tableCount} tables)
              </option>
            ))}
          </select>
        </label>
      )}
      {importing && importTargets.length > 0 && (
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
                  const next = engines.find((candidate) => candidate.id === e.target.value);
                  if (next !== undefined) chooseEngine(next);
                }}
                className={inputClass}
              >
                {engines
                  .filter((candidate) => usable(candidate))
                  .map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.displayName}
                    </option>
                  ))}
              </select>
            </label>
            <label className="flex flex-1 flex-col gap-1 text-sm text-text">
              Target version
              {engine !== undefined && engine.targetVersions.length > 0 ? (
                <select
                  value={engineVersion}
                  onChange={(e) => {
                    setEngineVersion(e.target.value);
                  }}
                  className={inputClass}
                >
                  {engine.targetVersions.map((version) => (
                    <option key={version} value={version}>
                      {/* "16" reads "PostgreSQL 16"; "MariaDB 11.4" already names its product. */}
                      {/^\d/.test(version) ? `${engine.displayName} ${version}` : version}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  required
                  maxLength={32}
                  value={engineVersion}
                  onChange={(e) => {
                    setEngineVersion(e.target.value);
                  }}
                  className={inputClass}
                />
              )}
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
      {describing && (
        <>
          <label className="flex flex-col gap-1 text-sm text-text">
            What are you building?
            <textarea
              required
              rows={8}
              maxLength={DESCRIPTION_MAX}
              disabled={busy}
              value={description}
              placeholder="e.g. A booking app for barbershops: shops have barbers and services, customers book appointments with a barber, pay online and leave reviews."
              onChange={(e) => {
                setDescription(e.target.value);
              }}
              className={inputClass}
            />
            <span className="self-end text-xs text-text-muted">
              {description.length.toLocaleString()} / {DESCRIPTION_MAX.toLocaleString()}
            </span>
          </label>
          {source !== '' && (
            <label className="flex flex-col gap-1 text-sm text-text">
              Drafted schema: review or edit it, then create the tables
              <textarea
                required
                rows={12}
                disabled={busy}
                value={source}
                onChange={(e) => {
                  setSource(e.target.value);
                }}
                className={`${inputClass} font-mono text-xs`}
              />
            </label>
          )}
        </>
      )}
      {mode === 'import' && (
        <>
          <label className="flex flex-col gap-1 text-sm text-text">
            {importSourceName(engine?.importFormats ?? [])}
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
              accept={engine?.importFormats.flatMap((f) => f.fileExtensions).join(',')}
              onChange={(e) => {
                void e.target.files?.[0]?.text().then(setSource);
              }}
            />
          </label>
        </>
      )}
      {mode === 'database' && engine?.introspection === 'file' && (
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          Database file
          <input
            type="file"
            accept=".db,.sqlite,.sqlite3,.db3"
            disabled={busy}
            onChange={(e) => {
              setDbFile(e.target.files?.[0] ?? null);
            }}
          />
          Only its schema is read, never its rows, and the file is deleted after.
        </label>
      )}
      {mode === 'database' && engine !== undefined && engine.introspection !== 'file' && (
        <>
          <ConnectionForm
            fields={engine.connectionFields}
            draft={draft}
            onChange={setDraft}
            disabled={busy}
          />
          <label className="flex items-center gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={remember}
              disabled={busy}
              onChange={(e) => {
                setRemember(e.target.checked);
              }}
            />
            Remember this connection for the project, to Sync later (passwords and keys are stored
            encrypted)
          </label>
        </>
      )}
      {createdId !== null && (
        <p className="text-xs text-text-muted">
          {describing
            ? 'The project exists and stays empty until you create the tables.'
            : 'The project exists; submitting again retries only the import.'}
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
            ? describing && source === ''
              ? 'Drafting…'
              : 'Working…'
            : describing
              ? source === ''
                ? createdId === null
                  ? 'Create project and draft'
                  : 'Draft'
                : 'Create tables'
              : mode === 'blank' || fromTemplate
                ? 'Create project'
                : intoExisting
                  ? 'Import'
                  : 'Create and import'}
        </Button>
        {describing && source !== '' && createdId !== null && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || description.trim() === ''}
            onClick={() => {
              setBusy(true);
              setError(null);
              void draftInto(createdId);
            }}
          >
            Draft again
          </Button>
        )}
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
