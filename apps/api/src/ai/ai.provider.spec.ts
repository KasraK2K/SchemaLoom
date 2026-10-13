import { describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type OpenAI from 'openai';
import type { AppEnv } from '../config/env';
import { AiProvider, type AiTarget } from './ai.provider';
import type { ChatClient } from './openai-chat';

// Compile-time check: the real SDK client is assignable to ChatClient (no cast in the provider).
export const _sdkIsChatClient = (c: OpenAI): ChatClient => c;
const noModels = () => ({
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true as const, value: undefined }),
  }),
});

const config = {
  get: (k: string) => (k === 'AI_ALLOW_PRIVATE_HOSTS' ? false : undefined),
} as unknown as ConfigService<AppEnv, true>;
const REQ = {
  prefix: 'p',
  instructions: 'i',
  messages: [{ role: 'user' as const, content: 'q' }],
};
const target = (over: Partial<AiTarget>): AiTarget => ({
  integrationId: 'i1',
  source: 'custom',
  provider: 'openai',
  model: 'gpt-x',
  apiKey: 'sk-secret',
  baseUrl: null,
  personal: false,
  ...over,
});

describe('AiProvider dispatch (roadmap 24 §4.1)', () => {
  it('sends openai, gemini and openai_compatible through the chat adapter with pinned options', async () => {
    const made: object[] = [];
    const provider = new AiProvider(config, {
      openai: ({ fetch: f, ...opts }) => {
        made.push({ ...opts, hasFetch: f !== undefined });
        return {
          chat: {
            completions: {
              create: () =>
                Promise.resolve(
                  (async function* () {
                    await Promise.resolve();
                    yield {
                      model: 'gpt-x',
                      choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
                    };
                  })(),
                ),
            },
          },
          models: { list: noModels },
        };
      },
    });
    await provider.stream(target({}), REQ, () => undefined);
    await provider.stream(target({ provider: 'gemini' }), REQ, () => undefined);
    await provider.stream(
      target({ provider: 'openai_compatible', baseUrl: 'https://llm.example/v1', apiKey: null }),
      REQ,
      () => undefined,
    );
    // No env var (OPENAI_BASE_URL, OPENAI_ORG_ID, OPENAI_PROJECT_ID) reaches a tenant call.
    const pinned = { organization: null, project: null };
    expect(made).toEqual([
      { apiKey: 'sk-secret', baseURL: 'https://api.openai.com/v1', ...pinned, hasFetch: false },
      {
        apiKey: 'sk-secret',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        ...pinned,
        hasFetch: false,
      },
      { apiKey: 'none', baseURL: 'https://llm.example/v1', ...pinned, hasFetch: true },
    ]);
  });

  it('lists models with a 10 s timeout and no retries; streaming keeps the SDK defaults', async () => {
    const made: object[] = [];
    const provider = new AiProvider(config, {
      openai: ({ fetch: _f, ...opts }) => {
        made.push(opts);
        return {
          chat: { completions: { create: () => Promise.reject(new Error('stop')) } },
          models: { list: noModels },
        };
      },
      anthropic: (opts) => {
        made.push(opts);
        throw new Error('stop');
      },
    });
    await provider.listModels(target({}));
    await provider.listModels(target({ provider: 'anthropic' })).catch(() => undefined);
    await provider.stream(target({}), REQ, () => undefined).catch(() => undefined);
    expect(made[0]).toMatchObject({ timeout: 10_000, maxRetries: 0 });
    expect(made[1]).toMatchObject({ timeout: 10_000, maxRetries: 0 });
    expect(made[2]).not.toHaveProperty('timeout');
    expect(made[2]).not.toHaveProperty('maxRetries');
  });

  it('never lets a personal integration reach a private host, even with AI_ALLOW_PRIVATE_HOSTS', async () => {
    const allowing = {
      get: (k: string) => (k === 'AI_ALLOW_PRIVATE_HOSTS' ? true : undefined),
    } as unknown as ConfigService<AppEnv, true>;
    const fetches: (typeof fetch)[] = [];
    const provider = new AiProvider(allowing, {
      openai: (opts) => {
        if (opts.fetch !== undefined) fetches.push(opts.fetch);
        return {
          chat: { completions: { create: () => Promise.reject(new Error('stop')) } },
          models: { list: noModels },
        };
      },
    });
    const local = { provider: 'openai_compatible' as const, baseUrl: 'http://127.0.0.1:9/v1' };
    await provider.listModels(target({ ...local, personal: true }));
    await provider.stream(target({ ...local, personal: true }), REQ, () => undefined).catch(() => undefined);
    for (const f of fetches) {
      await expect(f('http://127.0.0.1:9/v1/models')).rejects.toMatchObject({
        response: { code: 'introspect.private_host' },
      });
    }
    expect(fetches).toHaveLength(2);
  });

  it('maps a context-length error to 422 and scrubs the key from others', async () => {
    const failing = (error: Error) =>
      new AiProvider(config, {
        openai: () => ({
          chat: { completions: { create: () => Promise.reject(error) } },
          models: { list: noModels },
        }),
      });
    await expect(
      failing(Object.assign(new Error('too long'), { code: 'context_length_exceeded' })).stream(
        target({}),
        REQ,
        () => undefined,
      ),
    ).rejects.toMatchObject({ response: { code: 'ai_context_too_small' } });
    await expect(
      failing(new Error('key sk-secret is invalid')).stream(target({}), REQ, () => undefined),
    ).rejects.toThrow('key *** is invalid');
  });

  describe('error scrubbing', () => {
    const caught = async (thrown: unknown, key: string | null = 'sk-secret') => {
      const provider = new AiProvider(config, {
        openai: () => ({
          chat: {
            completions: {
              // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- non-Error throws are the case under test
              create: () => Promise.reject(thrown),
            },
          },
          models: { list: noModels },
        }),
      });
      try {
        await provider.stream(target({ apiKey: key }), REQ, () => undefined);
      } catch (e) {
        return e;
      }
      throw new Error('did not throw');
    };
    const leaks = (e: unknown) =>
      [(e as Error).message, (e as Error).stack, JSON.stringify(e, Object.getOwnPropertyNames(e))]
        .join('|')
        .includes('sk-secret');

    it('drops the key from message, stack, body and cause, keeping a numeric status', async () => {
      const original = Object.assign(new Error('401 key sk-secret rejected'), {
        status: 401,
        error: { message: 'bad sk-secret' },
        headers: { authorization: 'Bearer sk-secret' },
      });
      const out = await caught(original);
      expect(out).not.toBe(original);
      expect(leaks(out)).toBe(false);
      expect((out as Error).message).toBe('401 key *** rejected');
      expect((out as { status?: number }).status).toBe(401);
      expect((out as Error).cause).toBeUndefined();
    });

    it('scrubs a thrown string and survives null/undefined', async () => {
      const out = await caught('oops sk-secret');
      expect(out).toBeInstanceOf(Error);
      expect(leaks(out)).toBe(false);
      expect(await caught(null)).toBeInstanceOf(Error);
      expect(await caught(undefined)).toBeInstanceOf(Error);
    });

    it('returns the original error when there is no key', async () => {
      const original = new Error('boom');
      expect(await caught(original, null)).toBe(original);
    });
  });

  it('pins the Anthropic base URL: none for the server row, the public API for custom', async () => {
    const seen: object[] = [];
    const provider = new AiProvider(config, {
      anthropic: (opts) => {
        seen.push(opts);
        throw new Error('stop');
      },
    });
    for (const source of ['server', 'custom'] as const) {
      await provider
        .stream(target({ provider: 'anthropic', source, apiKey: 'k' }), REQ, () => undefined)
        .catch(() => undefined);
    }
    expect(seen).toEqual([
      { apiKey: 'k' },
      { apiKey: 'k', baseURL: 'https://api.anthropic.com', authToken: null },
    ]);
    expect('baseURL' in seen[0]!).toBe(false);
  });

  it('asks for the server-side fallback only on models that take it; adaptive thinking on 4.6+', async () => {
    const bodies: Record<string, unknown>[] = [];
    const provider = new AiProvider(config, {
      anthropic: () =>
        ({
          beta: {
            messages: {
              stream: (body: Record<string, unknown>) => {
                bodies.push(body);
                throw new Error('stop');
              },
            },
          },
        }) as never,
    });
    for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-haiku-4-5']) {
      await provider
        .stream(target({ provider: 'anthropic', model }), REQ, () => undefined)
        .catch(() => undefined);
    }
    const fallback = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
    expect(bodies[0]).toMatchObject({ ...fallback, thinking: { type: 'adaptive' } });
    expect(bodies[1]).toMatchObject({ ...fallback, thinking: { type: 'adaptive' } });
    expect(bodies[2]).toMatchObject({ thinking: { type: 'adaptive' } });
    expect(bodies[2]).not.toHaveProperty('fallbacks');
    expect(bodies[2]).not.toHaveProperty('betas');
    expect(bodies[3]).not.toHaveProperty('thinking');
    expect(bodies[3]).not.toHaveProperty('fallbacks');
  });
});
