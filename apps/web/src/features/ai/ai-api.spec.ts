import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api-client';
import { aiErrorMessage, createSseParser } from './ai-api';

describe('createSseParser', () => {
  it('frames events across arbitrary chunk boundaries', () => {
    const wire =
      'event: block-open\ndata: {"tag":"query"}\n\nevent: block-delta\ndata: {"tag":"query","text":"SELECT 1"}\n\nevent: done\ndata: {}\n\n';
    for (const size of [1, 4, 9, wire.length]) {
      const parser = createSseParser();
      const events = [];
      for (let i = 0; i < wire.length; i += size)
        events.push(...parser.push(wire.slice(i, i + size)));
      expect(events.map((e) => e.event)).toEqual(['block-open', 'block-delta', 'done']);
      expect(events[1]?.data).toBe('{"tag":"query","text":"SELECT 1"}');
    }
  });
});

describe('aiErrorMessage', () => {
  it('names the three statuses DESIGN §4.4 asks for', () => {
    expect(aiErrorMessage(new ApiError(503, 'ai_not_configured', ''))).toBe(
      'AI is not configured on this server.',
    );
    expect(aiErrorMessage(new ApiError(403, 'forbidden', ''))).toBe(
      'You don’t have AI access for this selection.',
    );
    expect(aiErrorMessage(new ApiError(429, 'ai_rate_limited', '', { retryAfter: 125 }))).toBe(
      'Too many AI requests. Try again in 3 min.',
    );
  });
});
