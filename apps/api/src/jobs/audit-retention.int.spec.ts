import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client';
import { sweepAuditLog } from './audit-retention.processor';

/**
 * Doc 00 Q10 against a real Postgres (`DATABASE_URL_TEST`, migrated by CI's
 * `db:deploy`): the sweep deletes audit rows older than 24 months and nothing else.
 */

const url = process.env.DATABASE_URL_TEST;
const TAG = 'retention-spec';
const NOW = new Date('2026-09-29T03:15:00Z');
const monthsAgo = (m: number): Date => {
  const d = new Date(NOW);
  d.setUTCMonth(d.getUTCMonth() - m);
  return d;
};

describe.skipIf(url === undefined)('audit retention sweep (doc 00 Q10)', () => {
  const db = new PrismaClient({ datasourceUrl: url });
  const orgId = `org_${TAG}`;

  beforeAll(async () => {
    await db.auditLog.deleteMany({});
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.organization.create({ data: { id: orgId, name: TAG, slug: TAG } });
    await db.auditLog.createMany({
      data: [
        { action: 'old.org_event', organizationId: orgId, createdAt: monthsAgo(25) },
        { action: 'old.user_2fa', resourceType: 'user', createdAt: monthsAgo(30) },
        { action: 'recent.org_event', organizationId: orgId, createdAt: monthsAgo(23) },
        { action: 'recent.user_2fa', resourceType: 'user', createdAt: monthsAgo(1) },
      ],
    });
  });

  afterAll(async () => {
    await db.auditLog.deleteMany({});
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.$disconnect();
  });

  it('deletes rows older than 24 months, keeps newer ones, and records the sweep', async () => {
    const { deleted } = await sweepAuditLog(db, NOW);
    expect(deleted).toBe(2);

    const left = (await db.auditLog.findMany({ select: { action: true, metadata: true } }))
      .map((r) => r.action)
      .sort();
    expect(left).toEqual(['audit.retention_swept', 'recent.org_event', 'recent.user_2fa']);

    const marker = await db.auditLog.findFirstOrThrow({
      where: { action: 'audit.retention_swept' },
    });
    expect(marker.metadata).toMatchObject({ deleted: 2, retentionMonths: 24 });

    // Only audit_log is touched: the organization is still there.
    expect(await db.organization.count({ where: { id: orgId } })).toBe(1);
  });

  it('writes no marker when there is nothing to delete', async () => {
    expect((await sweepAuditLog(db, NOW)).deleted).toBe(0);
    expect(await db.auditLog.count({ where: { action: 'audit.retention_swept' } })).toBe(1);
  });
});
