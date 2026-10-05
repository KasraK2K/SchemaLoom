import { Inject, Injectable, Module, type OnModuleDestroy, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, type Job } from 'bullmq';
import type { AppEnv } from '../config/env';
import { DocsModule } from '../docs';
import { BULL_CONNECTION, JobsModule, runsJobs, type BullConnection } from '../jobs';
import { SchemaModule } from '../schema';
import { SnapshotsModule } from '../snapshots';
import { AiController } from './ai.controller';
import { AiProvider } from './ai.provider';
import { AI_DOC_DRAFTS, AI_DOC_DRAFTS_QUEUE, AiService, type DocDraftJobData } from './ai.service';

const queueProvider: Provider = {
  provide: AI_DOC_DRAFTS,
  inject: [BULL_CONNECTION],
  useFactory: (bull: BullConnection) => new Queue<DocDraftJobData>(AI_DOC_DRAFTS_QUEUE, bull),
};

/**
 * DESIGN Q5 — the doc-drafting worker, in-process like every other queue (doc 01). It lives
 * here rather than in `JobsModule` because it needs `AiService`, and `JobsModule` must not
 * import the AI module back. Closed on module destroy, before Redis quits (see `JobsRuntime`).
 */
@Injectable()
class DocDraftWorker implements OnModuleDestroy {
  private readonly worker: Worker<DocDraftJobData> | null;

  constructor(
    ai: AiService,
    @Inject(BULL_CONNECTION) bull: BullConnection,
    @Inject(AI_DOC_DRAFTS) private readonly queue: Queue,
    config: ConfigService<AppEnv, true>,
  ) {
    // Roadmap 20 §1: an `api` process only enqueues drafts.
    this.worker = runsJobs(config)
      ? new Worker<DocDraftJobData>(
          AI_DOC_DRAFTS_QUEUE,
          (job: Job<DocDraftJobData>) => ai.runDocDraftJob(job.data, job.id ?? null),
          bull,
        )
      : null;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.worker?.close(), this.queue.close()]);
  }
}

/** Prisma, access, engines and Redis are `@Global()`. */
@Module({
  imports: [SchemaModule, JobsModule, DocsModule, SnapshotsModule],
  controllers: [AiController],
  providers: [AiProvider, AiService, queueProvider, DocDraftWorker],
})
export class AiModule {}
