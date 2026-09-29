'use client';

import { Button, Dialog, DialogContent, DialogFooter, DialogTitle } from '@schemaloom/ui';
import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api-client';

/** One text field, submit, show the API's error in place. Rename a project, name a new
 *  entity — anything that is "type a name and go". */
export function NameDialog({
  open,
  onOpenChange,
  title,
  initial = '',
  submitLabel,
  onSubmit,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly initial?: string;
  readonly submitLabel: string;
  readonly onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName(initial);
      setError(null);
    }
  }, [open, initial]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>{title}</DialogTitle>
        <form
          className="mt-4 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            onSubmit(name.trim())
              .then(() => {
                onOpenChange(false);
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
          <input
            autoFocus
            required
            maxLength={200}
            aria-label="Name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
            className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-text"
          />
          {error !== null && (
            <p role="alert" className="text-xs text-danger-text">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" variant="primary" size="sm" disabled={busy || name.trim() === ''}>
              {busy ? 'Working…' : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
