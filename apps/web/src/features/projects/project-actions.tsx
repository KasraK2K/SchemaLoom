'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  MoreHorizontal,
} from '@schemaloom/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { NameDialog } from '@/components/name-dialog';
import { ApiError, apiFetch } from '@/lib/api-client';
import type { OrgTemplate } from './projects-api';
import { SaveTemplateDialog } from './save-template-dialog';

/**
 * Rename / save as template / delete for one project row. Rendered only for a project manager: both routes
 * are gated on `sharing:manage` at the project, and a menu that can only fail is noise.
 * The API stays the authority; this just hides the menu from everyone else.
 */
export function ProjectActions({
  id,
  name,
  orgName = '',
  tableCount = null,
  templates = [],
}: {
  readonly id: string;
  readonly name: string;
  readonly orgName?: string;
  readonly tableCount?: number | null;
  /** Org templates saved from this project that the caller may replace (12c). */
  readonly templates?: readonly OrgTemplate[];
}) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/projects/${encodeURIComponent(id)}`;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Actions for ${name}`}>
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => {
              setRenaming(true);
            }}
          >
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setSaving(true);
            }}
          >
            Save as template…
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-danger-text"
            onSelect={() => {
              setError(null);
              setDeleting(true);
            }}
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <NameDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename project"
        initial={name}
        submitLabel="Rename"
        onSubmit={async (next) => {
          await apiFetch(path, { method: 'PATCH', body: { name: next } });
          router.refresh();
        }}
      />

      <SaveTemplateDialog
        open={saving}
        onOpenChange={setSaving}
        projectId={id}
        projectName={name}
        orgName={orgName}
        tableCount={tableCount}
        existing={templates}
      />

      <Dialog
        open={deleting}
        onOpenChange={(open) => {
          if (!busy) setDeleting(open);
        }}
      >
        <DialogContent>
          <DialogTitle>Delete {name}?</DialogTitle>
          <DialogDescription>
            The project, its diagram and its share links stop working for everyone.
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
                setDeleting(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                apiFetch(path, { method: 'DELETE' })
                  .then(() => {
                    setDeleting(false);
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
              {busy ? 'Deleting…' : 'Delete project'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
