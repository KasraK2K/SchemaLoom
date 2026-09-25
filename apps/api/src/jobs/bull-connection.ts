import type { Redis } from 'ioredis';

/** What every `Queue` and `Worker` in this module is constructed with. */
export interface BullConnection {
  readonly connection: Redis;
  readonly prefix: string;
}

/** BullMQ's own default, used when `REDIS_KEY_PREFIX` somehow yields nothing — an empty
 *  prefix would produce keys starting with `:`. */
export const DEFAULT_BULL_PREFIX = 'bull';

/**
 * Doc 01 §4.4 — BullMQ runs on the EXISTING `REDIS_QUEUE` client. That client is already
 * configured with `maxRetriesPerRequest: null` and `enableReadyCheck: false`, which BullMQ
 * requires and which is exactly wrong for a cache client; there is no fourth connection to
 * add. Passing the instance (rather than a URL) also makes BullMQ mark it `shared`, so the
 * three queues and the three workers share that one non-blocking socket. Each worker still
 * duplicates it for its blocking read — `BZPOPMIN` occupies a socket for its whole timeout,
 * so one blocking socket per worker is not an optimisation BullMQ left on the table.
 *
 * THE PREFIX HAS TO MOVE. BullMQ refuses an ioredis client carrying a `keyPrefix`
 * outright — `redis-connection.js` throws "ioredis does not support ioredis prefixes, use
 * the prefix option instead" — because it computes key slots itself. So the namespace
 * §4.4 rule 3 mandates is handed to BullMQ as its own `prefix` instead of being applied by
 * ioredis. The keys land in the same place either way, and `REDIS_QUEUE` has no other
 * consumer (§4.4's table), so nothing else loses its prefix.
 *
 * NOT idempotent — the second call would read an already-cleared prefix. It is a single
 * provider (`BULL_CONNECTION`) for exactly that reason; queues and workers inject it.
 */
export function adoptQueueClient(client: Redis): BullConnection {
  const prefix = (client.options.keyPrefix ?? '').replace(/:+$/, '');
  client.options.keyPrefix = undefined;
  return { connection: client, prefix: prefix === '' ? DEFAULT_BULL_PREFIX : prefix };
}
