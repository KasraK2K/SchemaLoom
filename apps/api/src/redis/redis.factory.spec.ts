import { describe, expect, it } from 'vitest';
import { ROLE_BY_TOKEN, createRedisClient, redisOptionsFor } from './redis.factory';
import { REDIS_CACHE, REDIS_QUEUE, REDIS_RATELIMIT, REDIS_TOKENS } from './redis.tokens';

/**
 * Doc 01 §4.4's table, asserted. No live Redis: `lazyConnect` keeps the constructor
 * from opening a socket, and `client.options` is what BullMQ and the resolver read.
 */
describe('redisOptionsFor — §4.4 key prefixes', () => {
  it('prefixes every role with REDIS_KEY_PREFIX', () => {
    expect(redisOptionsFor('cache', 'sl:').keyPrefix).toBe('sl:cache:');
    expect(redisOptionsFor('ratelimit', 'sl:').keyPrefix).toBe('sl:rl:');
    expect(redisOptionsFor('queue', 'sl:').keyPrefix).toBe('sl:q:');
  });

  it('honours the test and e2e prefixes, so a test run cannot touch a dev keyspace', () => {
    expect(redisOptionsFor('cache', 'sl-test:').keyPrefix).toBe('sl-test:cache:');
    expect(redisOptionsFor('queue', 'sl-e2e:').keyPrefix).toBe('sl-e2e:q:');
  });

  it('gives the three roles three distinct keyspaces', () => {
    const prefixes = (['cache', 'ratelimit', 'queue'] as const).map(
      (role) => redisOptionsFor(role, 'sl:').keyPrefix,
    );
    expect(new Set(prefixes).size).toBe(3);
  });

  it('applies BullMQ-only options to the queue role alone', () => {
    const queue = redisOptionsFor('queue', 'sl:');
    expect(queue.maxRetriesPerRequest).toBeNull();
    expect(queue.enableReadyCheck).toBe(false);

    for (const role of ['cache', 'ratelimit'] as const) {
      const opts = redisOptionsFor(role, 'sl:');
      // `maxRetriesPerRequest: null` is exactly wrong for a cache or a counter.
      expect(opts.maxRetriesPerRequest).toBeUndefined();
      expect(opts.enableReadyCheck).toBeUndefined();
    }
  });
});

describe('ROLE_BY_TOKEN', () => {
  it('maps each injection token to its own role', () => {
    expect(ROLE_BY_TOKEN[REDIS_CACHE]).toBe('cache');
    expect(ROLE_BY_TOKEN[REDIS_RATELIMIT]).toBe('ratelimit');
    expect(ROLE_BY_TOKEN[REDIS_QUEUE]).toBe('queue');
    expect(REDIS_TOKENS).toHaveLength(3);
  });
});

describe('createRedisClient', () => {
  it('carries the per-token prefix onto the instance', () => {
    const clients = REDIS_TOKENS.map((token) =>
      createRedisClient(ROLE_BY_TOKEN[token], 'redis://localhost:6379', 'sl:', {
        lazyConnect: true,
      }),
    );
    try {
      expect(clients.map((c) => c.options.keyPrefix)).toEqual(['sl:cache:', 'sl:rl:', 'sl:q:']);
    } finally {
      for (const client of clients) client.disconnect();
    }
  });
});
