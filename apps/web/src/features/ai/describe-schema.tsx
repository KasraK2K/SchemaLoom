'use client';

import { Button } from '@schemaloom/ui';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { aiErrorMessage, draftSchema, type DraftSchemaBody, type DraftSummary } from './ai-api';

/**
 * Phase 22 — Draft, Refine and one step of Undo over a SQL box its caller owns (the import
 * dialog also fills it from templates and files, and the user may edit it). Refine sends
 * that box back as the draft, so edits are kept; nothing is stored on the server.
 */
export function useSchemaDraft(source: string, setSource: (source: string) => void) {
  const [summary, setSummary] = useState<DraftSummary | null>(null);
  const [drafted, setDrafted] = useState(false);
  const [previous, setPrevious] = useState<{
    source: string;
    summary: DraftSummary | null;
  } | null>(null);
  const run = useMutation({
    mutationFn: (v: { projectId: string; body: DraftSchemaBody }) =>
      draftSchema(v.projectId, v.body),
    onSuccess: (result, v) => {
      setPrevious(v.body.revise === undefined ? null : { source: v.body.revise.draft, summary });
      setDrafted(true);
      setSummary(result.summary);
      setSource(result.source);
    },
  });
  return {
    summary,
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
      setSummary(previous.summary);
      setPrevious(null);
    },
  };
}

export type SchemaDraft = ReturnType<typeof useSchemaDraft>;

/** The summary first (§1.1 step 2), then Refine and Undo. Lives inside other forms, so its
 *  Enter never submits them. */
export function DraftReview({
  draft,
  onRefine,
}: {
  readonly draft: SchemaDraft;
  readonly onRefine: (instruction: string) => Promise<unknown>;
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
        <SummaryList summary={draft.summary} />
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

function SummaryList({ summary }: { readonly summary: DraftSummary }) {
  const list = (names: readonly string[]) => names.map((n) => `\`${n}\``).join(', ');
  const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? '' : 's'}`;
  return (
    <ul aria-label="What the draft does" className="flex flex-col gap-1 text-text">
      <li>
        {summary.creates.length === 0
          ? 'Creates no new tables'
          : `Creates ${plural(summary.creates.length, 'table')}: ${list(summary.creates)}`}
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
          Adds to `{a.table}`: {list(a.columns)}
        </li>
      ))}
      {summary.existing.length > 0 && (
        <li className="text-text-muted">
          Already exists, left unchanged except for added columns: {list(summary.existing)}
        </li>
      )}
    </ul>
  );
}

/**
 * DESIGN §4.4 / Phase 22 §1.1 — "Describe a schema" in the import dialog. The draft lands
 * in the dialog's SQL box; nothing is applied from here. The ordinary import preview (and
 * its additive merge) runs on Import.
 */
export function DescribeSchema({
  projectId,
  draft,
  tableCount,
  focus,
  autoFocus = false,
}: {
  readonly projectId: string;
  readonly draft: SchemaDraft;
  /** visible tables, for "Build on" */
  readonly tableCount: number;
  /** the canvas selection the AI connects to (§1.1 step 1) */
  readonly focus: readonly { readonly id: string; readonly name: string }[];
  readonly autoFocus?: boolean;
}) {
  const [description, setDescription] = useState('');
  const body = {
    description: description.trim(),
    ...(focus.length === 0 ? {} : { focusEntityIds: focus.map((f) => f.id) }),
  };
  const buildOn =
    focus.length > 0
      ? `Builds on the ${focus.length === 1 ? 'selected table' : `${String(focus.length)} selected tables`}: ${focus.map((f) => f.name).join(', ')}`
      : tableCount > 0
        ? `Builds on your ${tableCount === 1 ? 'table' : `${String(tableCount)} tables`}`
        : null;

  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        Describe a schema
        <textarea
          rows={2}
          autoFocus={autoFocus}
          value={description}
          maxLength={10_000}
          placeholder="e.g. customers, orders and order items for a small shop"
          onChange={(e) => {
            setDescription(e.target.value);
          }}
          className="rounded-md border border-border bg-surface px-3 py-2 text-xs text-text"
        />
      </label>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-text-muted">{buildOn}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={description.trim() === '' || draft.pending}
          onClick={() => {
            draft.draft(projectId, body).catch(() => undefined);
          }}
        >
          {draft.pending ? 'Drafting…' : 'Draft SQL with AI'}
        </Button>
      </div>
      {draft.error !== null && (
        <span role="alert" className="text-xs text-danger-text">
          {draft.error}
        </span>
      )}
      {draft.drafted && (
        <DraftReview
          draft={draft}
          onRefine={(instruction) =>
            draft.refine(
              projectId,
              { ...body, description: body.description || 'Revise this schema.' },
              instruction,
            )
          }
        />
      )}
    </div>
  );
}
