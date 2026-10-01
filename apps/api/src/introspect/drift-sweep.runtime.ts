import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { BULL_CONNECTION, DEFAULT_JOB_OPTIONS, type BullConnection } from '../jobs';
import { DriftCheckService } from './drift-check.service';

export const QUEUE_DRIFT = 'drift';
export const JOB_DRIFT_SWEEP = 'drift.sweep';
/** Hourly, off the hour; each run only takes what's due (`DriftCheckService.sweep`). */
export const DRIFT_SWEEP_CRON = '7 * * * *';

/**
 * Phase 6d — the drift sweep's own queue and worker. Not the maintenance queue: its worker
 * runs every job there as the audit-retention sweep, and `JobsModule` can't import this
 * module (this one imports it). `upsertJobScheduler` is keyed by id, so every boot and every
 * replica converges on one schedule. Closed in `onModuleDestroy`, before Redis quits (see
 * `JobsRuntime`).
 */
@Injectable()
export class DriftSweepRuntime implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DriftSweepRuntime.name);
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(
    @Inject(BULL_CONNECTION) private readonly bull: BullConnection,
    private readonly drift: DriftCheckService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.queue = new Queue(QUEUE_DRIFT, this.bull);
    await this.queue.upsertJobScheduler(
      JOB_DRIFT_SWEEP,
      { pattern: DRIFT_SWEEP_CRON, tz: 'UTC' },
      { name: JOB_DRIFT_SWEEP, opts: DEFAULT_JOB_OPTIONS },
    );
    // One check at a time: each opens a database connection, maybe an SSH tunnel.
    this.worker = new Worker(QUEUE_DRIFT, () => this.drift.sweep(), {
      ...this.bull,
      concurrency: 1,
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('closing the drift sweep');
    await Promise.allSettled([this.worker?.close(), this.queue?.close()]);
  }
}
