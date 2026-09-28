import { Module, type Provider } from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { MailModule } from '../mail/mail.module';
import { REDIS_QUEUE } from '../redis/redis.tokens';
import { SchemaModule } from '../schema';
import { SnapshotsModule } from '../snapshots';
import { StorageModule } from '../storage';
import { adoptQueueClient, type BullConnection } from './bull-connection';
import { EmailProcessor } from './email.processor';
import { ExportProcessor } from './export.processor';
import { ImportJobsController } from './import-jobs.controller';
import { ImportProcessor } from './import.processor';
import { JOB_QUEUES, JobsService, type JobQueues } from './jobs.service';
import { JOB_WORKERS, JobsRuntime, type Closable } from './jobs.runtime';
import {
  QUEUE_EMAIL,
  QUEUE_EXPORT,
  QUEUE_IMPORT,
  QUEUE_VALIDATE,
  type EmailJobData,
  type ExportJobData,
  type ExportJobResult,
  type ImportJobData,
  type ImportJobResult,
  type ValidateJobData,
} from './queues';
import { ValidateProcessor } from './validate.processor';

/** One provider, so `adoptQueueClient` — which moves the prefix and is therefore not
 *  idempotent — runs exactly once for both the queues and the workers. */
const BULL_CONNECTION = Symbol('BULL_CONNECTION');

const connectionProvider: Provider = {
  provide: BULL_CONNECTION,
  inject: [REDIS_QUEUE],
  useFactory: (client: Redis): BullConnection => adoptQueueClient(client),
};

const queuesProvider: Provider = {
  provide: JOB_QUEUES,
  inject: [BULL_CONNECTION],
  useFactory: (bull: BullConnection): JobQueues => ({
    export: new Queue<ExportJobData, ExportJobResult>(QUEUE_EXPORT, bull),
    email: new Queue<EmailJobData, void>(QUEUE_EMAIL, bull),
    validate: new Queue<ValidateJobData>(QUEUE_VALIDATE, bull),
    import: new Queue<ImportJobData, ImportJobResult>(QUEUE_IMPORT, bull),
  }),
};

/**
 * Doc 01: no `apps/worker` in Phase 1 — the processors run IN-PROCESS. Whether they later
 * move to their own deployment is a load question, and the answer changes by importing
 * this module from a second entrypoint, not by rewriting it.
 */
const workersProvider: Provider = {
  provide: JOB_WORKERS,
  inject: [BULL_CONNECTION, ExportProcessor, EmailProcessor, ValidateProcessor, ImportProcessor],
  useFactory: (
    bull: BullConnection,
    exporter: ExportProcessor,
    mailer: EmailProcessor,
    validator: ValidateProcessor,
    importer: ImportProcessor,
  ): Closable[] => [
    new Worker<ExportJobData, ExportJobResult>(
      QUEUE_EXPORT,
      (job: Job<ExportJobData>) => exporter.run(job.data),
      bull,
    ),
    new Worker<EmailJobData, void>(
      QUEUE_EMAIL,
      (job: Job<EmailJobData>) => mailer.run(job.data),
      bull,
    ),
    new Worker<ValidateJobData>(
      QUEUE_VALIDATE,
      async (job: Job<ValidateJobData>) => {
        await validator.run(job.data);
      },
      bull,
    ),
    new Worker<ImportJobData, ImportJobResult>(
      QUEUE_IMPORT,
      (job: Job<ImportJobData>) => importer.run(job.data),
      bull,
    ),
  ],
};

/**
 * Build-order step 26 — BullMQ, in-process.
 *
 * `PrismaModule`, `AccessModule` and `EnginesModule` are `@Global()`, so `PrismaService`,
 * `VisibilityFilter` and `ENGINE_REGISTRY` resolve from the root injector and are
 * deliberately not imported: importing them again would create a second, unrelated set of
 * providers and a second permission cache.
 */
@Module({
  imports: [SchemaModule, SnapshotsModule, StorageModule, MailModule],
  controllers: [ImportJobsController],
  providers: [
    connectionProvider,
    queuesProvider,
    ExportProcessor,
    EmailProcessor,
    ValidateProcessor,
    ImportProcessor,
    workersProvider,
    JobsService,
    JobsRuntime,
  ],
  exports: [JobsService],
})
export class JobsModule {}
