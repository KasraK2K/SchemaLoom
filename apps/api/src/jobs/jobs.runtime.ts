import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { JOB_QUEUES, type JobQueues } from './jobs.service';

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
export class JobsRuntime implements OnModuleDestroy {
  private readonly logger = new Logger(JobsRuntime.name);

  constructor(
    @Inject(JOB_WORKERS) private readonly workers: readonly Closable[],
    @Inject(JOB_QUEUES) private readonly queues: JobQueues,
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.logger.log(`closing ${String(this.workers.length)} worker(s)`);
    // allSettled: one worker refusing to close must not leave the other two running.
    await Promise.allSettled(this.workers.map((worker) => worker.close()));

    // Named rather than `Object.values`, which widens three differently-parameterised
    // `Queue`s to `any` and takes the type-safety of this line with it.
    const queues: readonly Closable[] = [
      this.queues.export,
      this.queues.email,
      this.queues.validate,
    ];
    await Promise.allSettled(queues.map((queue) => queue.close()));
  }
}
