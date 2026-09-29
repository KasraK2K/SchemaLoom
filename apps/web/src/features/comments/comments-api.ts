import type { CommentTargetType } from '@schemaloom/contracts';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from '@/lib/api-client';

/** Wire shapes of `apps/api/src/comments`. Parsed, not cast: they are network payloads. */

const authorSchema = z.object({
  id: z.string().nullable(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
});

export const commentSchema = z.object({
  id: z.string(),
  rootId: z.string(),
  parentId: z.string().nullable(),
  author: authorSchema.nullable(),
  /** A TipTap document, already redacted for this reader by the API. */
  content: z.record(z.string(), z.unknown()),
  deleted: z.boolean(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  canEdit: z.boolean(),
  canResolve: z.boolean(),
});
export type CommentView = z.infer<typeof commentSchema>;

const candidateSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
});
export type MentionCandidate = z.infer<typeof candidateSchema>;

export interface CommentTarget {
  readonly targetType: CommentTargetType;
  readonly targetId: string;
}

export interface Thread {
  readonly root: CommentView;
  readonly replies: readonly CommentView[];
}

/** Every comment query of a project shares this prefix, so one `comments:changed` or a
 *  write can invalidate the thread list and the counts together. */
export const commentsKey = (projectId: string): readonly unknown[] => [
  'project',
  projectId,
  'comments',
];

const qs = (t: CommentTarget): string =>
  `targetType=${encodeURIComponent(t.targetType)}&targetId=${encodeURIComponent(t.targetId)}`;

export function commentsQueryOptions(projectId: string, target: CommentTarget) {
  return queryOptions({
    queryKey: [...commentsKey(projectId), 'list', target.targetType, target.targetId],
    queryFn: async (): Promise<CommentView[]> =>
      z
        .object({ comments: z.array(commentSchema) })
        .parse(await apiFetch<unknown>(`/projects/${projectId}/comments?${qs(target)}`)).comments,
  });
}

export function commentCountsQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: [...commentsKey(projectId), 'counts'],
    queryFn: async (): Promise<Record<string, number>> =>
      z
        .object({ counts: z.record(z.string(), z.number()) })
        .parse(await apiFetch<unknown>(`/projects/${projectId}/comments/counts`)).counts,
  });
}

export function mentionCandidatesQueryOptions(projectId: string, target: CommentTarget) {
  return queryOptions({
    queryKey: [...commentsKey(projectId), 'candidates', target.targetType, target.targetId],
    queryFn: async (): Promise<MentionCandidate[]> =>
      z
        .object({ users: z.array(candidateSchema) })
        .parse(
          await apiFetch<unknown>(
            `/projects/${projectId}/comments/mention-candidates?${qs(target)}`,
          ),
        ).users,
  });
}

export async function createComment(
  projectId: string,
  body: CommentTarget & { parentId?: string; content: unknown },
): Promise<CommentView> {
  return commentSchema.parse(
    await apiFetch<unknown>(`/projects/${projectId}/comments`, { method: 'POST', body }),
  );
}

export async function updateComment(id: string, content: unknown): Promise<CommentView> {
  return commentSchema.parse(
    await apiFetch<unknown>(`/comments/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { content },
    }),
  );
}

export async function deleteComment(id: string): Promise<void> {
  await apiFetch<unknown>(`/comments/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function setResolved(id: string, resolved: boolean): Promise<void> {
  await apiFetch<unknown>(
    `/comments/${encodeURIComponent(id)}/${resolved ? 'resolve' : 'reopen'}`,
    {
      method: 'POST',
    },
  );
}

/** Open threads first (oldest first), then resolved ones. Replies stay in time order. */
export function toThreads(comments: readonly CommentView[]): {
  open: Thread[];
  resolved: Thread[];
} {
  const replies = new Map<string, CommentView[]>();
  for (const c of comments) {
    if (c.id === c.rootId) continue;
    replies.set(c.rootId, [...(replies.get(c.rootId) ?? []), c]);
  }
  const threads = comments
    .filter((c) => c.id === c.rootId)
    .map((root) => ({ root, replies: replies.get(root.id) ?? [] }));
  return {
    open: threads.filter((t) => t.root.resolvedAt === null),
    resolved: threads.filter((t) => t.root.resolvedAt !== null),
  };
}

/** User ids an editor document @-mentions (the `mention` node of `@tiptap/extension-mention`). */
export function mentionsIn(doc: unknown): { id: string; label: string }[] {
  const out = new Map<string, string>();
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const n = node as {
      type?: unknown;
      attrs?: { id?: unknown; label?: unknown };
      content?: unknown;
    };
    if (n.type === 'mention' && typeof n.attrs?.id === 'string') {
      out.set(n.attrs.id, typeof n.attrs.label === 'string' ? n.attrs.label : n.attrs.id);
    }
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(doc);
  return [...out].map(([id, label]) => ({ id, label }));
}
