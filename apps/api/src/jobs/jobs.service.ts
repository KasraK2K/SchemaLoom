import { Inject, Injectable } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';
import {
  JOB_EMAIL_SEND,
  JOB_IMPORT_SQL,
  JOB_EXPORT_RENDER,
  JOB_VALIDATE_MODEL,
  type EmailJobData,
  type ExportJobData,
  type ExportJobResult,
  type ImportJobData,
  type ImportJobResult,
  type ValidateJobData,
} from './queues';

/** The token for the three queues. Declared here, with its only consumer. */
export const JOB_QUEUES = Symbol('JOB_QUEUES');

export interface JobQueues {
  readonly export: Queue<ExportJobData, ExportJobResult>;
  readonly email: Queue<EmailJobData, void>;
  readonly validate: Queue<ValidateJobData>;
  readonly import: Queue<ImportJobData, ImportJobResult>;
  readonly maintenance: Queue;
}

export interface ImportJobStatus {
  readonly id: string;
  /** BullMQ's own state: `waiting` / `active` / `delayed` / `completed` / `failed`. */
  readonly state: string;
  readonly result: ImportJobResult | null;
  readonly error: string | null;
}

/**
 * Retries with backoff, and — the part that is not boilerplate — BOUNDED RETENTION.
 *
 * Doc 01 §4.4 runs Redis with `--maxmemory-policy noeviction` so the queue is never
 * silently evicted, which makes every unbounded structure on that instance a way to reach
 * the memory limit and have Redis start refusing WRITES, including queue writes. Completed
 * and failed job records are exactly such a structure. `removeOnComplete` / `removeOnFail`
 * are to the queue what §4.4 rule 1's mandatory TTL is to the cache.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 24 * 3_600, count: 1_000 },
};

/** The enqueue half. Nothing outside this module constructs a `Queue`. */
@Injectable()
export class JobsService {
  constructor(@Inject(JOB_QUEUES) private readonly queues: JobQueues) {}

  async enqueueExport(data: ExportJobData): Promise<string> {
    const job = await this.queues.export.add(JOB_EXPORT_RENDER, data, DEFAULT_JOB_OPTIONS);
    return job.id ?? data.exportJobId;
  }

  async enqueueEmail(data: EmailJobData): Promise<void> {
    await this.queues.email.add(JOB_EMAIL_SEND, data, DEFAULT_JOB_OPTIONS);
  }

  async enqueueValidation(data: ValidateJobData): Promise<void> {
    await this.queues.validate.add(JOB_VALIDATE_MODEL, data, DEFAULT_JOB_OPTIONS);
  }

  /** One attempt: a failed import is a bad source far more often than a flaky worker, and
   *  a retry of a half-applied import would only re-add what is still missing anyway. */
  async enqueueImport(data: ImportJobData): Promise<string> {
    const job = await this.queues.import.add(JOB_IMPORT_SQL, data, {
      ...DEFAULT_JOB_OPTIONS,
      attempts: 1,
    });
    return job.id ?? '';
  }

  /**
   * No `import_jobs` table: BullMQ keeps the state and the return value for the retention
   * window, which is as long as a client polls. `null` for a job that is not this
   * project's — or not this user's — so a guessed id reads as absent.
   */
  async importStatus(
    projectId: string,
    userId: string,
    id: string,
  ): Promise<ImportJobStatus | null> {
    const job = await this.queues.import.getJob(id);
    const owner = job?.data.subject;
    if (job?.data.projectId !== projectId || owner?.kind !== 'user' || owner.userId !== userId) {
      return null;
    }
    // BullMQ types both as always present; they are unset until the job completes/fails.
    const result = job.returnvalue as ImportJobResult | null | undefined;
    const failed = job.failedReason as string | undefined;
    return {
      id,
      state: await job.getState(),
      result: result ?? null,
      error: failed === undefined || failed === '' ? null : failed,
    };
  }
}
