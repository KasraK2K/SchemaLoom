import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NotificationType } from '@schemaloom/contracts';
import { PermissionResolver, projectManagers } from '../access';
import type { AppEnv } from '../config/env';
import { QUEUED_IMPORT_MAX_BYTES } from '../jobs/import.processor';
import { NotificationsService } from '../notifications';
import { PrismaService } from '../prisma/prisma.service';
import { SnapshotsService } from '../snapshots';
import { IntrospectService } from './introspect.service';

/**
 * Phase 6d (docs/phase6/SCHEDULED-DRIFT.md) — the scheduled drift check: due connections, one
 * at a time, the same guarded read as Compare, and a notification to the project's managers
 * only when the drift CHANGES (D4). Notifications carry counts, never object names: a job has
 * no viewer to filter for (CLAUDE.md: schema data leaves through VisibilityFilter).
 */

export const DRIFT_SCHEDULES = ['off', 'daily', 'weekly'] as const;
export type DriftSchedule = (typeof DRIFT_SCHEDULES)[number];
export type CheckStatus = 'in_sync' | 'drift' | 'failed';

/** At most this many checks per sweep; the sweep runs hourly. */
export const SWEEP_BATCH = 20;

const HOUR = 3_600_000;

/** A connection is due when its last check is older than its interval (or it has none). */
export function dueCutoffs(now: Date): { readonly daily: Date; readonly weekly: Date } {
  return {
    daily: new Date(now.getTime() - 24 * HOUR),
    weekly: new Date(now.getTime() - 7 * 24 * HOUR),
  };
}

/**
 * D4 — what, if anything, to tell the managers. A failure is told once, and so is the
 * recovery; drift is told when its fingerprint differs from the last good check's.
 */
export function noticeFor(
  previous: { readonly status: string | null; readonly fingerprint: string | null },
  next: { readonly status: CheckStatus; readonly fingerprint: string | null },
): NotificationType | null {
  if (next.status === 'failed') return previous.status === 'failed' ? null : 'drift.check_failed';
  if (previous.status === 'failed') return 'drift.check_recovered';
  if (next.status === 'drift' && next.fingerprint !== previous.fingerprint) return 'drift.detected';
  return null;
}

interface DueRow {
  readonly projectId: string;
  readonly lastCheckStatus: string | null;
  readonly driftFingerprint: string | null;
  readonly project: { readonly organizationId: string; readonly name: string };
}

interface Counts { readonly added: number; readonly removed: number; readonly changed: number }

@Injectable()
export class DriftCheckService {
  private readonly logger = new Logger(DriftCheckService.name);
  private readonly enabled: boolean;

  constructor(
    config: ConfigService<AppEnv, true>,
    private readonly prisma: PrismaService,
    private readonly introspect: IntrospectService,
    private readonly snapshots: SnapshotsService,
    private readonly notifications: NotificationsService,
    private readonly resolver: PermissionResolver,
  ) {
    this.enabled = config.get('INTROSPECTION_ENABLED', { infer: true });
  }

  /** One sweep: the oldest due checks first. Returns how many ran. */
  async sweep(now: Date = new Date()): Promise<number> {
    if (!this.enabled) return 0;
    const { daily, weekly } = dueCutoffs(now);
    const due = (schedule: DriftSchedule, before: Date) => ({
      driftSchedule: schedule,
      OR: [{ lastCheckAt: null }, { lastCheckAt: { lt: before } }],
    });
    const rows: DueRow[] = await this.prisma.projectConnection.findMany({
      where: { project: { deletedAt: null }, OR: [due('daily', daily), due('weekly', weekly)] },
      orderBy: { lastCheckAt: { sort: 'asc', nulls: 'first' } },
      take: SWEEP_BATCH,
      select: {
        projectId: true,
        lastCheckStatus: true,
        driftFingerprint: true,
        project: { select: { organizationId: true, name: true } },
      },
    });
    for (const row of rows) {
      try {
        await this.check(row, now);
      } catch (error) {
        // One project (deleted mid-sweep, a database hiccup) must not stop the others.
        this.logger.error({ err: error, projectId: row.projectId }, 'drift check failed to record');
      }
    }
    return rows.length;
  }

  async check(row: DueRow, now: Date): Promise<CheckStatus> {
    let status: CheckStatus;
    let fingerprint: string | null = null;
    let counts: Counts | null = null;
    let failure = '';
    try {
      const { source } = await this.introspect.readScheduled(row.projectId);
      const summary = await this.snapshots.driftSummary(
        row.projectId,
        source,
        QUEUED_IMPORT_MAX_BYTES,
      );
      fingerprint = summary.fingerprint;
      counts = summary.counts;
      status = fingerprint === null ? 'in_sync' : 'drift';
    } catch (error) {
      status = 'failed';
      failure = reasonOf(error);
    }

    await this.prisma.projectConnection.update({
      where: { projectId: row.projectId },
      data: {
        lastCheckAt: now,
        lastCheckStatus: status,
        lastCheckSummary: counts === null ? { error: failure } : { ...counts },
        // A failure keeps the last good fingerprint, so recovering into the same drift is
        // "works again", not "new drift".
        ...(status === 'failed' ? {} : { driftFingerprint: fingerprint }),
      },
    });

    const notice = noticeFor(
      { status: row.lastCheckStatus, fingerprint: row.driftFingerprint },
      { status, fingerprint },
    );
    if (notice !== null) await this.notify(row, notice, counts, failure);
    return status;
  }

  private async notify(
    row: DueRow,
    type: NotificationType,
    counts: Counts | null,
    failure: string,
  ): Promise<void> {
    const { projectId, project } = row;
    const recipients = await projectManagers(
      this.resolver,
      this.prisma,
      projectId,
      project.organizationId,
    );
    const base = await this.notifications.projectUrl(projectId);
    const url = base === null ? null : `${base}/history?compare=saved`;
    const title = titleFor(project.name, type, counts, failure);
    await this.notifications.send(
      recipients.map((userId) => ({
        userId,
        actorUserId: null,
        organizationId: project.organizationId,
        projectId,
        type,
        title,
        url,
        // Counts only: the job has no viewer to redact object names for.
        data: counts === null ? { error: failure } : { ...counts },
      })),
    );
  }
}

const describe = (c: Counts): string => {
  const parts = [
    // The diff runs database → design: `added` is in the design but not the database.
    c.added > 0 ? `${String(c.added)} only in the design` : '',
    c.removed > 0 ? `${String(c.removed)} only in the database` : '',
    c.changed > 0 ? `${String(c.changed)} changed` : '',
  ].filter((p) => p !== '');
  return parts.length === 0 ? 'in sync' : parts.join(', ');
};

export function titleFor(
  projectName: string,
  type: NotificationType,
  counts: Counts | null,
  failure: string,
): string {
  if (type === 'drift.check_failed') return `${projectName}: the drift check failed (${failure})`;
  if (type === 'drift.check_recovered') {
    return `${projectName}: the drift check works again (${counts === null ? 'in sync' : describe(counts)})`;
  }
  return `${projectName}: the database differs from the design (${counts === null ? '' : describe(counts)})`;
}

/** The user-facing message of an `introspect.*` / `connection.*` error, never a stack. */
function reasonOf(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse() as { message?: unknown; code?: unknown };
    if (typeof response.message === 'string' && response.message !== '') return response.message;
    if (typeof response.code === 'string') return response.code;
  }
  return 'unexpected error';
}
