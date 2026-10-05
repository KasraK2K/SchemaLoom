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
import { NameDialog } from '@/components/name-dialog';
import type { OrgTemplate } from '@/features/projects';
import { ApiError, apiFetch } from '@/lib/api-client';

/** Roadmap 12c §2.1 — Settings → Templates: the list, with rename and delete where allowed. */
export function TemplatesManager({
  orgSlug,
  templates,
  engineNames,
}: {
  readonly orgSlug: string;
  readonly templates: readonly OrgTemplate[];
  readonly engineNames: Readonly<Record<string, string>>;
}) {
  const router = useRouter();
  const [renaming, setRenaming] = useState<OrgTemplate | null>(null);
  const [deleting, setDeleting] = useState<OrgTemplate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = (id: string) =>
    `/organizations/${encodeURIComponent(orgSlug)}/templates/${encodeURIComponent(id)}`;

  if (templates.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-text-muted">
        No templates yet. A project manager can save one from the project&rsquo;s menu.
      </p>
    );
  }

  return (
    <>
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
        {templates.map((t) => (
          <li key={t.id} className="flex items-start gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text">{t.name}</p>
              {t.summary !== '' && <p className="text-sm text-text-muted">{t.summary}</p>}
              <p className="mt-1 text-xs text-text-subtle">
                {t.tableCount} table{t.tableCount === 1 ? '' : 's'} ·{' '}
                {engineNames[t.engineId] ?? t.engineId} {t.engineVersion}
                {t.savedBy !== null && <> · saved by {t.savedBy.name}</>}
              </p>
              {!t.usable && (
                <p className="mt-1 text-xs text-warning-text">
                  Made with an older engine version, ask the saver to save it again.
                </p>
              )}
            </div>
            {t.canManage && (
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setRenaming(t);
                  }}
                >
                  Rename
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setError(null);
                    setDeleting(t);
                  }}
                >
                  Delete
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <NameDialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) setRenaming(null);
        }}
        title="Rename template"
        initial={renaming?.name ?? ''}
        submitLabel="Rename"
        onSubmit={async (name) => {
          if (renaming === null) return;
          await apiFetch(path(renaming.id), { method: 'PATCH', body: { name } });
          router.refresh();
        }}
      />

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!busy && !open) setDeleting(null);
        }}
      >
        <DialogContent>
          <DialogTitle>Delete {deleting?.name}?</DialogTitle>
          <DialogDescription>
            It disappears from the new-project screen. Projects already made from it stay as they
            are.
          </DialogDescription>
          {error !== null && (
            <p role="alert" className="mt-3 text-xs text-danger-text">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setDeleting(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (deleting === null) return;
                setBusy(true);
                apiFetch(path(deleting.id), { method: 'DELETE' })
                  .then(() => {
                    setDeleting(null);
                    router.refresh();
                  })
                  .catch((caught: unknown) => {
                    setError(
                      caught instanceof ApiError
                        ? caught.message
                        : 'Something went wrong. Try again.',
                    );
                  })
                  .finally(() => {
                    setBusy(false);
                  });
              }}
            >
              {busy ? 'Deleting…' : 'Delete template'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
