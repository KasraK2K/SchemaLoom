'use client';

import { Button, cn } from '@schemaloom/ui';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import {
  aiErrorMessage,
  draftSchema,
  type DraftPreview,
  type DraftSchemaBody,
  type DraftSummary,
} from './ai-api';

interface Shown {
  readonly source: string;
  readonly summary: DraftSummary | null;
  readonly preview: DraftPreview | null;
}

/**
 * Phase 22 — Draft, Refine and one step of Undo over a SQL box its caller owns (the user may
 * edit it). Refine sends that box back as the draft, so edits are kept; nothing is stored on
 * the server. 22b: the preview (the canvas's ghosts) travels with the summary, Undo included.
 */
export function useSchemaDraft(source: string, setSource: (source: string) => void) {
  const [shown, setShown] = useState<Omit<Shown, 'source'>>({ summary: null, preview: null });
  const [drafted, setDrafted] = useState(false);
  const [previous, setPrevious] = useState<Shown | null>(null);
  const run = useMutation({
    mutationFn: (v: { projectId: string; body: DraftSchemaBody }) =>
      draftSchema(v.projectId, v.body),
    onSuccess: (result, v) => {
      setPrevious(v.body.revise === undefined ? null : { source: v.body.revise.draft, ...shown });
      setDrafted(true);
      setShown({ summary: result.summary, preview: result.preview });
      setSource(result.source);
    },
  });
  return {
    summary: shown.summary,
    preview: shown.preview,
    /** a draft arrived, so there is something to refine */
    drafted,
    pending: run.isPending,
    error: run.error === null ? null : aiErrorMessage(run.error),
    draft: (projectId: string, body: Omit<DraftSchemaBody, 'revise'>) =>
      run.mutateAsync({ projectId, body }),
    refine: (projectId: string, body: Omit<DraftSchemaBody, 'revise'>, instruction: string) =>
      run.mutateAsync({ projectId, body: { ...body, revise: { draft: source, instruction } } }),
    canUndo: previous !== null,
    undo: () => {
      if (previous === null) return;
      setSource(previous.source);
      setShown({ summary: previous.summary, preview: previous.preview });
      setPrevious(null);
    },
    /** Discard: back to an empty box */
    reset: () => {
      setSource('');
      setShown({ summary: null, preview: null });
      setDrafted(false);
      setPrevious(null);
      run.reset();
    },
  };
}

export type SchemaDraft = ReturnType<typeof useSchemaDraft>;

/** 22b — the panel and the canvas point at the same ghost: a draft key or an existing table id. */
export interface GhostHover {
  readonly hovered: string | null;
  readonly onHover: (key: string | null) => void;
}

/** The summary first (§1.1 step 2), then Refine and Undo. Lives inside other forms, so its
 *  Enter never submits them. */
export function DraftReview({
  draft,
  onRefine,
  hover,
}: {
  readonly draft: SchemaDraft;
  readonly onRefine: (instruction: string) => Promise<unknown>;
  readonly hover?: GhostHover;
}) {
  const [instruction, setInstruction] = useState('');
  const refine = () => {
    if (instruction.trim() === '' || draft.pending) return;
    onRefine(instruction.trim()).then(
      () => {
        setInstruction('');
      },
      () => undefined,
    );
  };
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-xs">
      {draft.summary === null ? (
        <p className="text-text-muted">The draft is below. Review it before importing.</p>
      ) : (
        <SummaryList summary={draft.summary} preview={draft.preview} hover={hover} />
      )}
      <div className="flex gap-2">
        <input
          aria-label="Refine the draft"
          value={instruction}
          maxLength={2_000}
          disabled={draft.pending}
          placeholder="e.g. make status an enum, split addresses into their own table"
          onChange={(e) => {
            setInstruction(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            refine();
          }}
          className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={instruction.trim() === '' || draft.pending}
          onClick={refine}
        >
          {draft.pending ? 'Refining…' : 'Refine'}
        </Button>
        {draft.canUndo && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={draft.pending}
            onClick={draft.undo}
          >
            Undo
          </Button>
        )}
      </div>
    </div>
  );
}

function SummaryList({
  summary,
  preview,
  hover,
}: {
  readonly summary: DraftSummary;
  readonly preview: DraftPreview | null;
  readonly hover: GhostHover | undefined;
}) {
  const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? '' : 's'}`;
  const keyOf = new Map(preview?.tables.map((t) => [t.name, t.key]));
  // A name points at its ghost when there is one; hovering either lights the other.
  const name = (n: string, key = keyOf.get(n)) => (
    <span
      key={n}
      data-ghost-key={key}
      data-hovered={key !== undefined && hover?.hovered === key}
      onPointerEnter={key === undefined ? undefined : () => hover?.onHover(key)}
      onPointerLeave={key === undefined ? undefined : () => hover?.onHover(null)}
      className={cn(
        'rounded-sm',
        key !== undefined && hover !== undefined && 'cursor-default hover:bg-accent-subtle',
        key !== undefined && hover?.hovered === key && 'bg-accent-subtle',
      )}
    >
      `{n}`
    </span>
  );
  const list = (names: readonly string[]) =>
    names.flatMap((n, i) => (i === 0 ? [name(n)] : [', ', name(n)]));
  const added = new Map(
    preview?.addedColumns.map((a) => [a.columns.map((c) => c.name).join(','), a.entityId]),
  );
  return (
    <ul aria-label="What the draft does" className="flex flex-col gap-1 text-text">
      <li>
        {summary.creates.length === 0 ? (
          'Creates no new tables'
        ) : (
          <>
            Creates {plural(summary.creates.length, 'table')}: {list(summary.creates)}
          </>
        )}
      </li>
      {summary.linksTo.length > 0 && <li>Links to existing: {list(summary.linksTo)}</li>}
      {summary.relations.length > 0 && (
        <li>
          {plural(summary.relations.length, 'relation')}:{' '}
          {summary.relations.map((r) => `${r.from} → ${r.to}`).join(', ')}
        </li>
      )}
      {summary.addsColumns.map((a) => (
        <li key={a.table}>
          Adds to {name(a.table, added.get(a.columns.join(',')))}:{' '}
          {a.columns.map((c) => `\`${c}\``).join(', ')}
        </li>
      ))}
      {summary.existing.length > 0 && (
        <li className="text-text-muted">
          Already exists, left unchanged except for added columns:{' '}
          {summary.existing.map((n) => `\`${n}\``).join(', ')}
        </li>
      )}
    </ul>
  );
}
