import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import type { AppEnv } from '../config/env';
import { BULL_CONNECTION, DEFAULT_JOB_OPTIONS, runsJobs, type BullConnection } from '../jobs';
import { AuditStreamService } from './audit-stream.service';

export const QUEUE_AUDIT_STREAM = 'audit-stream';
export const JOB_AUDIT_STREAM = 'audit-stream.deliver';
export const AUDIT_STREAM_EVERY_MS = 30_000;

/**
 * Roadmap 14d §3 — its own queue and worker, every 30 s. Not the maintenance queue: its
 * worker runs every job there as the retention sweep (the 6d lesson, see `DriftSweepRuntime`).
 * One run at a time; closed in `onModuleDestroy`, before Redis quits (see `JobsRuntime`).
 */
@Injectable()
export class AuditStreamRuntime implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AuditStreamRuntime.name);
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(
    @Inject(BULL_CONNECTION) private readonly bull: BullConnection,
    private readonly streams: AuditStreamService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!runsJobs(this.config)) return;
    this.queue = new Queue(QUEUE_AUDIT_STREAM, this.bull);
    await this.queue.upsertJobScheduler(
      JOB_AUDIT_STREAM,
      { every: AUDIT_STREAM_EVERY_MS },
      { name: JOB_AUDIT_STREAM, opts: DEFAULT_JOB_OPTIONS },
    );
    this.worker = new Worker(QUEUE_AUDIT_STREAM, () => this.streams.sweep(), {
      ...this.bull,
      concurrency: 1,
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('closing the audit stream');
    await Promise.allSettled([this.worker?.close(), this.queue?.close()]);
  }
}
