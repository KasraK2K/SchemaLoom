import { describe, expect, it, vi } from 'vitest';
import type { PermissionResolver } from '../access';
import type { PrismaService } from '../prisma/prisma.service';
import { hashInviteToken } from './grants.service';
import { InvitationsService, collapseGrants } from './invitations.service';

/**
 * Doc 05 §11.2 — R11a both branches, and R11's ordering: membership before the grant is
 * converted, never a downgrade. Fakes record the call order, which is the property.
 */
const TOKEN = 'tok_raw';
const ORG = 'org_acme';
const USER = 'usr_bob';
const DAY = 24 * 60 * 60 * 1000;

const builtIn = (key: string) => ({ key, isBuiltIn: true });
const custom = (key: string) => ({ key, isBuiltIn: false });
const grant = (over: Partial<Parameters<typeof collapseGrants>[0]> & { roleId: string }) => ({
  role: builtIn('viewer'),
  canUseAi: false,
  canViewRestricted: false,
  expiresAt: null,
  ...over,
});

describe('collapseGrants (R11a)', () => {
  it('branch 1: two built-ins keep the higher role in the R2 chain, no review', () => {
    const existing = grant({ roleId: 'r_viewer', role: builtIn('viewer'), canUseAi: true });
    const pending = grant({ roleId: 'r_editor', role: builtIn('editor'), canViewRestricted: true });
    expect(collapseGrants(existing, pending)).toEqual({
      data: { roleId: 'r_editor', canUseAi: true, canViewRestricted: true, expiresAt: null },
      needsReview: false,
    });
    // ...and never a downgrade when the invite carries the lower one.
    expect(collapseGrants(pending, existing).data.roleId).toBe('r_editor');
  });

  it('branch 2: a custom role on either side keeps the existing role and asks for review', () => {
    const docsOnly = grant({ roleId: 'r_docs', role: custom('docs-only') });
    const analyst = grant({ roleId: 'r_analyst', role: custom('analyst-ro'), canUseAi: true });
    const manager = grant({ roleId: 'r_manager', role: builtIn('manager') });
    expect(collapseGrants(docsOnly, analyst)).toMatchObject({
      data: { roleId: 'r_docs', canUseAi: true },
      needsReview: true,
    });
    expect(collapseGrants(docsOnly, manager)).toMatchObject({ data: { roleId: 'r_docs' }, needsReview: true });
    expect(collapseGrants(manager, analyst)).toMatchObject({ data: { roleId: 'r_manager' }, needsReview: true });
  });

  it('keeps the longer expiry, and null (never) wins', () => {
    const soon = new Date(Date.now() + DAY);
    const later = new Date(Date.now() + 2 * DAY);
    const a = grant({ roleId: 'r1', expiresAt: soon });
    expect(collapseGrants(a, grant({ roleId: 'r1', expiresAt: later })).data.expiresAt).toBe(later);
    expect(collapseGrants(a, grant({ roleId: 'r1', expiresAt: null })).data.expiresAt).toBeNull();
  });
});

interface World {
  invitation?: Record<string, unknown> | null;
  user?: { email: string; emailVerifiedAt: Date | null };
  pending?: Record<string, unknown> | null;
  existing?: Record<string, unknown> | null;
}

function harness(world: World = {}) {
  const calls: string[] = [];
  const log =
    (name: string, value?: unknown) =>
    (arg?: unknown): Promise<unknown> => {
      calls.push(name);
      return Promise.resolve(typeof value === 'function' ? (value as (a: unknown) => unknown)(arg) : value);
    };
  const invitation =
    world.invitation === undefined
      ? {
          id: 'inv_1',
          organizationId: ORG,
          email: 'bob@example.com',
          orgRole: 'guest',
          accessGrantId: 'g_pending',
          acceptedAt: null,
          revokedAt: null,
          expiresAt: new Date(Date.now() + DAY),
          organization: { name: 'Acme', slug: 'acme', deletedAt: null },
        }
      : world.invitation;
  const pending =
    world.pending === undefined
      ? {
          id: 'g_pending',
          organizationId: ORG,
          projectId: 'prj_1',
          resourceType: 'project',
          resourceId: 'prj_1',
          roleId: 'r_editor',
          role: builtIn('editor'),
          canUseAi: false,
          canViewRestricted: false,
          expiresAt: null,
        }
      : world.pending;

  const orgMemberUpsert = vi.fn(log('orgMember.upsert'));
  const grantUpdate = vi.fn(log('accessGrant.update'));
  const grantDelete = vi.fn(log('accessGrant.delete'));
  const auditCreate = vi.fn(log('auditLog.create'));
  const invitationUpdate = vi.fn(log('invitation.update'));
  const userUpdate = vi.fn(log('user.update'));
  const invalidate = vi.fn().mockResolvedValue(undefined);

  const db = {
    $executeRaw: vi.fn(log('lock')),
    invitation: {
      findUnique: vi.fn(({ where }: { where: { tokenHash: string } }) =>
        Promise.resolve(where.tokenHash === hashInviteToken(TOKEN) ? invitation : null),
      ),
      update: invitationUpdate,
    },
    user: {
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue(world.user ?? { email: 'Bob@Example.com', emailVerifiedAt: new Date() }),
      update: userUpdate,
    },
    orgMember: { upsert: orgMemberUpsert },
    accessGrant: {
      findUnique: vi.fn(({ where }: { where: { id?: string } }) =>
        Promise.resolve(where.id !== undefined ? pending : (world.existing ?? null)),
      ),
      update: grantUpdate,
      delete: grantDelete,
    },
    auditLog: { create: auditCreate },
  };
  const prisma = { ...db, $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db) } as unknown as PrismaService;
  const service = new InvitationsService(prisma, { invalidate } as unknown as PermissionResolver);
  return { service, calls, orgMemberUpsert, grantUpdate, grantDelete, auditCreate, userUpdate, invalidate };
}

const actions = (audit: ReturnType<typeof vi.fn>) =>
  audit.mock.calls.map((c) => (c[0] as { data: { action: string } }).data.action);

describe('InvitationsService.accept (R11)', () => {
  it('upserts membership FIRST, never downgrading, then repoints the pending grant', async () => {
    const h = harness();
    const out = await h.service.accept(USER, TOKEN);

    expect(h.calls.indexOf('orgMember.upsert')).toBeLessThan(h.calls.indexOf('accessGrant.update'));
    expect(h.orgMemberUpsert.mock.calls[0]?.[0]).toMatchObject({
      update: {},
      create: { organizationId: ORG, userId: USER, role: 'guest' },
    });
    expect(h.grantUpdate.mock.calls[0]?.[0]).toEqual({
      where: { id: 'g_pending' },
      data: { principalType: 'user', principalId: USER },
    });
    expect(actions(h.auditCreate)).toEqual(['grant.invite_converted']);
    expect(h.userUpdate.mock.calls[0]?.[0]).toMatchObject({ data: { permGeneration: { increment: 1 } } });
    expect(h.invalidate).toHaveBeenCalledWith({ user: USER, project: 'prj_1' });
    expect(out).toEqual({ organizationId: ORG, orgSlug: 'acme', projectId: 'prj_1' });
  });

  it('collapses onto an existing custom-role grant and writes a review row', async () => {
    const h = harness({
      existing: {
        id: 'g_existing',
        roleId: 'r_docs',
        role: custom('docs-only'),
        canUseAi: false,
        canViewRestricted: false,
        expiresAt: null,
      },
    });
    await h.service.accept(USER, TOKEN);
    expect(h.grantUpdate.mock.calls[0]?.[0]).toMatchObject({ where: { id: 'g_existing' }, data: { roleId: 'r_docs' } });
    expect(h.grantDelete).toHaveBeenCalledWith({ where: { id: 'g_pending' } });
    expect(actions(h.auditCreate)).toEqual(['grant.invite_merge_review', 'grant.invite_converted']);
  });

  it('refuses an unverified email and a different email', async () => {
    await expect(
      harness({ user: { email: 'bob@example.com', emailVerifiedAt: null } }).service.accept(USER, TOKEN),
    ).rejects.toMatchObject({ response: { code: 'email_not_verified' } });
    const other = harness({ user: { email: 'eve@example.com', emailVerifiedAt: new Date() } });
    await expect(other.service.accept(USER, TOKEN)).rejects.toMatchObject({
      response: { code: 'invitation_email_mismatch' },
    });
    expect(other.orgMemberUpsert).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown', null],
    ['expired', { expiresAt: new Date(Date.now() - 1000) }],
    ['revoked', { revokedAt: new Date() }],
    ['accepted', { acceptedAt: new Date() }],
  ])('answers the same 404 for a %s token', async (_label, over) => {
    const base = {
      id: 'inv_1',
      organizationId: ORG,
      email: 'bob@example.com',
      accessGrantId: null,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() + DAY),
      organization: { name: 'Acme', slug: 'acme', deletedAt: null },
    };
    const h = harness({ invitation: over === null ? null : { ...base, ...over } });
    await expect(h.service.accept(USER, TOKEN)).rejects.toMatchObject({ status: 404 });
    await expect(h.service.view(TOKEN)).rejects.toMatchObject({ status: 404 });
  });
});
