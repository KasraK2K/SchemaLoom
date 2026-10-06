'use client';

import { SchemaModelSchema, type Id, type Point } from '@schemaloom/schema-model';
import { Button, X } from '@schemaloom/ui';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useEngine } from '@/engines';
import type { DraftPreview } from '@/features/ai/ai-api';
import { DraftReview, useSchemaDraft, type GhostHover } from '@/features/ai/describe-schema';
import {
  changeRequestsKey,
  projectShellQueryOptions,
  proposeChange,
} from '@/features/change-requests/change-requests-api';
import {
  detectImportFormat,
  importInto,
  importSourceName,
} from '@/features/projects/create-project';
import { ApiError, apiFetch } from '@/lib/api-client';
import { nextAreaToken } from './area-color';
import { groupOps, moveOps, nextOrdinal } from './area-ops';
import { postGeometry } from './geometry';
import { postOps } from './schema-ops';

/**
 * Phase 22b D2 — Describe with AI, docked beside the canvas so the ghosts stay in view.
 * Kept mounted while hidden (Q3): closing clears the ghosts, reopening shows the last draft
 * again until the page is left. Nothing is written before Import or Propose (D5).
 *
 * Import goes straight to the additive import without the rename question: the AI is told
 * never to rename (DRAFT_SCHEMA_RULES), so a candidate here is a lookalike, and "Keep both"
 * was already the default.
 */
export function DescribePanel({
  projectId,
  open,
  focus,
  tableCount,
  proposeOnly,
  positions,
  hover,
  onPreview,
  onClose,
  onImported,
}: {
  readonly projectId: Id;
  readonly open: boolean;
  /** the canvas selection the AI connects to (Phase 22 §1.1 step 1) */
  readonly focus: readonly { readonly id: Id; readonly name: string }[];
  /** visible tables, for "Build on" */
  readonly tableCount: number;
  /** a protected project (row 10b): the draft can only become a change request */
  readonly proposeOnly: boolean;
  /** where the canvas placed the ghosts, by draft key */
  readonly positions: ReadonlyMap<string, Point> | null;
  readonly hover: GhostHover;
  readonly onPreview: (preview: DraftPreview | null) => void;
  readonly onClose: () => void;
  /** after Import: how many statements were not applied */
  readonly onImported: (notApplied: number) => Promise<void>;
}) {
  const formats = useEngine().capabilities.importFormats;
  const [description, setDescription] = useState('');
  const [source, setSource] = useState('');
  const draft = useSchemaDraft(source, setSource);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Q5 — offered to everyone who drafts, except inside a change request's own draft.
  const shell = useQuery(projectShellQueryOptions(projectId));
  const canPropose = shell.data?.draft === null;
  const { orgSlug } = useParams<{ orgSlug?: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();

  useEffect(() => {
    onPreview(open ? draft.preview : null);
  }, [open, draft.preview, onPreview]);
  // Opening the panel puts the cursor in the box (the toolbar, the menu, the empty canvas).
  const box = useRef<HTMLTextAreaElement>(null);
  const focusKey = focus.map((f) => f.id).join();
  useEffect(() => {
    if (open) box.current?.focus();
  }, [open, focusKey]);

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

  /** The draft into `target`, then its tables where their ghosts were. */
  const importDraft = async (target: Id) => {
    const imported = await importInto(target, source, [], detectImportFormat(source, formats));
    if (draft.preview !== null && positions !== null)
      await placeDraft(queryClient, target, draft.preview, positions);
    return imported;
  };

  const submit = () => {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const imported = await importDraft(projectId);
        const notApplied = imported.report.statements.filter(
          (s) => s.status !== 'applied' && s.status !== 'ignored',
        ).length;
        draft.reset();
        setDescription('');
        await onImported(notApplied);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Try again.');
      } finally {
        setBusy(false);
      }
    })();
  };

  /** Phase 22 §1.1 step 4 — fork (or reuse) the caller's draft, import there, open it. */
  const propose = () => {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const request = await proposeChange(projectId);
        await importDraft(request.draftProjectId);
        await queryClient.invalidateQueries({ queryKey: changeRequestsKey(projectId) });
        router.push(
          `/${encodeURIComponent(orgSlug ?? '')}/p/${encodeURIComponent(request.draftProjectId)}`,
        );
      } catch (caught) {
        setError(
          caught instanceof ApiError && caught.status === 403
            ? 'Proposing a change needs access to every table and column in the project.'
            : caught instanceof ApiError
              ? caught.message
              : 'Something went wrong. Try again.',
        );
        setBusy(false);
      }
    })();
  };

  return (
    <aside
      aria-label="Describe with AI"
      hidden={!open}
      className="flex w-96 max-w-[45vw] shrink-0 flex-col gap-3 overflow-y-auto border-l border-border bg-surface p-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text">Describe with AI</h2>
        <button
          type="button"
          aria-label="Close"
          title="Close (the draft is kept until you leave the page)"
          disabled={busy}
          onClick={onClose}
          className="rounded p-1 text-text-subtle hover:bg-surface-hover hover:text-text"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        Describe a schema
        <textarea
          rows={3}
          ref={box}
          value={description}
          maxLength={10_000}
          disabled={busy}
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
          variant="outline"
          disabled={description.trim() === '' || draft.pending || busy}
          onClick={() => {
            draft.draft(projectId, body).catch(() => undefined);
          }}
        >
          {draft.pending && !draft.drafted ? 'Drafting…' : 'Draft SQL with AI'}
        </Button>
      </div>
      {draft.error !== null && (
        <span role="alert" className="text-xs text-danger-text">
          {draft.error}
        </span>
      )}
      {draft.drafted && (
        <>
          <DraftReview
            draft={draft}
            hover={hover}
            onRefine={(instruction) =>
              draft.refine(
                projectId,
                { ...body, description: body.description || 'Revise this schema.' },
                instruction,
              )
            }
          />
          <details className="text-xs text-text-muted">
            <summary className="cursor-pointer">Show SQL</summary>
            <textarea
              rows={12}
              aria-label={importSourceName(formats)}
              value={source}
              disabled={busy}
              onChange={(e) => {
                setSource(e.target.value);
              }}
              className="mt-2 w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-text"
            />
          </details>
          {error !== null && (
            <p role="alert" className="text-xs text-danger-text">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy || draft.pending}
              onClick={draft.reset}
            >
              Discard
            </Button>
            {canPropose && (
              <Button
                type="button"
                size="sm"
                variant={proposeOnly ? 'primary' : 'outline'}
                disabled={busy || draft.pending || source === ''}
                title="Import the draft into a change request and review it on a canvas first"
                onClick={propose}
              >
                Propose as a change
              </Button>
            )}
            {!proposeOnly && (
              <Button
                type="button"
                size="sm"
                variant="primary"
                disabled={busy || draft.pending || source === ''}
                onClick={submit}
              >
                {busy ? 'Importing…' : 'Import'}
              </Button>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

/**
 * D4 — the new tables land where their ghosts were: one geometry batch by name (the import
 * leaves new tables at the origin, so only those are matched), then the draft's area (Q2)
 * as one ops batch, joining an area of the same name if the project has one.
 */
export async function placeDraft(
  queryClient: QueryClient,
  projectId: Id,
  preview: DraftPreview,
  positions: ReadonlyMap<string, Point>,
): Promise<void> {
  // Not through the IR query cache: the canvas would draw the new tables at the origin first.
  const model = SchemaModelSchema.parse(await apiFetch<unknown>(`/projects/${projectId}/ir`));
  const fresh = Object.values(model.objects.entity).filter(
    (e) => e.restricted !== true && e.position.x === 0 && e.position.y === 0,
  );
  const entries = preview.tables.flatMap((t) => {
    const position = positions.get(t.key);
    const entity = fresh.find((e) => e.name === t.name);
    return position === undefined || entity === undefined ? [] : [{ id: entity.id, position }];
  });
  if (entries.length > 0) await postGeometry(projectId, entries);
  if (preview.area === null || entries.length === 0) return;
  const ids = entries.map((e) => e.id);
  const areas = Object.values(model.objects.area);
  const same = areas.find((a) => a.name.toLowerCase() === preview.area?.toLowerCase());
  await postOps(
    queryClient,
    projectId,
    same === undefined
      ? groupOps(model, ids, {
          id: crypto.randomUUID(),
          name: preview.area,
          color: nextAreaToken(areas),
          ordinal: nextOrdinal(areas),
        })
      : moveOps(model, ids, same.id),
    'AI draft area',
  );
}
