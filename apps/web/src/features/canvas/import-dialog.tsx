'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@schemaloom/ui';
import { useState } from 'react';
import { useEngine } from '@/engines';
import { importInto, type Imported } from '@/features/projects/create-project';
import { ApiError } from '@/lib/api-client';

/**
 * SQL import into the open project. Same call as the project-list import (inline up to
 * 5 MB, queued above), and additive: existing objects win and nothing is deleted.
 */
export function ImportDialog({
  open,
  onOpenChange,
  projectId,
  onImported,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projectId: string;
  readonly onImported: () => Promise<void>;
}) {
  const facet = useEngine();
  const format = facet.capabilities.importFormats[0];
  const [source, setSource] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Imported | null>(null);

  const close = (next: boolean) => {
    if (busy) return;
    onOpenChange(next);
    if (!next) {
      setSource('');
      setError(null);
      setResult(null);
    }
  };

  const notApplied = result?.report.statements.filter((s) => s.status !== 'applied') ?? [];

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>Import SQL</DialogTitle>
        <DialogDescription>
          Adds what the project does not have yet. Existing objects are left unchanged.
        </DialogDescription>
        {result !== null ? (
          <div className="mt-4 flex flex-col gap-2 text-xs">
            <p className="text-sm text-text">
              {result.report.statementCount - notApplied.length} of{' '}
              {result.report.statementCount} statements applied.
            </p>
            {result.existing.length > 0 && (
              <p className="text-text-muted">
                Already in the project, left unchanged: {result.existing.join(', ')}
              </p>
            )}
            {notApplied.length > 0 && (
              <ul className="flex max-h-64 flex-col gap-2 overflow-auto">
                {notApplied.map((statement) => (
                  <li key={statement.ordinal}>
                    <code className="block truncate text-text">{statement.excerpt}</code>
                    <span className="text-text-muted">
                      {statement.status}: {statement.reason}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <DialogFooter>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  close(false);
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              importInto(projectId, source)
                .then(async (imported) => {
                  await onImported();
                  setResult(imported);
                })
                .catch((caught: unknown) => {
                  setError(
                    caught instanceof ApiError ? caught.message : 'Something went wrong. Try again.',
                  );
                })
                .finally(() => {
                  setBusy(false);
                });
            }}
          >
            <textarea
              required
              autoFocus
              rows={12}
              aria-label="SQL"
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
              }}
              className="rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-text"
            />
            <label className="flex flex-col gap-1 text-xs text-text-muted">
              …or choose a file
              <input
                type="file"
                accept={format?.fileExtensions.join(',')}
                onChange={(e) => {
                  void e.target.files?.[0]?.text().then(setSource);
                }}
              />
            </label>
            {error !== null && (
              <p role="alert" className="text-xs text-danger-text">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="submit" variant="primary" size="sm" disabled={busy || source === ''}>
                {busy ? 'Importing…' : 'Import'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
