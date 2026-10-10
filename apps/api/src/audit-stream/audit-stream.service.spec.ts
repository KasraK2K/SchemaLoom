import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../config/env';
import type { NotificationsService } from '../notifications';
import type { PrismaService } from '../prisma/prisma.service';
import { AuditStreamService } from './audit-stream.service';

/** §5 / Q4: owners only. An admin, a member or a stranger gets the 404 of a missing org. */
describe('AuditStreamService: owners only', () => {
  const service = (role: string | null) => {
    const prisma = {
      orgMember: {
        findFirst: vi.fn().mockResolvedValue(role === null ? null : { organizationId: 'o1', role }),
      },
      auditStream: { findUnique: vi.fn() },
      $transaction: vi.fn(),
    };
    const config = { get: vi.fn() } as unknown as ConfigService<AppEnv, true>;
    return {
      prisma,
      svc: new AuditStreamService(
        prisma as unknown as PrismaService,
        config,
        {} as NotificationsService,
      ),
    };
  };

  const calls = (svc: AuditStreamService) => [
    () => svc.get('u1', 'acme'),
    () => svc.put('u1', 'acme', { url: 'https://siem.example.com', format: 'json', paused: false }),
    () => svc.test('u1', 'acme'),
    () => svc.remove('u1', 'acme'),
  ];

  for (const role of ['admin', 'member', 'guest', null]) {
    it(`${role ?? 'a non-member'} gets 404 on all four`, async () => {
      const { svc, prisma } = service(role);
      for (const call of calls(svc)) await expect(call()).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.auditStream.findUnique).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  }

  it('an owner gets through', async () => {
    const { svc, prisma } = service('owner');
    prisma.auditStream.findUnique.mockResolvedValue(null);
    await expect(svc.get('u1', 'acme')).resolves.toEqual({ stream: null });
  });
});
