'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  cn,
  Loading,
  Skeleton,
  SkeletonRows,
} from '@schemaloom/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { irQueryOptions } from '@/features/canvas/ir-query';
import { isCosmeticOnly } from '@/features/history/history-api';
import { DiffBody, PlanBody } from '@/features/history/history-view';
import { relativeTime } from '@/features/projects/relative-time';
import { ApiError } from '@/lib/api-client';
import {
  BLOCKER_TEXT,
  changeRequestKey,
  changeRequestMigrationQueryOptions,
  changeRequestQueryOptions,
  changeRequestsKey,
  changeRequestsQueryOptions,
  deleteChangeRequest,
  mergeChange,
  projectShellKey,
  projectShellQueryOptions,
  proposeChange,
  reviewChange,
  setOpen,
  submitChange,
  updateFromMain,
  type ChangeRequestConflict,
  type ChangeRequestDetail,
  type ChangeRequestSummary,
} from './change-requests-api';

const errorText = (caught: unknown): string =>
  caught instanceof ApiError ? caught.message : 'Something went wrong. Try again.';

const projectHref = (orgSlug: string, projectId: string): string =>
  `/${encodeURIComponent(orgSlug)}/p/${encodeURIComponent(projectId)}`;

const requestHref = (orgSlug: string, projectId: string, id: string): string =>
  `${projectHref(orgSlug, projectId)}/changes/${encodeURIComponent(id)}`;

function StatusChip({ status }: { readonly status: ChangeRequestSummary['status'] }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10px] uppercase',
        status === 'open' && 'bg-accent-subtle text-accent',
        status === 'merged' && 'bg-success-subtle text-success-text',
        (status === 'closed' || status === 'draft') && 'bg-surface-sunken text-text-muted',
      )}
    >
      {status === 'draft' ? 'not submitted' : status}
    </span>
  );
}

// ── the project header ─────────────────────────────────────────────────────────────

/**
 * Phase 10 §1 — "Propose a change" in the canvas header, and on a draft the banner that
 * says what it is. Phase 10c: proposing opens a draft straight away; the title comes on
 * "Submit changes". The API decides who may propose (a complete view, §3).
 */
export function ChangeRequestActions({
  orgSlug,
  projectId,
}: {
  readonly orgSlug: string;
  readonly projectId: string;
}) {
  const shell = useQuery(projectShellQueryOptions(projectId));
  if (shell.data === undefined) return null;
  if (shell.data.draft === null) {
    const propose = <ProposeChangeButton orgSlug={orgSlug} projectId={projectId} />;
    if (!shell.data.requireChangeRequests) return propose;
    // Phase 10b §1: say it before anyone tries an edit.
    return (
      <span
        role="status"
        className="flex items-center gap-2 rounded border border-border bg-surface-sunken px-2 py-0.5 text-xs text-text"
      >
        <span className="font-medium">Protected</span>
        <span className="hidden text-text-muted lg:inline">
          Schema changes go through change requests.
        </span>
        {propose}
      </span>
    );
  }
  const { projectId: mainId, changeRequestId, title, status } = shell.data.draft;
  if (status === 'draft') {
    return (
      <span
        role="status"
        className="flex items-center gap-2 rounded border border-accent-border bg-accent-subtle px-2 py-0.5 text-xs text-text"
      >
        <span className="min-w-0 truncate">
          <span className="font-medium">Your draft</span>
          <span className="hidden 2xl:inline"> · not submitted yet</span>
        </span>
        <SubmitChangesButton
          orgSlug={orgSlug}
          projectId={mainId}
          requestId={changeRequestId}
          draftProjectId={projectId}
        />
        <DiscardDraftButton orgSlug={orgSlug} projectId={mainId} requestId={changeRequestId} />
        <Link
          href={projectHref(orgSlug, mainId)}
          className="shrink-0 whitespace-nowrap text-accent hover:underline"
        >
          Back to project
        </Link>
      </span>
    );
  }
  return (
    <span
      role="status"
      className="flex items-center gap-2 rounded border border-accent-border bg-accent-subtle px-2 py-0.5 text-xs text-text"
    >
      <span className="max-w-48 min-w-0 truncate">
        Draft for <span className="font-medium">{title}</span>
        {status !== 'open' && ` (${status}, read-only)`}
      </span>
      <Link
        href={requestHref(orgSlug, mainId, changeRequestId)}
        className="shrink-0 whitespace-nowrap text-accent hover:underline"
      >
        View request
      </Link>
      <Link
        href={projectHref(orgSlug, mainId)}
        className="shrink-0 whitespace-nowrap text-accent hover:underline"
      >
        Back to project
      </Link>
    </span>
  );
}

/** Opens the caller's unsubmitted draft, forking one first if there is none (Phase 10c). */
function ProposeChangeButton({
  orgSlug,
  projectId,
}: {
  readonly orgSlug: string;
  readonly projectId: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  // Other people's unsubmitted drafts never reach this list, so a `draft` here is ours.
  const list = useQuery(changeRequestsQueryOptions(projectId));
  const mine = list.data?.find((r) => r.status === 'draft');
  const propose = useMutation({
    mutationFn: () => proposeChange(projectId),
    onSuccess: async (draft) => {
      await queryClient.invalidateQueries({ queryKey: changeRequestsKey(projectId) });
      router.push(projectHref(orgSlug, draft.draftProjectId));
    },
  });
  return (
    <>
      <Button
        variant="primary"
        size="sm"
        disabled={propose.isPending}
        onClick={() => {
          if (mine === undefined) propose.mutate();
          else router.push(projectHref(orgSlug, mine.draftProjectId));
        }}
      >
        {propose.isPending
          ? 'Copying the project…'
          : mine === undefined
            ? 'Propose a change'
            : 'Continue your draft'}
      </Button>
      {propose.error !== null && (
        <span role="alert" className="text-xs text-danger-text">
          {propose.error instanceof ApiError && propose.error.status === 403
            ? 'Proposing a change needs access to every table and column in the project.'
            : errorText(propose.error)}
        </span>
      )}
    </>
  );
}

/** Phase 10c §1.4 — name the change and open it for review. */
function SubmitChangesButton({
  orgSlug,
  projectId,
  requestId,
  draftProjectId,
}: {
  readonly orgSlug: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly draftProjectId: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpenDialog] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const submit = useMutation({
    mutationFn: () =>
      submitChange(requestId, {
        title: title.trim(),
        ...(description.trim() === '' ? {} : { description: description.trim() }),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectShellKey(draftProjectId) }),
        queryClient.invalidateQueries({ queryKey: changeRequestsKey(projectId) }),
        queryClient.invalidateQueries({ queryKey: changeRequestKey(requestId) }),
      ]);
      setOpenDialog(false);
      router.push(requestHref(orgSlug, projectId, requestId));
    },
  });
  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          setOpenDialog(true);
        }}
      >
        Submit changes
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!submit.isPending) setOpenDialog(next);
        }}
      >
        <DialogContent>
          <DialogTitle>Submit changes</DialogTitle>
          <DialogDescription>
            Name the change so reviewers know what it is. They review the diff and the migration
            SQL, and an editor merges it. You can keep editing the draft after submitting.
          </DialogDescription>
          <form
            id="submit-change"
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submit.mutate();
            }}
          >
            <input
              aria-label="Title"
              placeholder="Title, e.g. Add invoices"
              value={title}
              maxLength={200}
              onChange={(e) => {
                setTitle(e.target.value);
              }}
              className="h-8 rounded border border-border bg-surface px-2 text-sm text-text"
            />
            <textarea
              aria-label="Description (optional)"
              placeholder="What and why (optional)"
              value={description}
              maxLength={10_000}
              rows={4}
              onChange={(e) => {
                setDescription(e.target.value);
              }}
              className="rounded border border-border bg-surface px-2 py-1 text-sm text-text"
            />
          </form>
          {submit.error !== null && (
            <p role="alert" className="text-xs text-danger-text">
              {errorText(submit.error)}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpenDialog(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="submit-change"
              size="sm"
              disabled={submit.isPending || title.trim() === ''}
            >
              {submit.isPending ? 'Submitting…' : 'Submit for review'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Phase 10c — throw the unsubmitted draft away (the request's delete), after a confirm. */
function DiscardDraftButton({
  orgSlug,
  projectId,
  requestId,
}: {
  readonly orgSlug: string;
  readonly projectId: string;
  readonly requestId: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const discard = useMutation({
    mutationFn: () => deleteChangeRequest(requestId),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: changeRequestKey(requestId) });
      await queryClient.invalidateQueries({ queryKey: changeRequestsKey(projectId) });
      router.push(projectHref(orgSlug, projectId));
    },
  });
  if (!confirming) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setConfirming(true);
        }}
      >
        Discard
      </Button>
    );
  }
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={discard.isPending}
        onClick={() => {
          discard.mutate();
        }}
      >
        {discard.isPending ? 'Discarding…' : 'Discard the draft'}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={discard.isPending}
        onClick={() => {
          setConfirming(false);
        }}
      >
        Keep
      </Button>
      {discard.error !== null && (
        <span role="alert" className="text-danger-text">
          {errorText(discard.error)}
        </span>
      )}
    </>
  );
}

// ── the Changes tab ────────────────────────────────────────────────────────────────

export function ChangesView({
  orgSlug,
  projectId,
}: {
  readonly orgSlug: string;
  readonly projectId: string;
}) {
  const list = useQuery(changeRequestsQueryOptions(projectId));
  if (list.error !== null) {
    return <p className="p-6 text-sm text-danger-text">{errorText(list.error)}</p>;
  }
  if (list.data === undefined) {
    return (
      <Loading className="flex flex-col gap-2 p-4">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </Loading>
    );
  }
  if (list.data.length === 0) {
    return (
      <div className="p-6">
        <h1 className="text-sm font-medium text-text">No change requests</h1>
        <p className="mt-1 text-xs text-text-muted">
          Use “Propose a change” on the canvas to edit a draft and ask for a review. Change requests
          are visible to people who can see every table and column of the project.
        </p>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-1 p-4">
      {/* Phase 10c: the caller's unsubmitted draft (only theirs reaches the list) first. */}
      {[...list.data]
        .sort((a, b) => Number(b.status === 'draft') - Number(a.status === 'draft'))
        .map((r) => {
          const approvals = r.reviews.filter((v) => v.current && v.verdict === 'approved').length;
          return (
            <li key={r.id}>
              <Link
                href={requestHref(orgSlug, projectId, r.id)}
                className="flex items-center gap-3 rounded px-3 py-2 hover:bg-surface-hover"
              >
                <StatusChip status={r.status} />
                <span className="min-w-0 flex-1 truncate text-sm text-text">
                  {r.status === 'draft' ? 'Your draft' : r.title}
                </span>
                <span className="text-xs text-text-subtle">
                  {r.author?.name ?? 'Someone'} · {relativeTime(r.createdAt)}
                  {r.status === 'open' &&
                    ` · ${String(approvals)} approval${approvals === 1 ? '' : 's'}`}
                </span>
              </Link>
            </li>
          );
        })}
    </ul>
  );
}

// ── one request ────────────────────────────────────────────────────────────────────

export function ChangeRequestView({
  orgSlug,
  projectId,
  requestId,
}: {
  readonly orgSlug: string;
  readonly projectId: string;
  readonly requestId: string;
}) {
  const request = useQuery(changeRequestQueryOptions(requestId));
  const ir = useQuery(irQueryOptions(projectId));
  const [tab, setTab] = useState<'changes' | 'sql'>('changes');

  if (request.error !== null) {
    const status = request.error instanceof ApiError ? request.error.status : 0;
    return (
      <p className="p-6 text-sm text-text-muted">
        {status === 404 ? 'This change request does not exist.' : errorText(request.error)}
      </p>
    );
  }
  const r = request.data;
  if (r === undefined) {
    return (
      <Loading className="flex flex-col gap-4 p-4">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-16" />
        <SkeletonRows rows={4} />
      </Loading>
    );
  }
  const entityName = (id: string): string | null => ir.data?.objects.entity[id]?.name ?? null;
  // What the merge would carry: schema entries, plus the moves it applies (Phase 10c §4).
  // A move main made too stays main's, so it is cosmetic here and carried by nothing.
  const changeCount = r.changes.entries.filter((e) => !isCosmeticOnly(e)).length + r.moved;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4">
      <header className="flex flex-col gap-1">
        <Link
          href={`${projectHref(orgSlug, projectId)}/changes`}
          className="text-xs text-text-muted hover:text-text"
        >
          ← Change requests
        </Link>
        <h1 className="flex items-center gap-2 text-base font-medium text-text">
          <StatusChip status={r.status} />
          {r.status === 'draft' ? 'Your draft' : r.title}
        </h1>
        <p className="text-xs text-text-subtle">
          {r.author?.name ?? 'Someone'} proposed this {relativeTime(r.createdAt)} ·{' '}
          <Link
            href={projectHref(orgSlug, r.draftProjectId)}
            className="text-accent hover:underline"
          >
            Open the draft
          </Link>
        </p>
        {r.description !== '' && (
          <p className="mt-1 text-sm whitespace-pre-wrap text-text">{r.description}</p>
        )}
      </header>

      <MergeBar request={r} orgSlug={orgSlug} />
      {r.conflicts.length > 0 && <ConflictList conflicts={r.conflicts} />}
      <Reviews request={r} />

      <nav className="flex gap-1 border-b border-border" aria-label="Request views">
        {(
          [
            ['changes', `Changes (${String(changeCount)})`],
            ['sql', 'Migration SQL'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            onClick={() => {
              setTab(id);
            }}
            className={cn(
              '-mb-px border-b-2 px-2 py-1 text-xs',
              tab === id ? 'border-accent text-text' : 'border-transparent text-text-muted',
            )}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === 'changes' && changeCount === 0 ? (
        <div role="note" className="flex flex-col gap-1 rounded border border-border p-3 text-sm">
          <p className="font-medium text-text">Nothing has changed in the draft yet.</p>
          <p className="text-xs text-text-muted">
            This request shows only edits made in its draft: the canvas with the “Draft for change
            request” banner. Edits made on the project itself are not part of it.
          </p>
          {(r.status === 'open' || r.status === 'draft') && (
            <Link
              href={projectHref(orgSlug, r.draftProjectId)}
              className="text-xs text-accent hover:underline"
            >
              Open the draft to make your changes
            </Link>
          )}
        </div>
      ) : tab === 'changes' ? (
        <>
          {r.moved > 0 && (
            <p className="text-xs text-text-muted">
              {r.moved} table{r.moved === 1 ? '' : 's'} moved on the canvas. Merging moves{' '}
              {r.moved === 1 ? 'it' : 'them'} in the project too.
            </p>
          )}
          <DiffBody diff={r.changes} hideCosmetic entityName={entityName} canvasHref={() => null} />
        </>
      ) : (
        <Migration requestId={r.id} title={r.title} />
      )}
    </div>
  );
}

function Migration({ requestId, title }: { readonly requestId: string; readonly title: string }) {
  const [allowDestructive, setAllowDestructive] = useState(false);
  const plan = useQuery(changeRequestMigrationQueryOptions(requestId, allowDestructive));
  if (plan.error !== null) {
    return (
      <p role="alert" className="text-xs text-danger-text">
        {errorText(plan.error)}
      </p>
    );
  }
  if (plan.data === undefined) {
    return <p className="text-xs text-text-subtle">Generating the migration…</p>;
  }
  return (
    <PlanBody
      plan={plan.data}
      fileName={`migration-${title}`}
      allowDestructive={allowDestructive}
      onAllowDestructive={setAllowDestructive}
    />
  );
}

/** Merge, Update from main, Close/Reopen — each disabled with the API's reason. */
function MergeBar({
  request: r,
  orgSlug,
}: {
  readonly request: ChangeRequestDetail;
  readonly orgSlug: string;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [reset, setReset] = useState<ChangeRequestConflict[] | null>(null);
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: changeRequestKey(r.id) }),
      queryClient.invalidateQueries({ queryKey: changeRequestsKey(r.projectId) }),
      queryClient.invalidateQueries({ queryKey: ['project', r.projectId, 'ir'] }),
    ]);
  };
  const merge = useMutation({
    mutationFn: () => mergeChange(r.id, r.draftRevision),
    onSettled: refresh,
  });
  const update = useMutation({
    mutationFn: () => updateFromMain(r.id),
    onSuccess: (resetObjects) => {
      setReset(resetObjects);
    },
    onSettled: refresh,
  });
  const toggle = useMutation({
    mutationFn: () => setOpen(r.id, r.status !== 'open'),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: () => deleteChangeRequest(r.id),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: changeRequestKey(r.id) });
      await queryClient.invalidateQueries({ queryKey: changeRequestsKey(r.projectId) });
      router.push(`${projectHref(orgSlug, r.projectId)}/changes`);
    },
    onSettled: () => {
      setConfirmingDelete(false);
    },
  });
  const error = merge.error ?? update.error ?? toggle.error ?? remove.error;
  const busy = merge.isPending || update.isPending || toggle.isPending || remove.isPending;

  return (
    <section
      aria-label="Merge"
      className="flex flex-col gap-2 rounded border border-border bg-surface-sunken p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        {r.status === 'open' && (
          <Button
            size="sm"
            disabled={busy || r.mergeBlockedBy !== null}
            onClick={() => {
              merge.mutate();
            }}
          >
            {merge.isPending ? 'Merging…' : 'Merge into the project'}
          </Button>
        )}
        {r.status === 'draft' && r.isAuthor && (
          <SubmitChangesButton
            orgSlug={orgSlug}
            projectId={r.projectId}
            requestId={r.id}
            draftProjectId={r.draftProjectId}
          />
        )}
        {(r.status === 'open' || r.status === 'draft') && r.isAuthor && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              update.mutate();
            }}
          >
            {update.isPending ? 'Updating…' : 'Update from main'}
          </Button>
        )}
        {r.canManage && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              toggle.mutate();
            }}
          >
            {r.status === 'open' ? 'Close' : 'Reopen'}
          </Button>
        )}
        {r.canDelete &&
          (confirmingDelete ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  remove.mutate();
                }}
              >
                {remove.isPending ? 'Deleting…' : 'Delete the request and its draft'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setConfirmingDelete(false);
                }}
              >
                Keep
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setConfirmingDelete(true);
              }}
            >
              Delete
            </Button>
          ))}
        <span className="text-xs text-text-muted">
          {r.status === 'merged'
            ? `Merged ${relativeTime(r.mergedAt ?? r.updatedAt)}.`
            : r.mergeBlockedBy === null
              ? 'Ready to merge.'
              : BLOCKER_TEXT[r.mergeBlockedBy]}
        </span>
      </div>
      {reset !== null && (
        <p className="text-xs text-text-muted">
          {reset.length === 0
            ? 'The draft is up to date with the project.'
            : `Main’s version replaced your edits to ${reset.map((c) => c.name || c.id).join(', ')}. Redo them in the draft if they still apply.`}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="text-xs text-danger-text">
          {errorText(error)}
        </p>
      )}
    </section>
  );
}

function ConflictList({ conflicts }: { readonly conflicts: readonly ChangeRequestConflict[] }) {
  return (
    <details open className="rounded border border-warning bg-warning-subtle">
      <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium text-warning-text">
        {conflicts.length} conflict{conflicts.length === 1 ? '' : 's'} with the project
      </summary>
      <ul className="flex flex-col gap-0.5 border-t border-warning px-2 py-1.5 text-xs text-text">
        {conflicts.map((c) => (
          <li key={`${c.type}:${c.id}`}>
            {c.type} <span className="font-medium">{c.name || c.id}</span> —{' '}
            <span className="text-text-muted">
              {c.reason === 'both_changed'
                ? 'changed in both the project and the draft'
                : 'no longer fits the project (what it points to was removed)'}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function Reviews({ request: r }: { readonly request: ChangeRequestDetail }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const review = useMutation({
    mutationFn: (verdict: 'approved' | 'changes_requested') => reviewChange(r.id, verdict, note),
    onSuccess: async () => {
      setNote('');
      await queryClient.invalidateQueries({ queryKey: changeRequestKey(r.id) });
    },
  });
  return (
    <section aria-label="Reviews" className="flex flex-col gap-2">
      <h2 className="text-xs font-medium text-text-muted uppercase">Reviews</h2>
      {r.reviews.length === 0 ? (
        <p className="text-xs text-text-subtle">No reviews yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {r.reviews.map((v) => (
            <li key={v.id} className={cn('text-xs text-text', !v.current && 'opacity-60')}>
              <span className="font-medium">{v.reviewer?.name ?? 'Someone'}</span>{' '}
              {v.verdict === 'approved' ? 'approved' : 'requested changes'}{' '}
              <span className="text-text-subtle">{relativeTime(v.createdAt)}</span>
              {!v.current && <span className="text-text-subtle"> · before the latest edit</span>}
              {v.note !== '' && <p className="whitespace-pre-wrap text-text-muted">{v.note}</p>}
            </li>
          ))}
        </ul>
      )}
      {r.canReview && (
        <div className="flex flex-col gap-1.5">
          <textarea
            aria-label="Review note (optional)"
            placeholder="Note (optional)"
            value={note}
            maxLength={10_000}
            rows={2}
            onChange={(e) => {
              setNote(e.target.value);
            }}
            className="rounded border border-border bg-surface px-2 py-1 text-xs text-text"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={review.isPending}
              onClick={() => {
                review.mutate('approved');
              }}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={review.isPending}
              onClick={() => {
                review.mutate('changes_requested');
              }}
            >
              Request changes
            </Button>
          </div>
          {review.error !== null && (
            <p role="alert" className="text-xs text-danger-text">
              {errorText(review.error)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
