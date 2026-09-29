'use client';

import type { FieldDocFacts } from '@schemaloom/contracts';
import { Button, X } from '@schemaloom/ui';
import { useQueryClient } from '@tanstack/react-query';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api-client';
import {
  docQueryOptions,
  docSchema,
  fieldFacts,
  writeDoc,
  type DocTarget,
  type DocView,
} from './docs-api';

/** Quiet time after the last keystroke before a save; blur saves at once. */
const SAVE_DELAY_MS = 1500;

const inputClass =
  'min-w-0 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text disabled:opacity-60';

type Status = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Phase 5 DESIGN §1 — one target's doc: a TipTap editor (StarterKit, the same set the API
 * sanitises to) and, for a column, the structured facts. Saves on blur and after a pause,
 * sending the version it last read; a `409 stale_version` offers theirs or overwrite.
 * Read-only without `docs:edit` (`canEdit`, or a 403 on save).
 *
 * A newer server copy (another writer, arriving through the IR's refreshed `DocRef`)
 * replaces the editor only while the local copy is clean and unfocused.
 */
export function DocEditor({
  projectId,
  target,
  doc,
  withFacts,
}: {
  readonly projectId: string;
  readonly target: DocTarget;
  readonly doc: DocView;
  readonly withFacts: boolean;
}) {
  const queryClient = useQueryClient();
  const queryKey = docQueryOptions(projectId, target).queryKey;
  const version = useRef(doc.version);
  const dirty = useRef(false);
  const inFlight = useRef(false);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [facts, setFacts] = useState<FieldDocFacts>(() => fieldFacts(doc));
  const factsRef = useRef(facts);
  factsRef.current = facts;
  const [forbidden, setForbidden] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [conflict, setConflict] = useState<DocView | null>(null);
  const readOnly = !doc.canEdit || forbidden;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  // Read through a ref by the editor's callbacks, which are bound once.
  const saveRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const schedule = () => {
    dirty.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveRef.current(), SAVE_DELAY_MS);
  };
  const flush = () => {
    clearTimeout(timer.current);
    void saveRef.current();
  };

  const editor = useEditor({
    immediatelyRender: false,
    editable: !readOnly,
    content: doc.content,
    extensions: [StarterKit.configure({ link: { openOnClick: false } })],
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'Documentation',
        class:
          'prose-sm min-h-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text focus:outline-none [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_pre]:rounded [&_pre]:bg-surface-sunken [&_pre]:p-2 [&_pre]:font-mono [&_pre]:text-xs',
      },
    },
    onUpdate: schedule,
    onBlur: flush,
  });

  saveRef.current = async () => {
    if (!dirty.current || editor === null || readOnlyRef.current || conflict !== null) return;
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    dirty.current = false;
    setStatus('saving');
    try {
      const saved = await writeDoc(projectId, target, {
        content: editor.getJSON(),
        ...(withFacts ? { structured: factsRef.current } : {}),
        version: version.current,
      });
      version.current = saved.version;
      queryClient.setQueryData(queryKey, saved);
      setStatus('saved');
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 403) {
        setForbidden(true);
        setStatus('idle');
      } else if (caught instanceof ApiError && caught.code === 'stale_version') {
        const current = docSchema.safeParse(
          (caught.details as { current?: unknown } | undefined)?.current,
        );
        setConflict(current.success ? current.data : null);
        dirty.current = true;
        setStatus('idle');
      } else {
        dirty.current = true;
        setStatus('error');
      }
    } finally {
      inFlight.current = false;
    }
    if (again.current) {
      again.current = false;
      await saveRef.current();
    }
  };

  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);

  // A newer server copy: take it only when nothing local would be lost.
  useEffect(() => {
    if (editor === null || doc.version <= version.current || dirty.current || editor.isFocused)
      return;
    version.current = doc.version;
    editor.commands.setContent(doc.content, { emitUpdate: false });
    setFacts(fieldFacts(doc));
  }, [doc, editor]);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );

  const resolve = (keepMine: boolean) => {
    if (conflict === null || editor === null) return;
    version.current = conflict.version;
    setConflict(null);
    if (keepMine) {
      // Scheduled, not flushed: this render's `saveRef` still sees the conflict.
      schedule();
      return;
    }
    dirty.current = false;
    editor.commands.setContent(conflict.content, { emitUpdate: false });
    setFacts(fieldFacts(conflict));
    queryClient.setQueryData(queryKey, conflict);
  };

  const editFacts = (next: FieldDocFacts) => {
    setFacts(next);
    factsRef.current = next;
    schedule();
  };

  return (
    <div className="space-y-3">
      <EditorContent editor={editor} />
      {withFacts ? (
        <FactsForm facts={facts} readOnly={readOnly} onChange={editFacts} onBlur={flush} />
      ) : null}
      {conflict === null ? null : (
        <div
          role="alert"
          className="space-y-1 rounded bg-warning-subtle px-2 py-1.5 text-xs text-warning-text"
        >
          <p>Someone else changed this doc while you were editing.</p>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                resolve(false);
              }}
            >
              Load theirs
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                resolve(true);
              }}
            >
              Keep mine
            </Button>
          </div>
        </div>
      )}
      <p className="text-xs text-text-subtle" role="status">
        {readOnly
          ? 'Read-only: you cannot edit documentation here.'
          : status === 'saving'
            ? 'Saving…'
            : status === 'saved'
              ? 'Saved'
              : status === 'error'
                ? 'Not saved. It will retry on the next change.'
                : ''}
      </p>
    </div>
  );
}

/** Business meaning, allowed values (value → meaning), examples (one per line), unit. */
function FactsForm({
  facts,
  readOnly,
  onChange,
  onBlur,
}: {
  readonly facts: FieldDocFacts;
  readonly readOnly: boolean;
  readonly onChange: (next: FieldDocFacts) => void;
  readonly onBlur: () => void;
}) {
  const setValue = (i: number, patch: Partial<FieldDocFacts['allowedValues'][number]>) => {
    onChange({
      ...facts,
      allowedValues: facts.allowedValues.map((v, j) => (j === i ? { ...v, ...patch } : v)),
    });
  };
  return (
    <fieldset className="space-y-2 text-xs" disabled={readOnly} onBlur={onBlur}>
      <label className="flex flex-col gap-1">
        <span className="font-medium text-text-muted">Business meaning</span>
        <textarea
          className={`${inputClass} min-h-12`}
          maxLength={4000}
          value={facts.businessMeaning}
          onChange={(e) => {
            onChange({ ...facts, businessMeaning: e.target.value });
          }}
        />
      </label>
      <div className="space-y-1">
        <span className="font-medium text-text-muted">Allowed values</span>
        {facts.allowedValues.map((v, i) => (
          <div key={i} className="flex gap-1">
            <input
              aria-label="Value"
              className={`${inputClass} w-24 font-mono`}
              maxLength={200}
              value={v.value}
              onChange={(e) => {
                setValue(i, { value: e.target.value });
              }}
            />
            <input
              aria-label="Meaning"
              className={`${inputClass} flex-1`}
              maxLength={500}
              value={v.meaning}
              onChange={(e) => {
                setValue(i, { meaning: e.target.value });
              }}
            />
            <button
              type="button"
              aria-label="Remove value"
              className="rounded p-1 text-text-subtle hover:bg-surface-hover hover:text-danger-text"
              onClick={() => {
                onChange({
                  ...facts,
                  allowedValues: facts.allowedValues.filter((_, j) => j !== i),
                });
              }}
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        ))}
        {readOnly || facts.allowedValues.length >= 200 ? null : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onChange({
                ...facts,
                allowedValues: [...facts.allowedValues, { value: '', meaning: '' }],
              });
            }}
          >
            Add value
          </Button>
        )}
      </div>
      <label className="flex flex-col gap-1">
        <span className="font-medium text-text-muted">Examples (one per line)</span>
        <textarea
          className={`${inputClass} min-h-12 font-mono`}
          value={facts.examples.join('\n')}
          onChange={(e) => {
            onChange({ ...facts, examples: e.target.value.split('\n').slice(0, 20) });
          }}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-medium text-text-muted">Unit</span>
        <input
          className={`${inputClass} w-32`}
          maxLength={50}
          value={facts.unit ?? ''}
          onChange={(e) => {
            onChange({ ...facts, unit: e.target.value === '' ? null : e.target.value });
          }}
        />
      </label>
    </fieldset>
  );
}
