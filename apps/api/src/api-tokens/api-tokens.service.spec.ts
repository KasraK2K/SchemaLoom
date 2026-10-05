import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PermissionAtom } from '@schemaloom/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionResolver, ProjectPermissionMap } from '../access';
import { hashApiToken } from '../auth';
import type { PrismaService } from '../prisma/prisma.service';
import { ApiTokensService } from './api-tokens.service';

const mapOf = (atoms: readonly PermissionAtom[]): ProjectPermissionMap => ({
  projectId: 'p1',
  subjectKey: 'u:x',
  orgRole: 'member',
  projectAtoms: new Set(atoms),
  areaAtoms: new Map(),
  entityOverrides: new Map(),
  restrictedFieldMode: 'mask',
  validUntil: Date.now() + 60_000,
});

const ROW = {
  id: 't1',
  userId: 'owner',
  projectId: 'p1',
  name: 'CI',
  prefix: 'abcdefgh',
  scopes: ['read'],
  tokenHash: 'h',
  expiresAt: new Date('2027-01-01'),
  lastUsedAt: null,
  revokedAt: null,
  createdAt: new Date('2026-10-01'),
  project: { name: 'Shop', organizationId: 'org1' },
};

function setup(map = mapOf([])) {
  const prisma = {
    project: { findUniqueOrThrow: vi.fn().mockResolvedValue({ organizationId: 'org1' }) },
    apiToken: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...ROW, ...data, id: 't2' }),
      ),
      findFirst: vi.fn().mockResolvedValue(ROW),
      update: vi.fn().mockResolvedValue(ROW),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const resolver = {
    resolveProject: vi.fn().mockResolvedValue(map),
    // One table with a restricted column: a complete view needs field:viewRestricted.
    skeleton: vi.fn().mockResolvedValue({
      generation: 1,
      areaIds: [],
      entities: [{ id: 'e1', areaId: null }],
      entityById: new Map([['e1', { id: 'e1', areaId: null }]]),
      entitiesWithRestrictedFields: new Set(['e1']),
    }),
  };
  const service = new ApiTokensService(
    prisma as unknown as PrismaService,
    resolver as unknown as PermissionResolver,
  );
  return { service, prisma };
}

const input = { name: 'CI', scopes: ['read'] as const, expiresInDays: 90 };
const user = (userId: string) => ({ kind: 'user', userId, orgId: 'org1' }) as const;

describe('ApiTokensService.create (Phase 11 §3)', () => {
  it('returns the secret once and stores only its hash and prefix', async () => {
    const { service, prisma } = setup();
    const created = await service.create('owner', 'p1', mapOf(['schema:view']), input);

    expect(created.secret).toMatch(/^slt_[A-Za-z0-9_-]{43}$/);
    const data = prisma.apiToken.create.mock.calls[0]![0].data;
    expect(data.tokenHash).toBe(hashApiToken(created.secret));
    expect(data.prefix).toBe(created.secret.slice(4, 12));
    expect(JSON.stringify(data)).not.toContain(created.secret);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'api_token.created' }) }),
    );
  });

  it('refuses the drift scope to someone without schema:edit', async () => {
    const { service } = setup();
    await expect(
      service.create('owner', 'p1', mapOf(['schema:view']), {
        ...input,
        scopes: ['read', 'drift'],
      }),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.create('owner', 'p1', mapOf(['schema:view', 'schema:edit']), {
        ...input,
        scopes: ['read', 'drift'],
      }),
    ).resolves.toMatchObject({ scopes: ['read', 'drift'] });
  });

  it('agent (Phase 21 §3) needs ai:use and the project AI switch on', async () => {
    const agent = { ...input, scopes: ['read', 'agent'] as const };
    await expect(
      setup().service.create('owner', 'p1', mapOf(['schema:view']), agent),
    ).rejects.toMatchObject({ response: { code: 'forbidden', atom: 'ai:use' } });

    const off = setup();
    off.prisma.project.findUniqueOrThrow.mockResolvedValue({
      organizationId: 'org1',
      settings: { ai: { enabled: false } },
    });
    await expect(
      off.service.create('owner', 'p1', mapOf(['schema:view', 'ai:use']), agent),
    ).rejects.toMatchObject({ response: { code: 'ai_disabled' } });
    expect(off.prisma.apiToken.create).not.toHaveBeenCalled();

    await expect(
      setup().service.create('owner', 'p1', mapOf(['schema:view', 'ai:use']), agent),
    ).resolves.toMatchObject({ scopes: ['read', 'agent'] });
  });

  it('propose (§9.4) also needs comment:create and a complete view', async () => {
    const propose = { ...input, scopes: ['read', 'agent', 'propose'] as const };
    const base = ['schema:view', 'ai:use'] as const;
    for (const atoms of [
      [...base, 'field:viewRestricted'],
      [...base, 'comment:create'],
    ] as PermissionAtom[][]) {
      await expect(setup().service.create('owner', 'p1', mapOf(atoms), propose)).rejects.toThrow(
        ForbiddenException,
      );
    }
    await expect(
      setup().service.create(
        'owner',
        'p1',
        mapOf([...base, 'comment:create', 'field:viewRestricted']),
        propose,
      ),
    ).resolves.toMatchObject({ scopes: ['read', 'agent', 'propose'] });
  });
});

describe('ApiTokensService.revoke (Phase 11 §3)', () => {
  it('lets the owner revoke, and audits it', async () => {
    const { service, prisma } = setup();
    await service.revoke(user('owner'), 't1');
    expect(prisma.apiToken.update).toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'api_token.revoked' }) }),
    );
  });

  it('lets a sharing manager of the project revoke someone else’s token', async () => {
    const { service, prisma } = setup(mapOf(['schema:view', 'sharing:manage']));
    await service.revoke(user('manager'), 't1');
    expect(prisma.apiToken.update).toHaveBeenCalled();
  });

  it('404s anyone else, whether or not they can see the project', async () => {
    for (const map of [mapOf([]), mapOf(['schema:view', 'schema:edit'])]) {
      const { service, prisma } = setup(map);
      await expect(service.revoke(user('stranger'), 't1')).rejects.toThrow(NotFoundException);
      expect(prisma.apiToken.update).not.toHaveBeenCalled();
    }
  });
});
