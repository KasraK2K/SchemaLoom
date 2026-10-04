import { describe, expect, it } from 'vitest';
import { auditCsvLine, auditWhere, encodeCursor, type AuditRow } from './audit-log.service';

describe('auditWhere (roadmap 14 §2)', () => {
  it('gives an owner every row of the org', () => {
    expect(auditWhere('org1', null, {})).toEqual({ AND: [{ organizationId: 'org1' }] });
  });

  it('gives an admin org-level rows and rows of projects they can open, nothing else (R13)', () => {
    const where = auditWhere('org1', ['p1', 'p2'], {});
    expect(where.AND).toContainEqual({
      OR: [{ projectId: null }, { projectId: { in: ['p1', 'p2'] } }],
    });
  });

  it('an admin who can open no project still sees org-level rows only', () => {
    expect(auditWhere('org1', [], {}).AND).toContainEqual({
      OR: [{ projectId: null }, { projectId: { in: [] } }],
    });
  });

  it('filters by action prefix, actor id or preserved email, project and dates', () => {
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date('2026-10-02T00:00:00Z');
    const and = auditWhere('org1', null, {
      action: 'grant.',
      actor: 'gone@acme.test',
      projectId: 'p1',
      from,
      to,
    }).AND;
    expect(and).toContainEqual({ action: { startsWith: 'grant.' } });
    expect(and).toContainEqual({
      OR: [{ actorUserId: 'gone@acme.test' }, { actorEmail: 'gone@acme.test' }],
    });
    expect(and).toContainEqual({ projectId: 'p1' });
    expect(and).toContainEqual({ createdAt: { gte: from } });
    expect(and).toContainEqual({ createdAt: { lt: to } });
  });

  it('pages on (createdAt, id), newest first, with ties broken by id', () => {
    const at = new Date('2026-10-04T10:00:00.000Z');
    const and = auditWhere('org1', null, { before: encodeCursor({ createdAt: at, id: 'b' }) }).AND;
    expect(and).toContainEqual({
      OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: 'b' } }],
    });
  });

  it('refuses a cursor it did not make', () => {
    expect(() => auditWhere('org1', null, { before: 'nonsense' })).toThrow();
  });
});

describe('auditCsvLine', () => {
  const row: AuditRow = {
    id: 'a1',
    createdAt: '2026-10-04T10:00:00.000Z',
    action: 'grant.updated',
    actor: { id: 'u1', name: 'Kim, "K"', email: 'kim@acme.test' },
    project: { id: 'p1', name: 'Billing' },
    resourceType: 'entity',
    resourceId: 'e1',
    ip: null,
    metadata: { from: 'viewer', to: 'editor' },
  };

  it('quotes commas and quotes, and keeps metadata as JSON', () => {
    expect(auditCsvLine(row)).toBe(
      '2026-10-04T10:00:00.000Z,grant.updated,kim@acme.test,"Kim, ""K""",Billing,entity,e1,,' +
        '"{""from"":""viewer"",""to"":""editor""}"',
    );
  });
});
