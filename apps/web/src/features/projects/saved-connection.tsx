'use client';

import { Button } from '@schemaloom/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import { ApiError, apiFetch } from '@/lib/api-client';
import {
  ConnectionForm,
  connectionPayload,
  initialDraft,
  type ConnectionDraft,
  type ConnectionField,
} from './connection-form';

/**
 * Phase 6c (docs/phase6/SAVED-CONNECTIONS.md) — the project's saved database connection:
 * the calls, the hook every "From a database" form uses to decide what a read connects with,
 * and the section that shows either the saved connection or the form.
 */

const SavedSchema = z.object({
  values: z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string())])),
  secretsSet: z.array(z.string()),
  savedAt: z.string(),
  savedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  lastUsedAt: z.string().nullable(),
  // 6d — scheduled drift checks
  driftSchedule: z.enum(['off', 'daily', 'weekly']).default('off'),
  lastCheck: z
    .object({
      at: z.string(),
      status: z.enum(['in_sync', 'drift', 'failed']),
      summary: z
        .object({
          added: z.number().optional(),
          removed: z.number().optional(),
          changed: z.number().optional(),
          error: z.string().optional(),
        })
        .nullable(),
    })
    .nullable()
    .default(null),
});
export type DriftSchedule = SavedConnection['driftSchedule'];
export type SavedConnection = z.infer<typeof SavedSchema>;

/** What a read sends: the typed details, or the saved connection as saved. */
export type ConnectionSource =
  | { readonly connection: Record<string, unknown> }
  | { readonly saved: true }
  /** Phase 13 — a database file for an engine that reads one (SQLite) */
  | { readonly upload: File };

const path = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/connection`;
export const savedConnectionKey = (projectId: string) => ['saved-connection', projectId] as const;

/** null when the project has none (404). */
export async function getSavedConnection(projectId: string): Promise<SavedConnection | null> {
  try {
    return SavedSchema.parse(await apiFetch<unknown>(path(projectId)));
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) return null;
    throw caught;
  }
}

/** A blank secret keeps the saved one while host, user and SSH server are unchanged. */
export async function saveConnection(
  projectId: string,
  connection: Record<string, unknown>,
): Promise<SavedConnection> {
  return SavedSchema.parse(
    await apiFetch<unknown>(path(projectId), { method: 'PUT', body: { connection } }),
  );
}

/** 6d — managers only (403 otherwise). */
export async function setDriftSchedule(
  projectId: string,
  driftSchedule: DriftSchedule,
): Promise<SavedConnection> {
  return SavedSchema.parse(
    await apiFetch<unknown>(path(projectId), { method: 'PATCH', body: { driftSchedule } }),
  );
}

/** "In sync", "3 differences" or "Failed: <reason>", for the last scheduled check. */
export function describeLastCheck(check: NonNullable<SavedConnection['lastCheck']>): string {
  if (check.status === 'failed') return `Failed: ${check.summary?.error ?? 'unknown error'}`;
  if (check.status === 'in_sync') return 'In sync';
  const total =
    (check.summary?.added ?? 0) + (check.summary?.removed ?? 0) + (check.summary?.changed ?? 0);
  return `${String(total)} difference${total === 1 ? '' : 's'}`;
}

export async function forgetConnection(projectId: string): Promise<void> {
  await apiFetch<unknown>(path(projectId), { method: 'DELETE' });
}

/** A saved connection as the form's draft: its values over the engine's defaults. */
function draftFrom(fields: readonly ConnectionField[], saved: SavedConnection): ConnectionDraft {
  const draft: Record<string, string> = { ...initialDraft(fields) };
  for (const [id, value] of Object.entries(saved.values)) {
    draft[id] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return draft;
}

/** `reader@db.example.com:5432/shop`, plus the bastion when there is one. */
export function describeConnection(saved: SavedConnection): string {
  const v = saved.values;
  const target = `${String(v.user ?? '')}@${String(v.host ?? '')}:${String(v.port ?? '')}/${String(v.database ?? '')}`;
  return v.ssh === 'ssh'
    ? `${target} via SSH ${String(v.ssh_user ?? '')}@${String(v.ssh_host ?? '')}`
    : target;
}

export interface ConnectionChoice {
  /** undefined while loading; null when nothing is saved */
  readonly saved: SavedConnection | null | undefined;
  readonly editing: boolean;
  readonly draft: ConnectionDraft;
  readonly setDraft: (draft: ConnectionDraft) => void;
  readonly remember: boolean;
  readonly setRemember: (remember: boolean) => void;
  readonly startEditing: () => void;
  readonly stopEditing: () => void;
  /** Saves first when asked (or when editing), then says what the read should send. A note
   *  comes back when saving was refused (only managers may) and the typed details are used. */
  readonly resolve: () => Promise<{ readonly source: ConnectionSource; readonly note?: string }>;
  readonly reset: () => void;
  /** Phase 13 — the engine reads an uploaded file (SQLite): no form, no saved connection */
  readonly upload: boolean;
  readonly file: File | null;
  readonly setFile: (file: File | null) => void;
}

export function useConnectionChoice(
  projectId: string | null,
  fields: readonly ConnectionField[],
  upload = false,
): ConnectionChoice {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: savedConnectionKey(projectId ?? ''),
    queryFn: () => getSavedConnection(projectId ?? ''),
    enabled: projectId !== null && !upload,
  });
  // An error (no access, network) reads as none, never as loading forever. A file engine has
  // nothing to save, so nothing is ever saved.
  const saved = projectId === null || upload || query.isError ? null : query.data;
  const [file, setFile] = useState<File | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ConnectionDraft>(() => initialDraft(fields));
  const [remember, setRemember] = useState(true);

  const resolve = async (): Promise<{ source: ConnectionSource; note?: string }> => {
    if (upload) {
      if (file === null)
        throw new ApiError(400, 'introspect.upload_empty', 'Choose a database file.');
      return { source: { upload: file } };
    }
    if (saved && !editing) return { source: { saved: true } };
    const connection = connectionPayload(fields, draft);
    if (projectId === null || (!remember && !editing)) return { source: { connection } };
    try {
      await saveConnection(projectId, connection);
      await queryClient.invalidateQueries({ queryKey: savedConnectionKey(projectId) });
      setEditing(false);
      return { source: { saved: true } };
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 403 && !editing) {
        return {
          source: { connection },
          note: 'Not saved: only project managers can save a connection. Read with these details once.',
        };
      }
      throw caught;
    }
  };

  return {
    saved,
    editing,
    draft,
    setDraft,
    remember,
    setRemember,
    startEditing: () => {
      if (saved) setDraft(draftFrom(fields, saved));
      setEditing(true);
    },
    stopEditing: () => {
      setEditing(false);
    },
    resolve,
    reset: () => {
      setEditing(false);
      setDraft(initialDraft(fields));
      setRemember(true);
      setFile(null);
    },
    upload,
    file,
    setFile,
  };
}

/** The saved connection's summary with Edit, or the form (with "Remember" when new). */
export function ConnectionSection({
  choice,
  fields,
  disabled,
  canRemember = true,
}: {
  readonly choice: ConnectionChoice;
  readonly fields: readonly ConnectionField[];
  readonly disabled: boolean;
  /** false where there is no project yet to save it on */
  readonly canRemember?: boolean;
}) {
  const { saved } = choice;
  if (choice.upload) {
    return (
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        Database file
        <input
          type="file"
          accept=".db,.sqlite,.sqlite3,.db3"
          disabled={disabled}
          onChange={(e) => {
            choice.setFile(e.target.files?.[0] ?? null);
          }}
        />
        <span>
          Only its schema is read, never its rows, and the file is deleted after. Too big to upload?
          Run <code className="font-mono">sqlite3 app.db .schema</code> and import the output as
          SQL.
        </span>
      </label>
    );
  }
  if (saved && !choice.editing) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-xs">
        <p className="text-text">
          Saved connection: <code className="font-mono break-all">{describeConnection(saved)}</code>
        </p>
        <p className="text-text-muted">
          Saved {new Date(saved.savedAt).toLocaleString()}
          {saved.savedBy === null ? '' : ` by ${saved.savedBy.name}`}
          {saved.lastUsedAt === null
            ? ''
            : `, last used ${new Date(saved.lastUsedAt).toLocaleString()}`}
          .
        </p>
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={choice.startEditing}
          >
            Edit connection
          </Button>
        </div>
      </div>
    );
  }
  return (
    <>
      <ConnectionForm
        fields={fields}
        draft={choice.draft}
        onChange={choice.setDraft}
        disabled={disabled}
        savedSecrets={choice.editing ? new Set(saved?.secretsSet ?? []) : undefined}
      />
      {choice.editing ? (
        <div className="flex items-center gap-2 text-xs text-text-muted">
          Saving replaces the project’s connection.
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={choice.stopEditing}
          >
            Cancel editing
          </Button>
        </div>
      ) : (
        canRemember && (
          <label className="flex items-center gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={choice.remember}
              disabled={disabled}
              onChange={(e) => {
                choice.setRemember(e.target.checked);
              }}
            />
            Remember this connection for this project (passwords and keys are stored encrypted)
          </label>
        )
      )}
    </>
  );
}

/** Project settings' part: what is saved, and Forget (two clicks, managers only server-side). */
export function SavedConnectionSettings({ projectId }: { readonly projectId: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: savedConnectionKey(projectId),
    queryFn: () => getSavedConnection(projectId),
    retry: false,
  });
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!query.data) return null;

  const forget = () => {
    setBusy(true);
    setError(null);
    forgetConnection(projectId)
      .then(() => queryClient.invalidateQueries({ queryKey: savedConnectionKey(projectId) }))
      .catch((caught: unknown) => {
        setError(
          caught instanceof ApiError && caught.status === 403
            ? 'Only project managers can forget the connection.'
            : 'Something went wrong. Try again.',
        );
      })
      .finally(() => {
        setBusy(false);
        setConfirming(false);
      });
  };

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm text-text">Database connection</legend>
      <p className="text-xs text-text-muted">
        <code className="font-mono break-all">{describeConnection(query.data)}</code>. Used by Sync
        on the canvas and Compare in History; change it there with “Edit connection”.
      </p>
      <label className="flex items-center gap-2 text-sm text-text">
        Check for drift
        <select
          className="h-8 rounded-md border border-border bg-surface px-2 text-sm text-text"
          value={query.data.driftSchedule}
          disabled={busy}
          onChange={(event) => {
            const next = event.target.value as DriftSchedule;
            setBusy(true);
            setError(null);
            setDriftSchedule(projectId, next)
              .then((view) => {
                queryClient.setQueryData(savedConnectionKey(projectId), view);
              })
              .catch((caught: unknown) => {
                setError(
                  caught instanceof ApiError && caught.status === 403
                    ? 'Only project managers can change the schedule.'
                    : 'Something went wrong. Try again.',
                );
              })
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          <option value="off">Off</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
      </label>
      <p className="text-xs text-text-muted">
        {query.data.lastCheck === null
          ? 'Not checked yet. Managers are notified when new differences appear.'
          : `Last check ${new Date(query.data.lastCheck.at).toLocaleString()}: ${describeLastCheck(query.data.lastCheck)}.`}
      </p>
      {error !== null && <p className="text-xs text-danger-text">{error}</p>}
      <div className="flex gap-2">
        {confirming ? (
          <>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={forget}>
              Forget it: passwords and keys are deleted
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
              }}
            >
              Keep
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setConfirming(true);
            }}
          >
            Forget connection
          </Button>
        )}
      </div>
    </fieldset>
  );
}
