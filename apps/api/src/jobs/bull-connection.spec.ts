import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BULL_PREFIX, adoptQueueClient } from './bull-connection';

/** ioredis is not started: only `options` is read, and only `keyPrefix` is written. */
const client = (keyPrefix?: string): Redis =>
  ({ options: { keyPrefix, maxRetriesPerRequest: null, enableReadyCheck: false } }) as Redis;

describe('adoptQueueClient', () => {
  it('reuses the existing REDIS_QUEUE client — no fourth connection', () => {
    const queue = client('sl:q:');
    expect(adoptQueueClient(queue).connection).toBe(queue);
  });

  it('moves the key prefix off ioredis, because BullMQ throws on one', () => {
    const queue = client('sl:q:');
    const bull = adoptQueueClient(queue);

    // bullmq/dist/cjs/classes/redis-connection.js: "BullMQ: ioredis does not support
    // ioredis prefixes, use the prefix option instead."
    expect(queue.options.keyPrefix).toBeUndefined();
    expect(bull.prefix).toBe('sl:q');
  });

  it('keeps the options BullMQ requires and a cache client must not have', () => {
    const queue = client('sl-test:q:');
    adoptQueueClient(queue);

    expect(queue.options.maxRetriesPerRequest).toBeNull();
    expect(queue.options.enableReadyCheck).toBe(false);
  });

  it('falls back to bullmq default rather than emitting keys that start with a colon', () => {
    expect(adoptQueueClient(client()).prefix).toBe(DEFAULT_BULL_PREFIX);
    expect(adoptQueueClient(client(':')).prefix).toBe(DEFAULT_BULL_PREFIX);
  });
});
