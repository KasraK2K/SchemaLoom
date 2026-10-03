'use client';

import { restrictedFieldModeSchema, type RestrictedFieldMode } from '@schemaloom/contracts';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  Settings,
} from '@schemaloom/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import { ProjectApiTokens } from '@/features/api-tokens/api-tokens';
import { projectShellKey } from '@/features/change-requests/change-requests-api';
import { SavedConnectionSettings } from '@/features/projects/saved-connection';
import { ApiError, apiFetch } from '@/lib/api-client';

/** `GET /projects/:id/settings` — `ProjectSettingsView` in `apps/api/src/projects`. */
const settingsSchema = z.object({
  restrictedFieldMode: restrictedFieldModeSchema,
  requireChangeRequests: z.boolean().default(false),
  ai: z.object({ enabled: z.boolean(), includeDocsInContext: z.boolean() }),
});
type ProjectSettings = z.infer<typeof settingsSchema>;

const settingsKey = (projectId: string) => ['project', projectId, 'settings'] as const;

function messageOf(error: unknown): string {
  if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
    return 'Only people who manage sharing on this project can change its settings.';
  }
  return error instanceof ApiError ? error.message : 'Something went wrong. Try again.';
}

/**
 * Project settings: how restricted fields appear to people who may not see them, and the
 * AI kill switch (doc 05 §2.2 `sharing:manage`). The API re-checks every write under the
 * sharing lock; a refusal is shown as a sentence, not a disabled mystery.
 */
export function ProjectSettingsDialog({ projectId }: { readonly projectId: string }) {
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const query = useQuery({
    queryKey: settingsKey(projectId),
    enabled: open,
    retry: false,
    queryFn: async () =>
      settingsSchema.parse(await apiFetch<unknown>(`/projects/${projectId}/settings`)),
  });
  const save = useMutation({
    mutationFn: async (write: { path: string; body: unknown }) =>
      settingsSchema.parse(
        await apiFetch<unknown>(`/projects/${projectId}/${write.path}`, {
          method: 'PATCH',
          body: write.body,
        }),
      ),
    onSuccess: async (next) => {
      client.setQueryData(settingsKey(projectId), next);
      // The canvas, History and the header read protection from the project shell.
      await client.invalidateQueries({ queryKey: projectShellKey(projectId) });
    },
  });

  const setMode = (mode: RestrictedFieldMode) => {
    save.mutate({ path: 'restricted-field-mode', body: { mode } });
  };
  const setAi = (ai: Partial<ProjectSettings['ai']>) => {
    save.mutate({ path: 'settings', body: { ai } });
  };
  const setProtected = (enabled: boolean) => {
    save.mutate({ path: 'require-change-requests', body: { enabled } });
  };
  const error = query.error ?? save.error;
  const settings = query.data;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="Project settings"
          className="flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-sm text-text-muted hover:bg-surface-hover"
        >
          <Settings className="size-4" aria-hidden="true" />
          Settings
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
        <DialogTitle>Project settings</DialogTitle>
        <DialogDescription>Apply to everyone who opens this project.</DialogDescription>
        {error !== null && (
          <p
            role="alert"
            className="rounded-md border border-danger px-3 py-2 text-sm text-danger-text"
          >
            {messageOf(error)}
          </p>
        )}
        {query.isPending && open && <p className="text-sm text-text-subtle">Loading…</p>}
        {settings !== undefined && (
          <div className="flex flex-col gap-5">
            <label className="flex flex-col gap-1 text-sm text-text">
              Restricted fields, for people without access to them
              <select
                className="h-8 rounded-md border border-border bg-surface px-2 text-sm text-text"
                value={settings.restrictedFieldMode}
                disabled={save.isPending}
                onChange={(event) => {
                  setMode(event.target.value as RestrictedFieldMode);
                }}
              >
                <option value="mask">Masked: shown as a hidden column</option>
                <option value="hide">Hidden: left out entirely</option>
              </select>
            </label>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm text-text">AI assistant</legend>
              <label className="flex items-center gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  className="size-3.5 accent-accent"
                  checked={settings.ai.enabled}
                  disabled={save.isPending}
                  onChange={(event) => {
                    setAi({ enabled: event.target.checked });
                  }}
                />
                Allow the AI assistant in this project
              </label>
              <label className="flex items-center gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  className="size-3.5 accent-accent"
                  checked={settings.ai.includeDocsInContext}
                  disabled={save.isPending || !settings.ai.enabled}
                  onChange={(event) => {
                    setAi({ includeDocsInContext: event.target.checked });
                  }}
                />
                Include documentation in what the AI sees
              </label>
            </fieldset>
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-sm text-text">Change requests</legend>
              <label className="flex items-center gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  className="size-3.5 accent-accent"
                  checked={settings.requireChangeRequests}
                  disabled={save.isPending}
                  onChange={(event) => {
                    setProtected(event.target.checked);
                  }}
                />
                Require change requests
              </label>
              <p className="text-xs text-text-muted">
                Changes are only possible by merging a reviewed change request: no direct edits,
                moved tables, imports, syncs or restores, for anyone. Comments and docs stay
                editable. People with access to only some areas can’t propose changes, so they lose
                editing.
              </p>
            </fieldset>
            <SavedConnectionSettings projectId={projectId} />
          </div>
        )}
        {/* Not a manager-only setting: anyone who can open the project may hold a token. */}
        {open && (
          <div className="pt-3">
            <ProjectApiTokens projectId={projectId} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
