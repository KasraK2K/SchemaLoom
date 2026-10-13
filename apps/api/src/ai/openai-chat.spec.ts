import { describe, expect, it } from 'vitest';
import { scrubKey, streamChat, toChatBody, type ChatChunk, type ChatClient } from './openai-chat';

const REQUEST = { prefix: 'SYSTEM+SCHEMA', instructions: 'MODE', messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 500 };

/** An async iterable over `items`; the await keeps the stream honest about async. */
async function* each<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) {
    await Promise.resolve();
    yield item;
  }
}

function stub(chunks: ChatChunk[]): ChatClient & { bodies: object[] } {
  const bodies: object[] = [];
  return {
    bodies,
    chat: { completions: { create: (body: object) => { bodies.push(body); return Promise.resolve(each(chunks)); } } },
    models: { list: () => each([{ id: 'm' }]) },
  };
}

describe('openai-chat (roadmap 24 §4.1)', () => {
  it('puts the cached prefix first and asks for usage', () => {
    expect(toChatBody('openai', 'gpt-x', REQUEST)).toEqual({
      model: 'gpt-x',
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 500,
      messages: [
        { role: 'system', content: 'SYSTEM+SCHEMA' },
        { role: 'system', content: 'MODE' },
        { role: 'user', content: 'hi' },
      ],
    });
  });

  it('sends max_tokens to Gemini and compatible servers', () => {
    for (const provider of ['gemini', 'openai_compatible'] as const) {
      const body = toChatBody(provider, 'm', REQUEST);
      expect(body).toMatchObject({ max_tokens: 500, stream_options: { include_usage: true } });
      expect(body).not.toHaveProperty('max_completion_tokens');
    }
  });

  it('streams text and maps finish reasons and usage', async () => {
    const client = stub([
      { model: 'gpt-x-2026', choices: [{ delta: { content: 'Hel' }, finish_reason: null }] },
      { model: 'gpt-x-2026', choices: [{ delta: { content: 'lo' }, finish_reason: 'content_filter' }] },
      { model: 'gpt-x-2026', choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
    ]);
    const seen: string[] = [];
    const result = await streamChat(client, 'openai', 'gpt-x', REQUEST, (t) => seen.push(t));
    expect(seen).toEqual(['Hel', 'lo']);
    expect(result).toEqual({ text: 'Hello', stopReason: 'refusal', model: 'gpt-x-2026', tokensIn: 12, tokensOut: 3 });
  });

  it('maps length to max_tokens and missing usage to null', async () => {
    const result = await streamChat(stub([{ choices: [{ delta: {}, finish_reason: 'length' }] }]), 'openai', 'gpt-x', REQUEST, () => undefined);
    expect(result).toMatchObject({ stopReason: 'max_tokens', model: 'gpt-x', tokensIn: null, tokensOut: null });
  });

  it('scrubs the key out of provider errors', () => {
    expect(scrubKey('bad key sk-abc123 rejected', 'sk-abc123')).toBe('bad key *** rejected');
    expect(scrubKey('no key here', null)).toBe('no key here');
  });
});
