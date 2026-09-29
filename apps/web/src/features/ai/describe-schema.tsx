'use client';

import { Button } from '@schemaloom/ui';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { aiErrorMessage, draftSchema } from './ai-api';

/**
 * DESIGN §4.4 "Describe a schema": the model drafts DDL, which lands in the import dialog's
 * SQL box. Nothing is applied from here — the user still reviews it and the ordinary import
 * preview (and its additive merge) runs on Import.
 */
export function DescribeSchema({
  projectId,
  onDraft,
}: {
  readonly projectId: string;
  readonly onDraft: (source: string) => void;
}) {
  const [description, setDescription] = useState('');
  const draft = useMutation({
    mutationFn: () => draftSchema(projectId, description),
    onSuccess: (result) => {
      onDraft(result.source);
    },
  });

  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        Describe a schema
        <textarea
          rows={2}
          value={description}
          placeholder="e.g. customers, orders and order items for a small shop"
          onChange={(e) => {
            setDescription(e.target.value);
          }}
          className="rounded-md border border-border bg-surface px-3 py-2 text-xs text-text"
        />
      </label>
      <div className="flex items-center justify-between gap-2">
        <span role={draft.error === null ? undefined : 'alert'} className="text-xs text-danger-text">
          {draft.error === null ? '' : aiErrorMessage(draft.error)}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={description.trim() === '' || draft.isPending}
          onClick={() => {
            draft.mutate();
          }}
        >
          {draft.isPending ? 'Drafting…' : 'Draft SQL with AI'}
        </Button>
      </div>
    </div>
  );
}
