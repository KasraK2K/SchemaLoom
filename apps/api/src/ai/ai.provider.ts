import Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable, Optional, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type { AiProviderType } from '../ai-integrations/abilities';
import { guardedFetch } from '../ai-integrations/guarded-fetch';
import type { AppEnv } from '../config/env';
import { GEMINI_BASE_URL, scrubKey, streamChat, type ChatClient } from './openai-chat';

/** One provider call: the cached prefix (system prompt + SCS), the per-mode instructions,
 *  and the replayed transcript. */
export interface AiRequest {
  /** stable per project and view — the `cache_control` prefix (doc 03 §13.1: SCS is
   *  deterministic, so the same view hits the same cache entry) */
  readonly prefix: string;
  /** per-mode output instructions; after the breakpoint, so a mode switch keeps the cache */
  readonly instructions: string;
  readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
  /** output budget, thinking included; default 16,000 */
  readonly maxTokens?: number;
}

export interface AiResult {
  readonly text: string;
  /** `end_turn`, `max_tokens`, `refusal`, … */
  readonly stopReason: string | null;
  readonly model: string;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
}

export interface AiTarget {
  readonly integrationId: string;
  readonly source: 'server' | 'custom';
  readonly provider: AiProviderType;
  readonly model: string;
  /** decrypted for this call only; env key for the server row; null for a keyless openai_compatible */
  readonly apiKey: string | null;
  readonly baseUrl: string | null;
  /** a member's own integration: never reaches a private host, whatever AI_ALLOW_PRIVATE_HOSTS says */
  readonly personal: boolean;
}

/** `listModels` (the test-connection button) answers within 10 s or fails (§4.4). */
type ClientLimits = { timeout: number; maxRetries: number } | Record<string, never>;
const LIST_LIMITS = { timeout: 10_000, maxRetries: 0 };
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
/** Models that take `fallbacks: "default"` on the Claude API (claude-api skill, 2026-10). */
const FALLBACK_MODELS = [
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
];
/** Claude 3.x and 4.0–4.5 (Haiku 4.5 included) take no adaptive thinking. */
const PRE_ADAPTIVE = /^claude-(3|(opus|sonnet|haiku)-4(-[0-5])?(-\d{8}|@|$))/;

/** Test seam: specs build fake clients; production binds nothing and builds real ones per call. */
export const AI_CLIENT_FACTORIES = Symbol('AI_CLIENT_FACTORIES');
export interface AiClientFactories {
  readonly openai?: (opts: {
    apiKey: string;
    baseURL?: string;
    organization: null;
    project: null;
    fetch?: typeof fetch;
    timeout?: number;
    maxRetries?: number;
  }) => ChatClient;
  readonly anthropic?: (opts: {
    apiKey: string;
    baseURL?: string;
    authToken?: null;
    timeout?: number;
    maxRetries?: number;
  }) => Anthropic;
}

/**
 * DESIGN §4.1 + roadmap 24 §4 — the one place AI SDKs are named. A client is built per call
 * from the resolved target; decrypted keys live only for that call. The server row passes
 * no baseURL, so the SDK still reads ANTHROPIC_BASE_URL (the e2e fake); a custom Anthropic
 * integration pins the public API so a stray env var never redirects a member's key.
 * A Nest provider so specs override it (`{ provide: AiProvider, useValue: stub }`) and
 * nothing reaches the network in a test.
 *
 * Anthropic branch: adaptive thinking (4.6+) and, on the models in FALLBACK_MODELS, server-side
 * `fallbacks: "default"` (Claude API only): a policy decline is
 * retried on a fallback model inside the same call, and only a refusal of the whole chain
 * comes back as `stop_reason: "refusal"`, which callers must check.
 */
@Injectable()
export class AiProvider {
  constructor(
    private readonly config: ConfigService<AppEnv, true>,
    @Optional() @Inject(AI_CLIENT_FACTORIES) private readonly factories: AiClientFactories = {},
  ) {}

  /** Streams text deltas to `onText` and resolves with the whole response. */
  async stream(
    target: AiTarget,
    request: AiRequest,
    onText: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<AiResult> {
    try {
      return target.provider === 'anthropic'
        ? await this.streamAnthropic(target, request, onText, signal)
        : await streamChat(
            this.chatClient(target, {}),
            target.provider,
            target.model,
            request,
            onText,
            signal,
          );
    } catch (error) {
      throw this.mapError(error, target.apiKey);
    }
  }

  async listModels(target: Omit<AiTarget, 'model' | 'integrationId'>): Promise<string[]> {
    try {
      const ids: string[] = [];
      const list =
        target.provider === 'anthropic'
          ? this.anthropic(target, LIST_LIMITS).models.list()
          : this.chatClient(target, LIST_LIMITS).models.list();
      for await (const m of list) ids.push(m.id);
      return ids.sort();
    } catch (error) {
      throw this.mapError(error, target.apiKey);
    }
  }

  private anthropic(
    target: Pick<AiTarget, 'source' | 'apiKey'>,
    limits: ClientLimits = {},
  ): Anthropic {
    const opts = {
      apiKey: target.apiKey ?? '',
      // A custom key never pairs with an env ANTHROPIC_AUTH_TOKEN or ANTHROPIC_BASE_URL.
      ...(target.source === 'custom'
        ? { baseURL: 'https://api.anthropic.com', authToken: null }
        : {}),
      ...limits,
    };
    return this.factories.anthropic?.(opts) ?? new Anthropic(opts);
  }

  private chatClient(
    target: Pick<AiTarget, 'provider' | 'apiKey' | 'baseUrl' | 'personal'>,
    limits: ClientLimits,
  ): ChatClient {
    const allowPrivate =
      !target.personal && this.config.get('AI_ALLOW_PRIVATE_HOSTS', { infer: true });
    const opts = {
      // A keyless local server still needs a non-empty string for the SDK.
      apiKey: target.apiKey ?? 'none',
      // Pinned so OPENAI_BASE_URL / OPENAI_ORG_ID / OPENAI_PROJECT_ID never reach a tenant call.
      ...(target.provider === 'openai' ? { baseURL: OPENAI_BASE_URL } : {}),
      ...(target.provider === 'gemini' ? { baseURL: GEMINI_BASE_URL } : {}),
      organization: null,
      project: null,
      ...(target.provider === 'openai_compatible' && target.baseUrl !== null
        ? { baseURL: target.baseUrl, fetch: guardedFetch(allowPrivate) }
        : {}),
      ...limits,
    };
    return this.factories.openai?.(opts) ?? new OpenAI(opts);
  }

  private async streamAnthropic(
    target: AiTarget,
    request: AiRequest,
    onText: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<AiResult> {
    const stream = this.anthropic(target).beta.messages.stream(
      {
        model: target.model,
        max_tokens: request.maxTokens ?? 16_000,
        ...(FALLBACK_MODELS.some((m) => target.model === m || target.model.startsWith(`${m}-`))
          ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
          : {}),
        ...(PRE_ADAPTIVE.test(target.model) ? {} : { thinking: { type: 'adaptive' as const } }),
        system: [
          { type: 'text', text: request.prefix, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: request.instructions },
        ],
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      },
      { signal },
    );
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta')
        onText(event.delta.text);
    }
    const message = await stream.finalMessage();
    const text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    return {
      text,
      stopReason: message.stop_reason,
      model: message.model,
      tokensIn: message.usage.input_tokens,
      tokensOut: message.usage.output_tokens,
    };
  }

  /** Context-length failures become 422. Anything else with a key in play is rebuilt as a
   *  fresh Error (message scrubbed, numeric status kept) so the key cannot ride out on the
   *  stack, the provider body (`.error`), headers or `cause`. */
  private mapError(error: unknown, key: string | null): unknown {
    const e = (error ?? {}) as {
      code?: unknown;
      error?: { error?: { code?: unknown } };
      message?: unknown;
      status?: unknown;
    };
    const text = typeof e.message === 'string' ? e.message : '';
    if (
      e.code === 'context_length_exceeded' ||
      e.error?.error?.code === 'context_length_exceeded' ||
      /prompt is too long|maximum context length/i.test(text)
    ) {
      return new UnprocessableEntityException({ code: 'ai_context_too_small' });
    }
    if (key === null || key === '') return error;
    const safe = new Error(
      scrubKey(typeof e.message === 'string' ? e.message : String(error), key),
    );
    if (typeof e.status === 'number') Object.assign(safe, { status: e.status });
    return safe;
  }
}
