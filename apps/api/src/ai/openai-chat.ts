import type { AiProviderType } from '../ai-integrations/abilities';
import type { AiRequest, AiResult } from './ai.provider';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

/** The streamed chunk fields read here (a subset of the SDK's ChatCompletionChunk). */
export interface ChatChunk {
  readonly model?: string;
  readonly choices: readonly {
    readonly delta: { readonly content?: string | null };
    readonly finish_reason: string | null;
  }[];
  readonly usage?: { readonly prompt_tokens: number; readonly completion_tokens: number } | null;
}
/** The subset of the `openai` client used, so specs pass a stub. */
export interface ChatClient {
  readonly chat: {
    readonly completions: {
      create(body: object, opts?: { signal?: AbortSignal }): Promise<AsyncIterable<ChatChunk>>;
    };
  };
  readonly models: { list(): AsyncIterable<{ readonly id: string }> };
}

/**
 * Roadmap 24 §4.1 — OpenAI, Gemini and OpenAI-compatible servers. The prefix goes first and
 * unchanged so automatic prefix caching can apply. No reasoning_effort (PLAN "narrowings").
 */
export function toChatBody(provider: AiProviderType, model: string, request: AiRequest): object {
  // OpenAI renamed the field; Gemini's endpoint and most compatible servers know only the old one.
  const limit = provider === 'openai' ? 'max_completion_tokens' : 'max_tokens';
  return {
    model,
    stream: true,
    stream_options: { include_usage: true },
    [limit]: request.maxTokens ?? 16_000,
    messages: [
      { role: 'system', content: request.prefix },
      { role: 'system', content: request.instructions },
      ...request.messages.map((m) => ({ role: m.role, content: m.content })),
    ],
  };
}

const STOP: Record<string, string> = {
  content_filter: 'refusal',
  length: 'max_tokens',
  stop: 'end_turn',
};

export async function streamChat(
  client: ChatClient,
  provider: AiProviderType,
  model: string,
  request: AiRequest,
  onText: (text: string) => void,
  signal?: AbortSignal,
): Promise<AiResult> {
  const stream = await client.chat.completions.create(toChatBody(provider, model, request), {
    signal,
  });
  let text = '';
  let finish: string | null = null;
  let answeredBy = model;
  let usage: ChatChunk['usage'] = null;
  for await (const chunk of stream) {
    if (chunk.model !== undefined) answeredBy = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    for (const choice of chunk.choices) {
      const delta = choice.delta.content ?? '';
      if (delta !== '') {
        text += delta;
        onText(delta);
      }
      if (choice.finish_reason !== null) finish = choice.finish_reason;
    }
  }
  return {
    text,
    stopReason: finish === null ? null : (STOP[finish] ?? finish),
    model: answeredBy,
    tokensIn: usage?.prompt_tokens ?? null,
    tokensOut: usage?.completion_tokens ?? null,
  };
}

export function scrubKey(text: string, key: string | null): string {
  return key === null || key === '' ? text : text.split(key).join('***');
}
