import type { PermissionAtom } from '@schemaloom/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { assertNotGuestManager, assertRoleUsable, grantableRole } from './access-write';

/** The two write-time guards every grant path shares: R3 + archival, and R9. */
const ORG = 'org_acme';
const role = (over: Record<string, unknown> = {}) => ({
  id: 'rl_analyst',
  key: 'analyst',
  name: 'Analyst',
  atoms: ['schema:view'],
  organizationId: ORG,
  isArchived: false,
  ...over,
});
const db = (found: unknown, member: unknown = null) =>
  ({
    role: { findFirst: vi.fn().mockResolvedValue(found) },
    orgMember: { findUnique: vi.fn().mockResolvedValue(member) },
  }) as unknown as PrismaService;

describe('grantableRole / assertRoleUsable (R3, archival)', () => {
  it('scopes the lookup to built-ins and the grant’s own org', async () => {
    const d = db(role());
    await expect(grantableRole(d, ORG, 'analyst')).resolves.toMatchObject({ id: 'rl_analyst' });
    expect((d.role.findFirst as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      where: { key: 'analyst', OR: [{ organizationId: null, isBuiltIn: true }, { organizationId: ORG }] },
    });
  });

  it('refuses another org’s role (role_cross_org), an archived role, and an unknown key', async () => {
    let crossOrg: unknown;
    try {
      assertRoleUsable(role({ organizationId: 'org_other' }), ORG);
    } catch (error) {
      crossOrg = error;
    }
    expect(crossOrg).toMatchObject({ status: 403, response: { code: 'role_cross_org' } });
    await expect(grantableRole(db(role({ isArchived: true })), ORG, 'analyst')).rejects.toMatchObject({
      response: { code: 'role_archived' },
    });
    await expect(grantableRole(db(null), ORG, 'nope')).rejects.toMatchObject({ response: { code: 'unknown_role' } });
  });

  it('accepts a built-in (organizationId null) from any org', () => {
    expect(() => {
      assertRoleUsable(role({ organizationId: null, key: 'viewer' }), ORG);
    }).not.toThrow();
  });
});

describe('assertNotGuestManager (R9)', () => {
  const manage = new Set<PermissionAtom>(['schema:view', 'sharing:manage']);
  const view = new Set<PermissionAtom>(['schema:view']);

  it('refuses sharing:manage to a guest user and to an email invite (a guest-to-be)', async () => {
    await expect(assertNotGuestManager(db(null, { role: 'guest' }), ORG, { type: 'user', id: 'u1' }, manage)).rejects.toMatchObject({
      response: { code: 'guest_cannot_manage' },
    });
    await expect(
      assertNotGuestManager(db(null), ORG, { type: 'email_invite', id: 'x@example.com' }, manage),
    ).rejects.toMatchObject({ response: { code: 'guest_cannot_manage' } });
  });

  it('lets a member manage and a guest view', async () => {
    await expect(assertNotGuestManager(db(null, { role: 'member' }), ORG, { type: 'user', id: 'u1' }, manage)).resolves.toBeUndefined();
    await expect(assertNotGuestManager(db(null, { role: 'guest' }), ORG, { type: 'user', id: 'u1' }, view)).resolves.toBeUndefined();
    await expect(assertNotGuestManager(db(null), ORG, { type: 'email_invite', id: 'x@example.com' }, view)).resolves.toBeUndefined();
  });
});
