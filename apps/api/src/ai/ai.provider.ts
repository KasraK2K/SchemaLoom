import Anthropic from '@anthropic-ai/sdk';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnv } from '../config/env';

/** One provider call: the cached prefix (system prompt + SCS), the per-mode instructions,
 *  and the replayed transcript. */
export interface AiRequest {
  /** stable per project and view — the `cache_control` prefix (doc 03 §13.1: SCS is
   *  deterministic, so the same view hits the same cache entry) */
  readonly prefix: string;
  /** per-mode output instructions; after the breakpoint, so a mode switch keeps the cache */
  readonly instructions: string;
  readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
}

export interface AiResult {
  readonly text: string;
  /** `end_turn`, `max_tokens`, `refusal`, … */
  readonly stopReason: string | null;
  readonly model: string;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
}

/**
 * DESIGN §4.1 — the one place `@anthropic-ai/sdk` is named. A Nest provider so specs override
 * it (`{ provide: AiProvider, useValue: stub }`) and nothing reaches the network in a test.
 *
 * Opus with adaptive thinking and server-side `fallbacks: "default"`: a policy decline is
 * retried on a fallback model inside the same call, and only a refusal of the whole chain
 * comes back as `stop_reason: "refusal"`, which callers must check.
 */
@Injectable()
export class AiProvider {
  private readonly client: Anthropic | null;
  readonly model: string;

  constructor(config: ConfigService<AppEnv, true>) {
    const apiKey = config.get('ANTHROPIC_API_KEY', { infer: true });
    this.model = config.get('AI_MODEL', { infer: true });
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
  }

  get configured(): boolean {
    return this.client !== null;
  }

  /** 503 `ai_not_configured` (DESIGN §4.1). Every AI route calls it AFTER its 404/403
   *  checks and before any write, so a permission answer never depends on server config. */
  assertConfigured(): void {
    if (!this.configured) throw new ServiceUnavailableException({ code: 'ai_not_configured' });
  }

  /** Streams text deltas to `onText` and resolves with the whole response. */
  async stream(request: AiRequest, onText: (text: string) => void, signal?: AbortSignal): Promise<AiResult> {
    const client = this.client;
    if (client === null) throw new ServiceUnavailableException({ code: 'ai_not_configured' });
    const stream = client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: 16_000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        system: [
          { type: 'text', text: request.prefix, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: request.instructions },
        ],
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      },
      { signal },
    );
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') onText(event.delta.text);
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
}
