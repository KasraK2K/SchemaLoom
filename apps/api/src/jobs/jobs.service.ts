import { Inject, Injectable } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';
import {
  JOB_EMAIL_SEND,
  JOB_EXPORT_RENDER,
  JOB_VALIDATE_MODEL,
  type EmailJobData,
  type ExportJobData,
  type ExportJobResult,
  type ValidateJobData,
} from './queues';

/** The token for the three queues. Declared here, with its only consumer. */
export const JOB_QUEUES = Symbol('JOB_QUEUES');

export interface JobQueues {
  readonly export: Queue<ExportJobData, ExportJobResult>;
  readonly email: Queue<EmailJobData, void>;
  readonly validate: Queue<ValidateJobData>;
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
}
