/**
 * Doc 01 §4.4 — three clients, one Redis instance.
 *
 * BullMQ cannot share a connection with ordinary commands: it issues blocking reads
 * (`BZPOPMIN`, `BRPOPLPUSH`) that stall every other command queued on the same socket,
 * and it requires `maxRetriesPerRequest: null`, which is exactly wrong for a cache
 * client. Hence three instances from one factory, under three injection tokens.
 */

/** `PermissionResolver` effective-permission cache. Prefix `${REDIS_KEY_PREFIX}cache:`. */
export const REDIS_CACHE = 'REDIS_CACHE';

/**
 * Rate limiter. Prefix `${REDIS_KEY_PREFIX}rl:`.
 *
 * §4.4 rule 2 — **THE RATE LIMITER FAILS CLOSED.** A Redis error on the counter path
 * returns 503. It never returns "allow". Failing open on the exact resource the spec
 * wants throttled is not an acceptable default, and a `try { … } catch { return true }`
 * around a counter read is the way that bug gets written. The limiter (a later step)
 * owns the guard; this comment is here because this token is where someone looks first.
 */
export const REDIS_RATELIMIT = 'REDIS_RATELIMIT';

/** BullMQ (Phase 4: the Socket.IO adapter). Prefix `${REDIS_KEY_PREFIX}q:`. */
export const REDIS_QUEUE = 'REDIS_QUEUE';

export const REDIS_TOKENS = [REDIS_CACHE, REDIS_RATELIMIT, REDIS_QUEUE] as const;

export type RedisToken = (typeof REDIS_TOKENS)[number];
