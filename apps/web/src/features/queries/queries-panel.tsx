'use client';

import { Button } from '@schemaloom/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useEngine } from '@/engines';
import { useCanvasStore } from '@/features/canvas/store';
import { relativeTime } from '@/features/projects/relative-time';
import { ApiError } from '@/lib/api-client';
import {
  FLAGGED_STATUSES,
  createSavedQuery,
  deleteSavedQuery,
  isReadOnly,
  parseTags,
  savedQueriesKey,
  savedQueriesQueryOptions,
  updateSavedQuery,
  validateQuery,
  type QueryValidation,
  type SavedQuery,
} from './queries-api';
import { SqlEditor, type EditorMark } from './sql-editor';

const VALIDATE_DEBOUNCE_MS = 400;

interface Draft {
  readonly id: string | null;
  readonly name: string;
  readonly queryText: string;
  readonly tags: string;
}

const EMPTY_DRAFT: Draft = { id: null, name: '', queryText: '', tags: '' };

/**
 * The saved-query library, as an inspector tab.
 *
 * Always shown: the server saves a query with no validator too (flagged unresolved, which
 * restricts it to complete-view readers). The live check and its underlines run only when
 * the engine reports `features.queryValidation`, since the validate route 400s otherwise.
 */
export function QueriesPanel({ projectId }: { readonly projectId: string }) {
  const queryClient = useQueryClient();
  const [tag, setTag] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const { data: queries, error } = useQuery(savedQueriesQueryOptions(projectId, tag));

  const invalidate = () => queryClient.invalidateQueries({ queryKey: savedQueriesKey(projectId) });
  const remove = useMutation({ mutationFn: deleteSavedQuery, onSuccess: invalidate });

  if (draft !== null) {
    return (
      <QueryEditor
        key={draft.id ?? 'new'}
        projectId={projectId}
        draft={draft}
        onDone={() => {
          setDraft(null);
          void invalidate();
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2 p-2 text-sm">
      <div className="flex items-center gap-2">
        <input
          aria-label="Filter by tag"
          placeholder="Filter by tag"
          value={tag}
          onChange={(e) => {
            setTag(e.target.value.trim());
          }}
          className="h-8 min-w-0 flex-1 rounded border border-border bg-surface px-2 text-xs text-text"
        />
        <Button
          size="sm"
          onClick={() => {
            setDraft(EMPTY_DRAFT);
          }}
        >
          New query
        </Button>
      </div>
      {error !== null && <p className="text-xs text-danger-text">Could not load saved queries.</p>}
      <QueryList
        queries={queries ?? []}
        onOpen={(q) => {
          setDraft({ id: q.id, name: q.name, queryText: q.queryText, tags: q.tags.join(', ') });
        }}
        onDelete={(q) => {
          if (window.confirm(`Delete “${q.name}”?`)) remove.mutate(q.id);
        }}
        onShow={(q) => {
          useCanvasStore.getState().select(q.touchedEntityIds, 'replace');
        }}
      />
    </div>
  );
}

/** Presentational, so it renders in a test with no engine or query client. */
export function QueryList({
  queries,
  onOpen,
  onDelete,
  onShow,
  now = Date.now(),
}: {
  readonly queries: readonly SavedQuery[];
  readonly onOpen: (q: SavedQuery) => void;
  readonly onDelete: (q: SavedQuery) => void;
  readonly onShow: (q: SavedQuery) => void;
  readonly now?: number;
}) {
  if (queries.length === 0) {
    return <p className="p-2 text-xs text-text-subtle">No saved queries yet.</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-border">
      {queries.map((q) => (
        <li key={q.id} className="flex items-start gap-2 py-2">
          <button
            type="button"
            className="min-w-0 flex-1 text-left"
            onClick={() => {
              onOpen(q);
            }}
          >
            <span className="block truncate font-medium text-text">{q.name}</span>
            <span className="block text-xs text-text-subtle">
              Updated {relativeTime(q.updatedAt, now)}
              {q.tags.length > 0 && ` · ${q.tags.join(', ')}`}
            </span>
          </button>
          {q.touchedEntityIds.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onShow(q);
              }}
            >
              Show
            </Button>
          )}
          {q.canEdit && (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Delete ${q.name}`}
              onClick={() => {
                onDelete(q);
              }}
            >
              Delete
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function QueryEditor({
  projectId,
  draft,
  onDone,
}: {
  readonly projectId: string;
  readonly draft: Draft;
  readonly onDone: () => void;
}) {
  const canValidate = useEngine().capabilities.features.queryValidation;
  const [name, setName] = useState(draft.name);
  const [tags, setTags] = useState(draft.tags);
  const [text, setText] = useState(draft.queryText);
  const [validation, setValidation] = useState<QueryValidation | null>(null);

  useEffect(() => {
    if (!canValidate || text.trim() === '') {
      setValidation(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      validateQuery(projectId, text).then(
        (result) => {
          if (live) setValidation(result);
        },
        () => {
          if (live) setValidation(null);
        },
      );
    }, VALIDATE_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [canValidate, projectId, text]);

  const marks = useMemo(() => marksOf(validation), [validation]);

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), queryText: text, tags: parseTags(tags) };
      return draft.id === null ? createSavedQuery(projectId, body) : updateSavedQuery(draft.id, body);
    },
    onSuccess: onDone,
  });

  const canSave = name.trim() !== '' && text.trim() !== '' && !save.isPending;

  return (
    <div className="flex flex-col gap-2 p-2 text-sm">
      <input
        aria-label="Query name"
        placeholder="Name"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
        }}
        className="h-8 rounded border border-border bg-surface px-2 text-sm text-text"
      />
      <input
        aria-label="Tags"
        placeholder="Tags, comma separated"
        value={tags}
        onChange={(e) => {
          setTags(e.target.value);
        }}
        className="h-8 rounded border border-border bg-surface px-2 text-xs text-text"
      />
      <SqlEditor value={draft.queryText} onChange={setText} marks={marks} />
      <ValidationNotes validation={validation} />
      {save.error !== null && (
        <p className="text-xs text-danger-text">
          {save.error instanceof ApiError ? save.error.message : 'Could not save the query.'}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!canSave}
          onClick={() => {
            save.mutate();
          }}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

export function ValidationNotes({ validation }: { readonly validation: QueryValidation | null }) {
  if (validation === null) return null;
  const flagged = validation.identifiers.filter((i) => FLAGGED_STATUSES.has(i.status)).length;
  return (
    <div className="flex flex-col gap-1 text-xs">
      {!isReadOnly(validation) && (
        <p role="alert" className="rounded bg-warning-subtle px-2 py-1 text-warning-text">
          Not read-only: this query contains {validation.statementKinds.join(', ')}.
        </p>
      )}
      {validation.parseErrors.map((e) => (
        <p key={`${String(e.range.start)}:${e.message}`} className="text-danger-text">
          {e.message}
        </p>
      ))}
      {flagged > 0 && (
        <p className="text-text-muted">
          {flagged} identifier{flagged === 1 ? '' : 's'} not found in the schema you can see.
        </p>
      )}
    </div>
  );
}

export function marksOf(validation: QueryValidation | null): EditorMark[] {
  if (validation === null) return [];
  const flagged = validation.identifiers
    .filter((i) => FLAGGED_STATUSES.has(i.status))
    .map((i) => ({
      from: i.range.start,
      to: i.range.end,
      message:
        i.status === 'ambiguous'
          ? `Ambiguous: ${i.text}`
          : `Unknown: ${i.text}${i.suggestions.length > 0 ? ` — did you mean ${i.suggestions.join(', ')}?` : ''}`,
    }));
  const errors = validation.parseErrors.map((e) => ({ from: e.range.start, to: e.range.end, message: e.message }));
  return [...flagged, ...errors];
}
