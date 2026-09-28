import { describe, expect, it, vi } from 'vitest';
import type { PermissionResolver } from '../access';
import type { PrismaService } from '../prisma/prisma.service';
import { RolesService, validateCustomRole } from './roles.service';

const ORG = 'org_acme';
const USER = 'usr_ana';

/** What a synchronous call threw, so its Nest body can be matched. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('validateCustomRole (doc 05 §4.2)', () => {
  it('V1: a non-member is 404 and a member or guest is 403, before the input is read', () => {
    const junk = { atoms: ['not-an-atom'] };
    expect(thrown(() => validateCustomRole(junk, null))).toMatchObject({ status: 404 });
    expect(thrown(() => validateCustomRole(junk, 'member'))).toMatchObject({
      status: 403,
      response: { code: 'forbidden_org_role' },
    });
    expect(thrown(() => validateCustomRole(junk, 'guest'))).toMatchObject({ status: 403 });
  });

  it('V2: names every unknown atom', () => {
    expect(thrown(() => validateCustomRole({ atoms: ['docs:edit', 'root', 'sudo'] }, 'admin'))).toMatchObject({
      response: { code: 'unknown_atom', unknown: ['root', 'sudo'] },
    });
  });

  it('V3: closes over schema:view, dedupes, and stores in canonical order', () => {
    expect(validateCustomRole({ atoms: ['export:run', 'docs:edit', 'export:run'] }, 'owner')).toEqual([
      'schema:view',
      'docs:edit',
      'export:run',
    ]);
  });

  it('V4: an empty role is refused', () => {
    expect(thrown(() => validateCustomRole({ atoms: [] }, 'admin'))).toMatchObject({
      response: { code: 'empty_role' },
    });
  });
});

function harness(over: { orgRole?: string; grantCount?: number; role?: unknown } = {}) {
  const tx = {
    role: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'rl_new', description: null, isBuiltIn: false, isArchived: false, ...data }),
      ),
      update: vi.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...(over.role as object), ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) }),
      ),
      delete: vi.fn().mockResolvedValue({}),
    },
    accessGrant: { count: vi.fn().mockResolvedValue(over.grantCount ?? 0) },
    organization: { update: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    ...tx,
    role: { ...tx.role, findFirst: vi.fn().mockResolvedValue(over.role ?? null) },
    orgMember: {
      findFirst: vi.fn().mockResolvedValue({ organizationId: ORG, role: over.orgRole ?? 'admin' }),
    },
    $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaService;
  const invalidate = vi.fn().mockResolvedValue(undefined);
  return { service: new RolesService(prisma, { invalidate } as unknown as PermissionResolver), tx, invalidate };
}

const analyst = {
  id: 'rl_1',
  key: 'analyst',
  name: 'Analyst',
  description: null,
  atoms: ['schema:view', 'export:run'],
  isBuiltIn: false,
  isArchived: false,
};

describe('RolesService', () => {
  it('never lets a custom key shadow a built-in one', async () => {
    const h = harness();
    const view = await h.service.create(USER, 'acme', { name: 'Viewer', atoms: ['schema:view'] });
    expect(view.key).toBe('viewer-custom');
    expect(view.key).not.toBe('viewer');
  });

  it('refuses to delete a role in use with a 409 that counts the grants and offers archive', async () => {
    const h = harness({ role: analyst, grantCount: 3 });
    await expect(h.service.remove(USER, 'acme', 'rl_1')).rejects.toMatchObject({
      status: 409,
      response: { code: 'role_in_use', grants: 3, remedy: 'archive' },
    });
    expect(h.tx.role.delete).not.toHaveBeenCalled();
  });

  it('bumps the ORG generation when atoms change, and not for a rename or archive', async () => {
    const h = harness({ role: analyst });
    await h.service.update(USER, 'acme', 'rl_1', { atoms: ['docs:edit'] });
    expect(h.tx.organization.update).toHaveBeenCalledWith({
      where: { id: ORG },
      data: { permGeneration: { increment: 1 } },
    });
    expect(h.invalidate).toHaveBeenCalledWith({ org: ORG });

    const quiet = harness({ role: analyst });
    await quiet.service.update(USER, 'acme', 'rl_1', { name: 'Analysts', archived: true });
    expect(quiet.tx.organization.update).not.toHaveBeenCalled();
  });

  it('refuses every write to a plain member (V1)', async () => {
    const h = harness({ orgRole: 'member', role: analyst });
    await expect(h.service.update(USER, 'acme', 'rl_1', { archived: true })).rejects.toMatchObject({ status: 403 });
    await expect(h.service.remove(USER, 'acme', 'rl_1')).rejects.toMatchObject({ status: 403 });
  });
});
