'use client';

import { Button } from '@schemaloom/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEngine } from '@/engines';
import { irQueryOptions } from '@/features/canvas/ir-query';
import { useCanvasStore } from '@/features/canvas/store';
import { createSavedQuery, savedQueriesKey, validateQuery } from '@/features/queries/queries-api';
import { ValidationNotes, marksOf } from '@/features/queries/queries-panel';
import { SqlEditor } from '@/features/queries/sql-editor';
import {
  aiErrorMessage,
  aiThreadKey,
  aiThreadQueryOptions,
  aiThreadsKey,
  aiThreadsQueryOptions,
  createThread,
  docDraftsKey,
  docDraftsQueryOptions,
  ORMS,
  ormCodeQueryOptions,
  queueDocDrafts,
  reviewDocDraft,
  streamMessage,
  type AiMessage,
  type AiMode,
  type OrmId,
} from './ai-api';

/**
 * DESIGN §4.4 — the AI tab: threads started from the canvas selection, a composer with
 * Ask / Explain, the streamed answer, and the doc-draft review queue.
 *
 * The server decides what the model sees (the caller's redacted view of the selection);
 * nothing here narrows or widens it. "Tables used" and "add suggested tables" only move the
 * canvas selection.
 */
export function AiPanel({ projectId }: { readonly projectId: string }) {
  const queryClient = useQueryClient();
  const selection = useCanvasStore((s) => s.selection);
  const [threadId, setThreadId] = useState<string | null>(null);
  const threads = useQuery(aiThreadsQueryOptions(projectId));

  const start = useMutation({
    mutationFn: () => {
      const ids = [...selection];
      return createThread(
        projectId,
        ids,
        ids.length === 0 ? 'Whole schema' : `${String(ids.length)} selected`,
      );
    },
    onSuccess: (thread) => {
      void queryClient.invalidateQueries({ queryKey: aiThreadsKey(projectId) });
      setThreadId(thread.id);
    },
  });

  if (threads.error !== null) {
    return <p className="p-2 text-xs text-text-muted">{aiErrorMessage(threads.error)}</p>;
  }

  if (threadId !== null) {
    return (
      <ThreadView
        projectId={projectId}
        threadId={threadId}
        onBack={() => {
          setThreadId(null);
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3 p-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-text-muted">
          {selection.size === 0
            ? 'No selection: the whole schema you can see'
            : `${String(selection.size)} selected`}
        </span>
        <Button
          size="sm"
          disabled={start.isPending}
          onClick={() => {
            start.mutate();
          }}
        >
          New conversation
        </Button>
      </div>
      {start.error !== null && (
        <p role="alert" className="text-xs text-danger-text">
          {aiErrorMessage(start.error)}
        </p>
      )}
      {(threads.data ?? []).length === 0 ? (
        <p className="text-xs text-text-subtle">No conversations yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {(threads.data ?? []).map((t) => (
            <li key={t.id}>
              <button
                type="button"
                className="w-full rounded px-2 py-1 text-left text-sm hover:bg-surface-hover"
                onClick={() => {
                  setThreadId(t.id);
                }}
              >
                {t.title}
              </button>
            </li>
          ))}
        </ul>
      )}
      <DocDrafts projectId={projectId} selection={[...selection]} />
    </div>
  );
}

interface Live {
  readonly query: string;
  readonly explanation: string;
  readonly assumptions: string;
  readonly code: string;
}
const NO_LIVE: Live = { query: '', explanation: '', assumptions: '', code: '' };
const LIVE_TAGS = new Set<string>(['query', 'explanation', 'assumptions', 'code']);

const MODES: readonly { readonly id: AiMode; readonly label: string }[] = [
  { id: 'query', label: 'Ask' },
  { id: 'explain', label: 'Explain' },
  { id: 'code', label: 'Code' },
];

/** Phase 18 Q4 — the last ORM picked, per browser; storage can be missing or refuse. */
const ORM_KEY = 'schemaloom.ai.orm';

function useRememberedOrm(available: readonly OrmId[]): [OrmId | null, (orm: OrmId) => void] {
  const [orm, setOrm] = useState<OrmId | null>(available[0] ?? null);
  useEffect(() => {
    try {
      const saved = available.find((o) => o === window.localStorage.getItem(ORM_KEY));
      if (saved !== undefined) setOrm(saved);
    } catch {
      // private window or blocked storage: keep the first ORM
    }
  }, [available]);
  const choose = (next: OrmId) => {
    setOrm(next);
    try {
      window.localStorage.setItem(ORM_KEY, next);
    } catch {
      // not remembered, which is fine
    }
  };
  return [orm, choose];
}

function CodeBlock({ text, label }: { readonly text: string; readonly label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre
        aria-label={label}
        className="max-h-72 overflow-auto rounded-md border border-border bg-surface p-2 font-mono text-[11px]"
      >
        {text}
      </pre>
      <Button
        size="sm"
        variant="ghost"
        className="absolute top-1 right-1"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
          });
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

/** Phase 18 §2.1 — the exporter's model code for the thread's tables; no AI call. Without
 *  `export:run` the route refuses and the pane simply isn't there. */
function ModelsPane({
  projectId,
  orm,
  entityIds,
}: {
  readonly projectId: string;
  readonly orm: OrmId;
  readonly entityIds: readonly string[];
}) {
  const models = useQuery(ormCodeQueryOptions(projectId, orm, entityIds));
  if (models.error !== null) return null;
  const label = ORMS.find((o) => o.id === orm)?.label ?? orm;
  return (
    <details open className="flex flex-col gap-1 text-xs">
      <summary className="cursor-pointer text-text-muted">Models ({label})</summary>
      {models.data === undefined ? (
        <p className="text-text-subtle">Loading…</p>
      ) : (
        <>
          <CodeBlock text={models.data.text} label={`${label} models`} />
          {models.data.incomplete && (
            <p className="text-text-muted">Some objects are not included because of your access.</p>
          )}
        </>
      )}
    </details>
  );
}

function ThreadView({
  projectId,
  threadId,
  onBack,
}: {
  readonly projectId: string;
  readonly threadId: string;
  readonly onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const thread = useQuery(aiThreadQueryOptions(threadId));
  const exportFormats = useEngine().capabilities.exportFormats;
  const orms = useMemo(
    () => ORMS.filter((o) => exportFormats.some((f) => f.id === o.id)).map((o) => o.id),
    [exportFormats],
  );
  const [orm, setOrm] = useRememberedOrm(orms);
  const [mode, setMode] = useState<AiMode>('query');
  const [content, setContent] = useState('');
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const send = async (): Promise<void> => {
    setError(null);
    setLive(NO_LIVE);
    abort.current = new AbortController();
    try {
      await streamMessage(
        threadId,
        mode === 'code' && orm !== null ? { content, mode, orm } : { content, mode },
        (event) => {
          if (event.type === 'block-delta' && LIVE_TAGS.has(event.tag)) {
            const tag = event.tag as keyof Live;
            setLive((prev) => ({
              ...(prev ?? NO_LIVE),
              [tag]: (prev ?? NO_LIVE)[tag] + event.text,
            }));
          }
          if (event.type === 'error') setError(aiErrorMessage(null));
          if (event.type === 'done') setContent('');
        },
        abort.current.signal,
      );
    } catch (e: unknown) {
      setError(aiErrorMessage(e));
    } finally {
      setLive(null);
      void queryClient.invalidateQueries({ queryKey: aiThreadKey(threadId) });
    }
  };

  if (thread.error !== null) {
    return (
      <div className="flex flex-col gap-2 p-2 text-sm">
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← Conversations
        </Button>
        <p className="text-xs text-text-muted">{aiErrorMessage(thread.error)}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-2 text-sm">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← Conversations
        </Button>
        <span className="truncate text-xs text-text-muted">{thread.data?.title}</span>
      </div>
      {(thread.data?.messages ?? []).map((m) =>
        m.role === 'user' ? (
          <p key={m.id} className="rounded bg-surface-sunken px-2 py-1 text-xs whitespace-pre-wrap">
            {m.content}
          </p>
        ) : (
          <AssistantMessage
            key={m.id}
            projectId={projectId}
            title={thread.data?.title ?? 'AI query'}
            message={m}
          />
        ),
      )}
      {live !== null && (
        <div aria-live="polite" className="flex flex-col gap-1 text-xs">
          {live.explanation !== '' && <p>{live.explanation.trim()}</p>}
          {live.code !== '' && (
            <pre className="overflow-auto rounded-md border border-border bg-surface p-2 font-mono">
              {live.code.trim()}
            </pre>
          )}
          {live.query !== '' && live.code === '' && (
            <pre className="overflow-auto rounded-md border border-border bg-surface p-2 font-mono">
              {live.query.trim()}
            </pre>
          )}
          {live.query === '' && live.explanation === '' && live.code === '' && (
            <p className="text-text-subtle">Thinking…</p>
          )}
        </div>
      )}
      {error !== null && (
        <p role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      )}
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <div role="radiogroup" aria-label="Mode" className="flex gap-1">
            {(orms.length > 0 ? MODES : MODES.filter((m) => m.id !== 'code')).map((m) => (
              <Button
                key={m.id}
                type="button"
                size="sm"
                variant={mode === m.id ? 'primary' : 'ghost'}
                role="radio"
                aria-checked={mode === m.id}
                onClick={() => {
                  setMode(m.id);
                }}
              >
                {m.label}
              </Button>
            ))}
          </div>
          {mode === 'code' && orm !== null && (
            <select
              aria-label="ORM"
              value={orm}
              onChange={(e) => {
                setOrm(e.target.value as OrmId);
              }}
              className="rounded-md border border-border bg-surface px-1 py-0.5 text-xs text-text"
            >
              {ORMS.filter((o) => orms.includes(o.id)).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </div>
        {mode === 'code' && orm !== null && thread.data !== undefined && (
          <ModelsPane projectId={projectId} orm={orm} entityIds={thread.data.selection.entityIds} />
        )}
        <textarea
          aria-label={
            mode === 'query'
              ? 'Question'
              : mode === 'code'
                ? 'What the code should do'
                : 'Query to explain'
          }
          placeholder={
            mode === 'query'
              ? 'Ask about the selected tables…'
              : mode === 'code'
                ? 'Orders over $100 with their customer’s email…'
                : 'Paste a query to explain…'
          }
          rows={mode === 'query' ? 3 : 6}
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
          }}
          className={`rounded-md border border-border bg-surface px-2 py-1 text-xs text-text ${mode === 'explain' ? 'font-mono' : ''}`}
        />
        <div className="flex justify-end">
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={live !== null || content.trim() === ''}
          >
            {live !== null ? 'Answering…' : 'Send'}
          </Button>
        </div>
      </form>
    </div>
  );
}

function AssistantMessage({
  projectId,
  title,
  message,
}: {
  readonly projectId: string;
  readonly title: string;
  readonly message: AiMessage;
}) {
  const queryClient = useQueryClient();
  const canValidate = useEngine().capabilities.features.queryValidation;
  const query = message.queryText;
  const validation = useQuery({
    queryKey: ['ai-validate', message.id],
    queryFn: () => validateQuery(projectId, query ?? ''),
    enabled: canValidate && query !== null,
    staleTime: Infinity,
    retry: false,
  });
  const marks = useMemo(() => marksOf(validation.data ?? null), [validation.data]);
  const save = useMutation({
    mutationFn: () =>
      createSavedQuery(projectId, {
        name: title.slice(0, 200),
        queryText: query ?? '',
        tags: ['ai'],
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: savedQueriesKey(projectId) }),
  });
  const { usedEntityIds, suggestedEntityIds, assumptions } = message.metadata;

  return (
    <div className="flex flex-col gap-2 text-xs">
      {message.explanation !== '' && <p className="whitespace-pre-wrap">{message.explanation}</p>}
      {message.metadata.finishReason === 'refusal' && (
        <p className="text-text-muted">The assistant declined this request.</p>
      )}
      {message.code !== null && (
        <CodeBlock
          text={message.code}
          label={`${ORMS.find((o) => o.id === message.metadata.orm)?.label ?? 'ORM'} code`}
        />
      )}
      {query !== null &&
        (message.metadata.orm === null ? (
          <SqlEditor value={query} onChange={() => undefined} marks={marks} />
        ) : (
          <details>
            <summary className="cursor-pointer text-text-muted">Show SQL</summary>
            <SqlEditor value={query} onChange={() => undefined} marks={marks} />
          </details>
        ))}
      <ValidationNotes validation={validation.data ?? null} />
      {assumptions.length > 0 && (
        <ul className="list-disc pl-4 text-text-muted" aria-label="Assumptions">
          {assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-1">
        {usedEntityIds.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              useCanvasStore.getState().select(usedEntityIds, 'replace');
            }}
          >
            Tables used ({usedEntityIds.length})
          </Button>
        )}
        {suggestedEntityIds.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              useCanvasStore.getState().select(suggestedEntityIds, 'extend');
            }}
          >
            Add suggested tables ({suggestedEntityIds.length})
          </Button>
        )}
        {query !== null && (
          <Button
            size="sm"
            variant="ghost"
            disabled={save.isPending || save.isSuccess}
            onClick={() => {
              save.mutate();
            }}
          >
            {save.isSuccess ? 'Saved' : 'Save query'}
          </Button>
        )}
      </div>
    </div>
  );
}

/** "Draft docs with AI" over the selection, and the accept / reject queue it fills. */
function DocDrafts({
  projectId,
  selection,
}: {
  readonly projectId: string;
  readonly selection: readonly string[];
}) {
  const queryClient = useQueryClient();
  const drafts = useQuery(docDraftsQueryOptions(projectId));
  const { data: model } = useQuery(irQueryOptions(projectId));
  const label = (type: 'entity' | 'field', id: string): string => {
    const objects = model?.objects;
    if (type === 'entity') return objects?.entity[id]?.name ?? 'table';
    const field = objects?.field[id];
    return field === undefined
      ? 'column'
      : `${objects?.entity[field.entityId]?.name ?? ''}.${field.name}`;
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: docDraftsKey(projectId) });
  const queue = useMutation({ mutationFn: () => queueDocDrafts(projectId, selection) });
  const review = useMutation({
    mutationFn: ({ id, verdict }: { id: string; verdict: 'accept' | 'reject' }) =>
      reviewDocDraft(id, verdict),
    onSettled: refresh,
  });

  return (
    <section className="flex flex-col gap-2 border-t border-border pt-2" aria-label="Doc drafts">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">Documentation drafts</span>
        <Button
          size="sm"
          variant="ghost"
          disabled={selection.length === 0 || queue.isPending}
          onClick={() => {
            queue.mutate();
          }}
        >
          Draft docs with AI
        </Button>
      </div>
      {queue.isSuccess && <p className="text-xs text-text-muted">Drafting in the background…</p>}
      {queue.error !== null && (
        <p className="text-xs text-danger-text">{aiErrorMessage(queue.error)}</p>
      )}
      {review.error !== null && (
        <p className="text-xs text-danger-text">Could not review that draft.</p>
      )}
      {(drafts.data ?? []).map((d) => (
        <div key={d.id} className="flex flex-col gap-1 rounded border border-border p-2 text-xs">
          <span className="font-mono text-text-muted">{label(d.targetType, d.targetId)}</span>
          <p className="whitespace-pre-wrap">{d.plainText}</p>
          <div className="flex justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                review.mutate({ id: d.id, verdict: 'reject' });
              }}
            >
              Reject
            </Button>
            <Button
              size="sm"
              onClick={() => {
                review.mutate({ id: d.id, verdict: 'accept' });
              }}
            >
              Accept
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}
