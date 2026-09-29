import { Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Doc 00 Q10, decided 2026-09-29: audit-log rows are kept this long, then deleted. */
export const AUDIT_RETENTION_MONTHS = 24;

/** Cron for the nightly sweep (03:15 UTC). */
export const AUDIT_RETENTION_CRON = '15 3 * * *';

/**
 * Doc 00 Q10: deletes every `audit_log` row older than 24 months, for live and deleted
 * organizations alike. It touches `audit_log` only; users, organizations and roles are not
 * affected.
 *
 * Reviewable: every sweep that deletes anything records one `audit.retention_swept` row
 * with the count and the cutoff.
 */
@Injectable()
export class AuditRetentionProcessor {
  private readonly logger = new Logger(AuditRetentionProcessor.name);

  constructor(private readonly prisma: PrismaService) {}

  async run(now: Date = new Date()): Promise<{ deleted: number }> {
    return sweepAuditLog(this.prisma, now, this.logger);
  }
}

/** The sweep itself, on a bare client, so the integration spec runs it without Nest. */
export async function sweepAuditLog(
  db: Pick<PrismaClient, '$transaction'>,
  now: Date,
  logger?: Pick<Logger, 'log'>,
): Promise<{ deleted: number }> {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - AUDIT_RETENTION_MONTHS);

  // ponytail: one DELETE per night. The first run on a long-lived database may remove a lot
  // of rows at once; batch by id if that ever holds a lock for too long.
  const deleted = await db.$transaction(async (tx) => {
    const { count } = await tx.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    if (count > 0) {
      await tx.auditLog.create({
        data: {
          action: 'audit.retention_swept',
          resourceType: 'audit_log',
          metadata: {
            deleted: count,
            cutoff: cutoff.toISOString(),
            retentionMonths: AUDIT_RETENTION_MONTHS,
          },
        },
      });
    }
    return count;
  });

  logger?.log(
    `audit retention: deleted ${String(deleted)} row(s) older than ${cutoff.toISOString()}`,
  );
  return { deleted };
}
