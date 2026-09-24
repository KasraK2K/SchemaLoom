import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { AppEnv } from '../config/env';
import { createRedisClient, ROLE_BY_TOKEN } from './redis.factory';
import { REDIS_CACHE, REDIS_QUEUE, REDIS_RATELIMIT, REDIS_TOKENS } from './redis.tokens';

const clientProviders = REDIS_TOKENS.map((token) => ({
  provide: token,
  inject: [ConfigService],
  useFactory: (config: ConfigService<AppEnv, true>): Redis =>
    createRedisClient(
      ROLE_BY_TOKEN[token],
      config.get('REDIS_URL', { infer: true }),
      config.get('REDIS_KEY_PREFIX', { infer: true }),
    ),
}));

/** Doc 01 §4: `@Global()` — the alternative is importing this into eight modules. */
@Global()
@Module({
  providers: clientProviders,
  exports: [...REDIS_TOKENS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS_CACHE) private readonly cache: Redis,
    @Inject(REDIS_RATELIMIT) private readonly ratelimit: Redis,
    @Inject(REDIS_QUEUE) private readonly queue: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.cache.quit(), this.ratelimit.quit(), this.queue.quit()]);
  }
}
