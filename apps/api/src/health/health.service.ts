import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CACHE } from '../redis/redis.tokens';

export interface ReadinessReport {
  status: 'ok' | 'degraded';
  checks: Record<string, { ok: boolean; error?: string }>;
}

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CACHE) private readonly redis: Redis,
  ) {}

  /**
   * Doc 01 §3: `/readyz` is `db+redis+s3`. `StorageModule` does not exist yet
   * (it is a later build-order step); when it does, add its `headBucket` here —
   * `check()` takes any thunk precisely so that is a one-line change.
   */
  async readiness(): Promise<ReadinessReport> {
    const entries = await Promise.all([
      check('postgres', async () => {
        await this.prisma.$queryRaw`SELECT 1`;
      }),
      check('redis', async () => {
        await this.redis.ping();
      }),
    ]);

    const checks = Object.fromEntries(entries);
    const status = entries.every(([, r]) => r.ok) ? 'ok' : 'degraded';
    return { status, checks };
  }
}

async function check(
  name: string,
  probe: () => Promise<void>,
): Promise<[string, { ok: boolean; error?: string }]> {
  try {
    await probe();
    return [name, { ok: true }];
  } catch (error) {
    return [name, { ok: false, error: error instanceof Error ? error.message : String(error) }];
  }
}
