import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { orgMembership } from './members.service';
import { OrganizationsService } from './organizations.service';

/** Roadmap 14 §2 — one row of Settings → Audit log. */
export interface AuditRow {
  readonly id: string;
  readonly createdAt: string;
  readonly action: string;
  /** null for a system event (retention sweep) */
  readonly actor: {
    readonly id: string | null;
    readonly name: string | null;
    readonly email: string | null;
  } | null;
  readonly project: { readonly id: string; readonly name: string } | null;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly ip: string | null;
  readonly metadata: Prisma.JsonValue;
}

export interface AuditFilters {
  /** a prefix: `grant.` matches every grant event */
  readonly action?: string;
  /** a user id, or the preserved email of a deleted user */
  readonly actor?: string;
  readonly projectId?: string;
  readonly from?: Date;
  readonly to?: Date;
  /** `nextCursor` of the previous page */
  readonly before?: string;
}

/** The query string's shape (`AuditQueryDto`): dates arrive as ISO strings. */
export function auditFilters(q: {
  readonly action?: string | undefined;
  readonly actor?: string | undefined;
  readonly projectId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly before?: string | undefined;
}): AuditFilters {
  return {
    ...(q.action === undefined ? {} : { action: q.action }),
    ...(q.actor === undefined ? {} : { actor: q.actor }),
    ...(q.projectId === undefined ? {} : { projectId: q.projectId }),
    ...(q.from === undefined ? {} : { from: new Date(q.from) }),
    ...(q.to === undefined ? {} : { to: new Date(q.to) }),
    ...(q.before === undefined ? {} : { before: q.before }),
  };
}

export const AUDIT_PAGE = 50;
export const AUDIT_CSV_CAP = 100_000;

/** The keyset cursor: newest first on `(created_at, id)`, which the org index serves. */
export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.toISOString()}_${row.id}`;
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const at = cursor.indexOf('_');
  const createdAt = new Date(cursor.slice(0, at));
  const id = cursor.slice(at + 1);
  if (at < 1 || Number.isNaN(createdAt.getTime()) || id === '')
    throw new BadRequestException({ code: 'invalid_cursor' });
  return { createdAt, id };
}

/**
 * The rows a caller may read, as a where clause. `visibleProjectIds` is null for an owner
 * (everything); an admin gets org-level rows and rows of projects they can open (R13). Rows of
 * other projects are left out, not masked, so the log is no existence oracle.
 */
export function auditWhere(
  organizationId: string,
  visibleProjectIds: readonly string[] | null,
  filters: AuditFilters,
): Prisma.AuditLogWhereInput {
  const and: Prisma.AuditLogWhereInput[] = [{ organizationId }];
  if (visibleProjectIds !== null)
    and.push({ OR: [{ projectId: null }, { projectId: { in: [...visibleProjectIds] } }] });
  if (filters.action !== undefined) and.push({ action: { startsWith: filters.action } });
  if (filters.actor !== undefined)
    and.push({ OR: [{ actorUserId: filters.actor }, { actorEmail: filters.actor }] });
  if (filters.projectId !== undefined) and.push({ projectId: filters.projectId });
  if (filters.from !== undefined) and.push({ createdAt: { gte: filters.from } });
  if (filters.to !== undefined) and.push({ createdAt: { lt: filters.to } });
  if (filters.before !== undefined) {
    const c = decodeCursor(filters.before);
    and.push({
      OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }],
    });
  }
  return { AND: and };
}

const SELECT = {
  id: true,
  createdAt: true,
  action: true,
  actorUserId: true,
  actorEmail: true,
  resourceType: true,
  resourceId: true,
  ip: true,
  metadata: true,
  actor: { select: { name: true, email: true } },
  project: { select: { id: true, name: true } },
} satisfies Prisma.AuditLogSelect;

type Selected = Prisma.AuditLogGetPayload<{ select: typeof SELECT }>;

function toRow(r: Selected): AuditRow {
  return {
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    action: r.action,
    actor:
      r.actorUserId === null && r.actorEmail === null
        ? null
        : { id: r.actorUserId, name: r.actor?.name ?? null, email: r.actor?.email ?? r.actorEmail },
    project: r.project,
    resourceType: r.resourceType,
    resourceId: r.resourceId,
    ip: r.ip,
    metadata: r.metadata,
  };
}

function csvCell(value: string | null): string {
  const text = value ?? '';
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const AUDIT_CSV_HEADER =
  'time,action,actor_email,actor_name,project,resource_type,resource_id,ip,metadata';

export function auditCsvLine(r: AuditRow): string {
  return [
    r.createdAt,
    r.action,
    r.actor?.email ?? null,
    r.actor?.name ?? null,
    r.project?.name ?? null,
    r.resourceType,
    r.resourceId,
    r.ip,
    JSON.stringify(r.metadata),
  ]
    .map(csvCell)
    .join(',');
}

@Injectable()
export class AuditLogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsService,
  ) {}

  /** Owners and admins (Q7). A non-member gets the 404 of a missing org. */
  private async scope(
    userId: string,
    orgSlug: string,
  ): Promise<{ organizationId: string; visible: string[] | null }> {
    const member = await orgMembership(this.prisma, userId, orgSlug);
    if (member === null) throw new NotFoundException({ code: 'not_found' });
    if (member.role !== 'owner' && member.role !== 'admin')
      throw new ForbiddenException({ code: 'forbidden_org_role', required: ['owner', 'admin'] });
    if (member.role === 'owner') return { organizationId: member.organizationId, visible: null };
    const projects = await this.organizations.listProjects(userId, orgSlug);
    return { organizationId: member.organizationId, visible: projects.map((p) => p.id) };
  }

  async page(
    userId: string,
    orgSlug: string,
    filters: AuditFilters,
  ): Promise<{ rows: AuditRow[]; nextCursor: string | null }> {
    const { organizationId, visible } = await this.scope(userId, orgSlug);
    const found = await this.prisma.auditLog.findMany({
      where: auditWhere(organizationId, visible, filters),
      select: SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: AUDIT_PAGE + 1,
    });
    const rows = found.slice(0, AUDIT_PAGE);
    const last = rows.at(-1);
    return {
      rows: rows.map(toRow),
      nextCursor: found.length > AUDIT_PAGE && last !== undefined ? encodeCursor(last) : null,
    };
  }

  /** CSV lines for the same filters, newest first, at most `AUDIT_CSV_CAP` rows (Q8). */
  async *csv(userId: string, orgSlug: string, filters: AuditFilters): AsyncGenerator<string> {
    const { organizationId, visible } = await this.scope(userId, orgSlug);
    yield `${AUDIT_CSV_HEADER}\n`;
    let before = filters.before;
    let written = 0;
    for (;;) {
      const batch = await this.prisma.auditLog.findMany({
        where: auditWhere(organizationId, visible, { ...filters, before }),
        select: SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: Math.min(1_000, AUDIT_CSV_CAP - written),
      });
      for (const r of batch) yield `${auditCsvLine(toRow(r))}\n`;
      written += batch.length;
      const last = batch.at(-1);
      if (last === undefined || batch.length < 1_000) return;
      if (written >= AUDIT_CSV_CAP) {
        yield `# stopped at ${String(AUDIT_CSV_CAP)} rows; narrow the dates for the rest\n`;
        return;
      }
      before = encodeCursor(last);
    }
  }
}
