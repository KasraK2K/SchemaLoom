import { Redis, type RedisOptions } from 'ioredis';
import { REDIS_CACHE, REDIS_QUEUE, REDIS_RATELIMIT, type RedisToken } from './redis.tokens';

export type RedisRole = 'cache' | 'ratelimit' | 'queue';

export const ROLE_BY_TOKEN: Readonly<Record<RedisToken, RedisRole>> = {
  [REDIS_CACHE]: 'cache',
  [REDIS_RATELIMIT]: 'ratelimit',
  [REDIS_QUEUE]: 'queue',
};

/** Doc 01 §4.4's table, as data. The prefix segment per role. */
const SEGMENT: Readonly<Record<RedisRole, string>> = {
  cache: 'cache:',
  ratelimit: 'rl:',
  queue: 'q:',
};

/**
 * §4.4 rule 3 — `REDIS_KEY_PREFIX` is mandatory and environment-derived (`sl:` in dev,
 * `sl-test:` under `test:int`, `sl-e2e:` under `test:e2e`), so a developer's running
 * api and a test run stay isolated even when both point at the same logical DB.
 */
export function redisOptionsFor(role: RedisRole, keyPrefix: string): RedisOptions {
  const base: RedisOptions = { keyPrefix: `${keyPrefix}${SEGMENT[role]}` };
  // BullMQ's blocking reads need unlimited retries and no ready check; both are
  // wrong for a cache or a counter, which is why this is a per-role branch.
  return role === 'queue'
    ? { ...base, maxRetriesPerRequest: null, enableReadyCheck: false }
    : base;
}

export function createRedisClient(
  role: RedisRole,
  url: string,
  keyPrefix: string,
  overrides: RedisOptions = {},
): Redis {
  return new Redis(url, { ...redisOptionsFor(role, keyPrefix), ...overrides });
}
