'use client';

import type { Id } from '@schemaloom/schema-model';
import { Button } from '@schemaloom/ui';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import type { JSONContent } from '@tiptap/react';
import { useState } from 'react';
import { useTerminology } from '@/engines';
import { fetchMe } from '@/features/auth/security-api';
import { irQueryOptions } from '@/features/canvas/ir-query';
import { useCanvasStore } from '@/features/canvas/store';
import { relativeTime } from '@/features/projects/relative-time';
import { ApiError } from '@/lib/api-client';
import { CommentComposer, RichText } from './comment-composer';
import {
  commentCountsQueryOptions,
  commentsKey,
  commentsQueryOptions,
  createComment,
  deleteComment,
  mentionCandidatesQueryOptions,
  setResolved,
  toThreads,
  updateComment,
  type CommentTarget,
  type CommentView,
  type MentionCandidate,
  type Thread,
} from './comments-api';

/**
 * Phase 4 DESIGN §3.2 — the Comments tab for the selected table or column. Open threads
 * first, resolved ones collapsed. Everything here is what the API already redacted for
 * this reader; a restricted stub has no comments to show.
 */
export function CommentsPanel({ projectId }: { readonly projectId: Id }) {
  const { data: model } = useSuspenseQuery(irQueryOptions(projectId));
  const t = useTerminology();
  const selection = useCanvasStore((s) => s.selection);
  const selectedFieldId = useCanvasStore((s) => s.selectedFieldId);

  const only = selection.size === 1 ? [...selection][0] : undefined;
  const entity = only === undefined ? undefined : model.objects.entity[only];
  const field = selectedFieldId === null ? undefined : model.objects.field[selectedFieldId];
  if (entity === undefined) {
    return (
      <p className="p-2 text-sm text-text-muted">{t.msg('inspector.noSelection', 'entity')}</p>
    );
  }
  if (entity.restricted === true || field?.restricted === true) {
    return <p className="p-2 text-sm text-text-subtle">restricted</p>;
  }
  const target: CommentTarget =
    field === undefined
      ? { targetType: 'entity', targetId: entity.id }
      : { targetType: 'field', targetId: field.id };
  const noun = t.term(field === undefined ? 'entity' : 'field').one.toLowerCase();
  return (
    <TargetComments
      key={`${target.targetType}:${target.targetId}`}
      projectId={projectId}
      target={target}
      title={field === undefined ? entity.name : `${entity.name}.${field.name}`}
      noun={noun}
    />
  );
}

/** The open-thread count for the tab label; counted server-side over visible targets (L8). */
export function CommentsTabCount({ projectId }: { readonly projectId: Id }) {
  const selection = useCanvasStore((s) => s.selection);
  const { data } = useQuery(commentCountsQueryOptions(projectId));
  const only = selection.size === 1 ? [...selection][0] : undefined;
  const count = only === undefined ? 0 : (data?.[only] ?? 0);
  return count === 0 ? null : <span className="ml-1 text-xs text-text-subtle">{count}</span>;
}

function TargetComments({
  projectId,
  target,
  title,
  noun,
}: {
  readonly projectId: Id;
  readonly target: CommentTarget;
  readonly title: string;
  readonly noun: string;
}) {
  const queryClient = useQueryClient();
  const comments = useQuery(commentsQueryOptions(projectId, target));
  const candidates = useQuery(mentionCandidatesQueryOptions(projectId, target));
  const me = useQuery({ queryKey: ['auth', 'me'], queryFn: fetchMe });
  const refresh = () => queryClient.invalidateQueries({ queryKey: commentsKey(projectId) });
  const post = useMutation({
    mutationFn: (body: { parentId?: string; content: JSONContent }) =>
      createComment(projectId, { ...target, ...body }),
    onSuccess: refresh,
  });

  if (comments.isPending) return <p className="p-2 text-sm text-text-subtle">Loading…</p>;
  if (comments.isError) {
    const gone = comments.error instanceof ApiError && comments.error.status === 404;
    return (
      <p className="p-2 text-sm text-text-subtle">
        {gone ? 'restricted' : 'Comments could not be loaded.'}
      </p>
    );
  }
  const { open, resolved } = toThreads(comments.data);
  const shared = {
    projectId,
    noun,
    candidates: candidates.data ?? [],
    selfId: me.data?.id ?? null,
    refresh,
    reply: (parentId: string, content: JSONContent) => post.mutateAsync({ parentId, content }),
  };

  return (
    <div className="flex flex-col gap-3 p-2">
      <p className="truncate text-xs text-text-subtle">{title}</p>
      {open.length === 0 && resolved.length === 0 ? (
        <p className="text-sm text-text-muted">No comments yet.</p>
      ) : null}
      {open.map((thread) => (
        <ThreadCard key={thread.root.id} thread={thread} {...shared} />
      ))}
      <CommentComposer
        candidates={shared.candidates}
        selfId={shared.selfId}
        noun={noun}
        submitLabel="Comment"
        busy={post.isPending}
        onSubmit={(content) => post.mutateAsync({ content })}
      />
      {post.isError ? (
        <p role="alert" className="text-xs text-danger-text">
          Could not post the comment.
        </p>
      ) : null}
      {resolved.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-text-muted">Resolved ({resolved.length})</summary>
          <div className="mt-2 flex flex-col gap-3">
            {resolved.map((thread) => (
              <ThreadCard key={thread.root.id} thread={thread} {...shared} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

interface Shared {
  readonly projectId: Id;
  readonly noun: string;
  readonly candidates: readonly MentionCandidate[];
  readonly selfId: string | null;
  readonly refresh: () => Promise<void>;
  readonly reply: (parentId: string, content: JSONContent) => Promise<unknown>;
}

function ThreadCard({ thread, ...shared }: { readonly thread: Thread } & Shared) {
  const [replying, setReplying] = useState(false);
  const { root } = thread;
  const toggle = useMutation({
    mutationFn: () => setResolved(root.id, root.resolvedAt === null),
    onSuccess: shared.refresh,
  });
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-2">
      <CommentItem comment={root} {...shared} />
      {thread.replies.map((c) => (
        <div key={c.id} className="border-l-2 border-border pl-2">
          <CommentItem comment={c} {...shared} />
        </div>
      ))}
      {replying ? (
        <CommentComposer
          candidates={shared.candidates}
          selfId={shared.selfId}
          noun={shared.noun}
          submitLabel="Reply"
          busy={false}
          onSubmit={async (content) => {
            await shared.reply(root.id, content);
            setReplying(false);
          }}
          onCancel={() => {
            setReplying(false);
          }}
        />
      ) : (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setReplying(true);
            }}
          >
            Reply
          </Button>
          {root.canResolve ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={toggle.isPending}
              onClick={() => {
                toggle.mutate();
              }}
            >
              {root.resolvedAt === null ? 'Resolve' : 'Reopen'}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function CommentItem({ comment, ...shared }: { readonly comment: CommentView } & Shared) {
  const [editing, setEditing] = useState(false);
  const edit = useMutation({
    mutationFn: (content: JSONContent) => updateComment(comment.id, content),
    onSuccess: async () => {
      setEditing(false);
      await shared.refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteComment(comment.id),
    onSuccess: shared.refresh,
  });

  if (comment.deleted) return <p className="text-sm text-text-subtle italic">Comment deleted</p>;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-text-subtle">
        <span className="font-medium text-text">{comment.author?.name ?? 'Deleted user'}</span>{' '}
        {relativeTime(comment.createdAt)}
      </p>
      {editing ? (
        <CommentComposer
          candidates={shared.candidates}
          selfId={shared.selfId}
          noun={shared.noun}
          initial={comment.content}
          submitLabel="Save"
          busy={edit.isPending}
          onSubmit={(content) => edit.mutateAsync(content)}
          onCancel={() => {
            setEditing(false);
          }}
        />
      ) : (
        <RichText doc={comment.content} />
      )}
      {comment.canEdit && !editing ? (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditing(true);
            }}
          >
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm('Delete this comment?')) remove.mutate();
            }}
          >
            Delete
          </Button>
        </div>
      ) : null}
    </div>
  );
}
