'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@schemaloom/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError, apiFetch } from '@/lib/api-client';
import type { OrgTemplate } from './projects-api';

const inputClass = 'rounded-md border border-border bg-surface px-3 py-2 text-sm text-text';
const NEW = '';

const MESSAGES: Record<string, string> = {
  org_template_full_view_required:
    'You can only save a project you can see in full, including its restricted columns.',
  org_template_limit: 'Your organization already has 50 templates. Delete one first.',
  org_template_manage_forbidden:
    'Only whoever saved that template, or an owner or admin, can replace it.',
};

/**
 * Roadmap 12c §2.1 — "Save as template…". The API checks `sharing:manage` and a complete
 * view; `tableCount` is null without one (the project list won't count what you can't
 * see), so the dialog says why up front instead of offering a form that can only fail.
 */
export function SaveTemplateDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
  orgName,
  tableCount,
  existing,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projectId: string;
  readonly projectName: string;
  readonly orgName: string;
  readonly tableCount: number | null;
  /** Templates saved earlier from this project, offered as "Replace". */
  readonly existing: readonly OrgTemplate[];
}) {
  const router = useRouter();
  const [replaceId, setReplaceId] = useState(NEW);
  const [name, setName] = useState(projectName);
  const [summary, setSummary] = useState('');
  const [includeDocs, setIncludeDocs] = useState(true);
  const [includeLayout, setIncludeLayout] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const choose = (id: string) => {
    setReplaceId(id);
    const template = existing.find((t) => t.id === id);
    setName(template?.name ?? projectName);
    setSummary(template?.summary ?? '');
  };

  const submit = () => {
    setBusy(true);
    setError(null);
    apiFetch(`/projects/${encodeURIComponent(projectId)}/save-as-template`, {
      method: 'POST',
      body: {
        name,
        summary,
        includeDocs,
        includeLayout,
        ...(replaceId === NEW ? {} : { replaceId }),
      },
    })
      .then(() => {
        setSaved(true);
        router.refresh();
      })
      .catch((caught: unknown) => {
        setError(
          caught instanceof ApiError
            ? (MESSAGES[caught.code] ?? caught.message)
            : 'Something went wrong. Try again.',
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) setSaved(false);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogTitle>Save as template</DialogTitle>
        {tableCount === null ? (
          <>
            <DialogDescription>{MESSAGES.org_template_full_view_required}</DialogDescription>
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Close
              </Button>
            </DialogFooter>
          </>
        ) : saved ? (
          <>
            <DialogDescription>
              Saved. It&rsquo;s listed under &ldquo;Your organization&rsquo;s templates&rdquo; when
              someone starts a project.
            </DialogDescription>
            <DialogFooter>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  setSaved(false);
                  onOpenChange(false);
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <DialogDescription>
              Everyone in {orgName} who can create projects will see these {tableCount} table
              {tableCount === 1 ? '' : 's'}
              {includeDocs ? ' and their docs' : ''}. Comments, history and sharing stay here.
            </DialogDescription>
            {existing.length > 0 && (
              <label className="flex flex-col gap-1 text-sm text-text">
                Save as
                <select
                  value={replaceId}
                  disabled={busy}
                  onChange={(e) => {
                    choose(e.target.value);
                  }}
                  className={inputClass}
                >
                  <option value={NEW}>A new template</option>
                  {existing.map((t) => (
                    <option key={t.id} value={t.id}>
                      Replace &ldquo;{t.name}&rdquo;
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex flex-col gap-1 text-sm text-text">
              Name
              <input
                required
                maxLength={200}
                disabled={busy}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-text">
              Summary
              <textarea
                rows={2}
                maxLength={2000}
                disabled={busy}
                value={summary}
                onChange={(e) => {
                  setSummary(e.target.value);
                }}
                className={inputClass}
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={includeDocs}
                disabled={busy}
                onChange={(e) => {
                  setIncludeDocs(e.target.checked);
                }}
              />
              Include docs
            </label>
            <label className="flex items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={includeLayout}
                disabled={busy}
                onChange={(e) => {
                  setIncludeLayout(e.target.checked);
                }}
              />
              Include layout
            </label>
            {error !== null && (
              <p role="alert" className="text-xs text-danger-text">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="sm" disabled={busy}>
                {busy ? 'Saving…' : replaceId === NEW ? 'Save template' : 'Replace template'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
