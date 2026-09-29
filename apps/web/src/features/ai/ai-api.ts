import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiError, apiFetch, apiResponse } from '@/lib/api-client';

/**
 * The AI assistant routes (`apps/api/src/ai`, DESIGN §4.2). Every response is parsed: it is a
 * network payload.
 */

const metadataSchema = z.object({
  assumptions: z.array(z.string()),
  validation: z.object({ ok: z.boolean(), unknownIdentifiers: z.array(z.string()) }).nullable(),
  usedEntityIds: z.array(z.string()),
  suggestedEntityIds: z.array(z.string()),
  finishReason: z.string().nullable(),
});

export const aiMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  ordinal: z.number(),
  content: z.string(),
  queryText: z.string().nullable(),
  explanation: z.string(),
  metadata: metadataSchema,
  createdAt: z.string(),
});
export type AiMessage = z.infer<typeof aiMessageSchema>;

const selectionSchema = z.object({
  entityIds: z.array(z.string()),
  fieldIds: z.array(z.string()),
  linkIds: z.array(z.string()),
  areaIds: z.array(z.string()),
});

export const aiThreadSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  selection: selectionSchema,
  lastMessageAt: z.string().nullable(),
  createdAt: z.string(),
});
export type AiThread = z.infer<typeof aiThreadSchema>;

const threadWithMessagesSchema = aiThreadSchema.extend({ messages: z.array(aiMessageSchema) });

export const docDraftSchema = z.object({
  id: z.string(),
  targetType: z.enum(['entity', 'field']),
  targetId: z.string(),
  plainText: z.string(),
  createdAt: z.string(),
});
export type DocDraft = z.infer<typeof docDraftSchema>;

export type AiMode = 'query' | 'explain';

export const aiThreadsKey = (projectId: string): readonly unknown[] => [
  'project',
  projectId,
  'ai-threads',
];
export const aiThreadKey = (threadId: string): readonly unknown[] => ['ai-thread', threadId];
export const docDraftsKey = (projectId: string): readonly unknown[] => [
  'project',
  projectId,
  'doc-drafts',
];

export function aiThreadsQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: aiThreadsKey(projectId),
    queryFn: async (): Promise<AiThread[]> =>
      z
        .object({ threads: z.array(aiThreadSchema) })
        .parse(await apiFetch<unknown>(`/projects/${projectId}/ai/threads`)).threads,
    retry: false,
  });
}

export function aiThreadQueryOptions(threadId: string) {
  return queryOptions({
    queryKey: aiThreadKey(threadId),
    queryFn: async () =>
      threadWithMessagesSchema.parse(await apiFetch<unknown>(`/ai/threads/${threadId}`)),
    retry: false,
  });
}

export async function createThread(
  projectId: string,
  entityIds: readonly string[],
  title: string,
): Promise<AiThread> {
  return aiThreadSchema.parse(
    await apiFetch<unknown>(`/projects/${projectId}/ai/threads`, {
      method: 'POST',
      body: { selection: { entityIds, fieldIds: [], linkIds: [], areaIds: [] }, title },
    }),
  );
}

export function docDraftsQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: docDraftsKey(projectId),
    queryFn: async (): Promise<DocDraft[]> =>
      z
        .object({ drafts: z.array(docDraftSchema) })
        .parse(await apiFetch<unknown>(`/projects/${projectId}/ai/doc-drafts`)).drafts,
    retry: false,
  });
}

export async function queueDocDrafts(
  projectId: string,
  entityIds: readonly string[],
): Promise<void> {
  await apiFetch<unknown>(`/projects/${projectId}/ai/doc-drafts`, {
    method: 'POST',
    body: { entityIds },
  });
}

export async function reviewDocDraft(id: string, verdict: 'accept' | 'reject'): Promise<void> {
  await apiFetch<unknown>(`/ai/doc-drafts/${id}/${verdict}`, { method: 'POST' });
}

export async function draftSchema(
  projectId: string,
  description: string,
): Promise<{ source: string; importFormat: string }> {
  return z.object({ source: z.string(), importFormat: z.string() }).parse(
    await apiFetch<unknown>(`/projects/${projectId}/ai/draft-schema`, {
      method: 'POST',
      body: { description },
    }),
  );
}

// --- server-sent events -------------------------------------------------------------------

export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/** Incremental `text/event-stream` framing: `event:`/`data:` lines, a blank line ends one. */
export function createSseParser(): { push(chunk: string): SseEvent[] } {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk.replace(/\r\n?/g, '\n');
      const events: SseEvent[] = [];
      for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        events.push({ event, data: data.join('\n') });
      }
      return events;
    },
  };
}

export type StreamEvent =
  | { readonly type: 'block-open' | 'block-close'; readonly tag: string }
  | { readonly type: 'block-delta'; readonly tag: string; readonly text: string }
  | { readonly type: 'done'; readonly message: AiMessage }
  | { readonly type: 'error'; readonly code: string };

/** POST a turn and hand each event to `onEvent` as it arrives. Refusals (403/429/503…)
 *  throw an `ApiError` before any event, exactly like `apiFetch`. */
export async function streamMessage(
  threadId: string,
  body: { content: string; mode: AiMode },
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await apiResponse(`/ai/threads/${threadId}/messages`, {
    method: 'POST',
    body,
    signal,
  });
  const reader = response.body?.getReader();
  if (reader === undefined) return;
  const decoder = new TextDecoder();
  const parser = createSseParser();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
      const data: unknown = JSON.parse(frame.data);
      if (frame.event === 'done') onEvent({ type: 'done', message: aiMessageSchema.parse(data) });
      else if (frame.event === 'error')
        onEvent({ type: 'error', code: z.object({ code: z.string() }).parse(data).code });
      else if (frame.event === 'block-delta')
        onEvent({
          type: 'block-delta',
          ...z.object({ tag: z.string(), text: z.string() }).parse(data),
        });
      else if (frame.event === 'block-open' || frame.event === 'block-close') {
        onEvent({ type: frame.event, tag: z.object({ tag: z.string() }).parse(data).tag });
      }
    }
  }
}

/** The three statuses DESIGN §4.4 names, in words. */
export function aiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 503 && error.code === 'ai_not_configured')
      return 'AI is not configured on this server.';
    if (error.status === 403) {
      return error.code === 'ai_disabled'
        ? 'AI is turned off for this project.'
        : 'You don’t have AI access for this selection.';
    }
    if (error.status === 429) {
      const retry = (error.details as { retryAfter?: unknown } | undefined)?.retryAfter;
      const minutes = typeof retry === 'number' ? Math.max(1, Math.ceil(retry / 60)) : null;
      return minutes === null
        ? 'Too many AI requests. Try again later.'
        : `Too many AI requests. Try again in ${String(minutes)} min.`;
    }
    if (error.status === 404) return 'This conversation is no longer available.';
    if (error.code === 'ai_selection_unavailable')
      return 'The tables this conversation was about no longer exist.';
  }
  return 'The assistant could not answer. Try again.';
}
