'use client';

import { Button } from '@schemaloom/ui';
import { useState } from 'react';
import { z } from 'zod';
import { ApiError, apiFetch } from '@/lib/api-client';

const CreatedSchema = z.object({ slug: z.string() });

/**
 * "New organisation" → a name field → the new org.
 *
 * After the create, the session is refreshed before navigating: the access token's `org`
 * claim was minted when the user belonged to nowhere, and refresh is what re-resolves
 * it. A FULL navigation, not router.push, so the next render reads the new cookies.
 */
export function CreateOrganization() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <Button
        variant="primary"
        size="sm"
        className="mt-4"
        onClick={() => {
          setOpen(true);
        }}
      >
        New organisation
      </Button>
    );
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { slug } = CreatedSchema.parse(
        await apiFetch<unknown>('/organizations', { method: 'POST', body: { name } }),
      );
      await apiFetch('/auth/refresh', { method: 'POST' });
      window.location.assign(`/${encodeURIComponent(slug)}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create it. Try again.');
      setBusy(false);
    }
  };

  return (
    <form
      className="mx-auto mt-4 flex max-w-sm flex-col gap-2 text-left"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="org-name" className="text-sm font-medium text-text">
        Organisation name
      </label>
      <input
        id="org-name"
        autoFocus
        required
        maxLength={120}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
        }}
        aria-invalid={error !== null}
        aria-describedby={error === null ? undefined : 'org-name-error'}
        className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-text"
      />
      {error !== null && (
        <p id="org-name-error" className="text-xs text-danger-text">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" size="sm" disabled={busy || name.trim() === ''}>
        {busy ? 'Creating…' : 'Create organisation'}
      </Button>
    </form>
  );
}
