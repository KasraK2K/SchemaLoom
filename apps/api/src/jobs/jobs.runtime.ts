import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnv } from '../config/env';
import { AUDIT_RETENTION_CRON } from './audit-retention.processor';
import { DEFAULT_JOB_OPTIONS, JOB_QUEUES, type JobQueues } from './jobs.service';
import { JOB_AUDIT_RETENTION } from './queues';

/**
 * Roadmap 20 §1 — whether this process runs BullMQ workers and schedulers. Every place that
 * starts one asks this; an `api` process only enqueues.
 */
export function runsJobs(config: ConfigService<AppEnv, true>): boolean {
  return config.get('PROCESS_ROLE', { infer: true }) !== 'api';
}

/** The token for the workers this process runs. */
export const JOB_WORKERS = Symbol('JOB_WORKERS');

/**
 * Structural, not `Worker` — so the shutdown test can pass three fakes without standing up
 * BullMQ, and so this file does not care whether a worker is a BullMQ worker.
 */
export interface Closable {
  readonly name: string;
  close(): Promise<void>;
}

/**
 * Graceful shutdown (deliverable 5): the workers close BEFORE the Nest app exits, so a
 * deploy does not sever a job mid-flight. `Worker.close()` stops the blocking read and
 * waits for the jobs already in hand; anything still queued is simply picked up by the
 * next process, which is what the queue is for.
 *
 * `OnModuleDestroy`, NOT `OnApplicationShutdown`, and that is the load-bearing part.
 * `RedisModule` quits all three ioredis clients in its `onApplicationShutdown`, and Nest
 * runs EVERY `onModuleDestroy` before ANY `onApplicationShutdown` — so this ordering is
 * guaranteed by the framework rather than by `JobsModule` happening to sit later in the
 * import list. Under `onApplicationShutdown` the two hooks would race, the socket would go
 * first often enough to matter, and `close()` would hang or throw on a dead connection
 * while a job was still running.
 */
@Injectable()
export class JobsRuntime implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobsRuntime.name);

  constructor(
    @Inject(JOB_WORKERS) private readonly workers: readonly Closable[],
    @Inject(JOB_QUEUES) private readonly queues: JobQueues,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  /**
   * Registers the nightly audit-retention sweep (doc 00 Q10). `upsertJobScheduler` is keyed by
   * id, so every boot and every replica converges on the one schedule instead of adding one.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!runsJobs(this.config)) return;
    await this.queues.maintenance.upsertJobScheduler(
      JOB_AUDIT_RETENTION,
      { pattern: AUDIT_RETENTION_CRON, tz: 'UTC' },
      { name: JOB_AUDIT_RETENTION, opts: DEFAULT_JOB_OPTIONS },
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log(`closing ${String(this.workers.length)} worker(s)`);
    // allSettled: one worker refusing to close must not leave the other two running.
    await Promise.allSettled(this.workers.map((worker) => worker.close()));

    // Named rather than `Object.values`, which widens the differently-parameterised
    // `Queue`s to `any` and takes the type-safety of this line with it.
    const queues: readonly Closable[] = [
      this.queues.export,
      this.queues.email,
      this.queues.validate,
      this.queues.import,
      this.queues.maintenance,
    ];
    await Promise.allSettled(queues.map((queue) => queue.close()));
  }
}
