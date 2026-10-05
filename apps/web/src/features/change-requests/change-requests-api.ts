import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { diffSchema, migrationSchema } from '@/features/history/history-api';
import { apiFetch } from '@/lib/api-client';

/**
 * Phase 10 — the change-request routes (`apps/api/src/snapshots/change-requests.*`).
 * Every response is parsed: it is a network payload.
 */

/** Phase 10c: `draft` is forked but not submitted yet, and only its author ever sees it. */
const STATUSES = ['draft', 'open', 'merged', 'closed'] as const;

const person = z.object({ id: z.string(), name: z.string() }).nullable();

const reviewSchema = z.object({
  id: z.string(),
  reviewer: person,
  verdict: z.enum(['approved', 'changes_requested']),
  note: z.string(),
  current: z.boolean(),
  createdAt: z.string(),
});
export type ChangeRequestReview = z.infer<typeof reviewSchema>;

export const summarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  draftProjectId: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(STATUSES),
  author: person,
  /** Roadmap 21b — proposed by an AI agent through this token */
  viaToken: z.object({ name: z.string() }).nullable().default(null),
  reviewerIds: z.array(z.string()),
  reviews: z.array(reviewSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  mergedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
});
export type ChangeRequestSummary = z.infer<typeof summarySchema>;

const conflictSchema = z.object({
  type: z.string(),
  id: z.string(),
  name: z.string(),
  reason: z.string(),
});
export type ChangeRequestConflict = z.infer<typeof conflictSchema>;

export const MERGE_BLOCKERS = [
  'not_submitted',
  'not_open',
  'no_changes',
  'conflicts',
  'changes_requested',
  'needs_approval',
  'forbidden',
] as const;

export const detailSchema = summarySchema.extend({
  changes: diffSchema,
  conflicts: z.array(conflictSchema),
  /** Tables the draft moved; a merge moves them in the project too (Phase 10c §4). */
  moved: z.number().default(0),
  draftRevision: z.string(),
  mergeBlockedBy: z.enum(MERGE_BLOCKERS).nullable(),
  canReview: z.boolean(),
  canManage: z.boolean(),
  canDelete: z.boolean().default(false),
  isAuthor: z.boolean(),
});
export type ChangeRequestDetail = z.infer<typeof detailSchema>;

/** `GET /projects/:id`'s `draft` and Phase 10b's flag: all the canvas banner needs. */
const shellSchema = z.object({
  name: z.string(),
  requireChangeRequests: z.boolean().default(false),
  draft: z
    .object({
      projectId: z.string(),
      changeRequestId: z.string(),
      title: z.string(),
      status: z.enum(STATUSES),
    })
    .nullable()
    .optional(),
});

const enc = encodeURIComponent;

export const changeRequestsKey = (projectId: string): readonly unknown[] => [
  'project',
  projectId,
  'change-requests',
];
export const changeRequestKey = (id: string): readonly unknown[] => ['change-request', id];

export function changeRequestsQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: changeRequestsKey(projectId),
    queryFn: async () =>
      z
        .array(summarySchema)
        .parse(await apiFetch<unknown>(`/projects/${enc(projectId)}/change-requests`)),
    retry: false,
  });
}

export function changeRequestQueryOptions(id: string) {
  return queryOptions({
    queryKey: changeRequestKey(id),
    queryFn: async () => detailSchema.parse(await apiFetch<unknown>(`/change-requests/${enc(id)}`)),
    retry: false,
  });
}

export function changeRequestMigrationQueryOptions(id: string, allowDestructive: boolean) {
  return queryOptions({
    queryKey: [...changeRequestKey(id), 'migration', allowDestructive],
    queryFn: async () =>
      migrationSchema.parse(
        await apiFetch<unknown>(
          `/change-requests/${enc(id)}/migration?allowDestructive=${String(allowDestructive)}`,
        ),
      ),
    retry: false,
  });
}

export const projectShellKey = (projectId: string): readonly unknown[] => [
  'project',
  projectId,
  'shell',
];

/** The project's name, whether it is a draft (and of what), and whether it is protected. */
export function projectShellQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: projectShellKey(projectId),
    queryFn: async () => {
      const shell = shellSchema.parse(await apiFetch<unknown>(`/projects/${enc(projectId)}`));
      return {
        name: shell.name,
        draft: shell.draft ?? null,
        requireChangeRequests: shell.requireChangeRequests,
      };
    },
    retry: false,
    staleTime: 60_000,
  });
}

/** Phase 10c: no title opens the caller's unsubmitted draft, forking one if needed. */
export async function proposeChange(
  projectId: string,
  body: { title?: string; description?: string } = {},
): Promise<ChangeRequestSummary> {
  return summarySchema.parse(
    await apiFetch<unknown>(`/projects/${enc(projectId)}/change-requests`, {
      method: 'POST',
      body,
    }),
  );
}

/** Phase 10c: name an unsubmitted draft and open it for review. */
export async function submitChange(
  id: string,
  body: { title: string; description?: string },
): Promise<ChangeRequestSummary> {
  return summarySchema.parse(
    await apiFetch<unknown>(`/change-requests/${enc(id)}/submit`, { method: 'POST', body }),
  );
}

export async function reviewChange(
  id: string,
  verdict: ChangeRequestReview['verdict'],
  note: string,
): Promise<void> {
  await apiFetch<unknown>(`/change-requests/${enc(id)}/reviews`, {
    method: 'POST',
    body: { verdict, ...(note.trim() === '' ? {} : { note: note.trim() }) },
  });
}

export async function mergeChange(id: string, expectedDraftRevision: string): Promise<void> {
  await apiFetch<unknown>(`/change-requests/${enc(id)}/merge`, {
    method: 'POST',
    body: { expectedDraftRevision },
  });
}

export async function updateFromMain(id: string): Promise<ChangeRequestConflict[]> {
  const result = z
    .object({ reset: z.array(conflictSchema) })
    .parse(
      await apiFetch<unknown>(`/change-requests/${enc(id)}/update-from-main`, { method: 'POST' }),
    );
  return result.reset;
}

export async function setOpen(id: string, open: boolean): Promise<void> {
  await apiFetch<unknown>(`/change-requests/${enc(id)}/${open ? 'reopen' : 'close'}`, {
    method: 'POST',
  });
}

/** Unmerged and unreviewed only; the draft goes with it. */
export async function deleteChangeRequest(id: string): Promise<void> {
  await apiFetch<unknown>(`/change-requests/${enc(id)}`, { method: 'DELETE' });
}

/** What the page says instead of a disabled Merge button with no reason. */
export const BLOCKER_TEXT: Readonly<Record<(typeof MERGE_BLOCKERS)[number], string>> = {
  not_submitted: 'Not submitted yet. Submit the changes to ask for a review.',
  not_open: 'This request is not open.',
  no_changes: 'The draft has no changes to merge yet.',
  conflicts: 'The project changed the same objects. Update from main first.',
  changes_requested: 'A reviewer asked for changes.',
  needs_approval: 'Needs an approval from someone other than the author.',
  forbidden: 'You can’t edit this project, so you can’t merge into it.',
};
