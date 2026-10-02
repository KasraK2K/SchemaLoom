import type { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../config/env';
import type { MailService } from '../mail/mail.service';
import type { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import type { TokensService } from './tokens.service';
import type { TwoFactorService } from './two-factor.service';
import type { SignupPolicy } from './signup-policy';
import type { VerificationService } from './verification.service';

/** `usr_ana` belongs to `org_first` (joined first) and `org_second`. */
function service() {
  const memberships = ['org_first', 'org_second'];
  const prisma = {
    orgMember: {
      findFirst: vi.fn(({ where }: { where: { organizationId?: string } }) => {
        const id = where.organizationId ?? memberships[0];
        return Promise.resolve(memberships.includes(id ?? '') ? { organizationId: id } : null);
      }),
    },
  } as unknown as PrismaService;
  const tokens = {
    accessTtlSec: 900,
    issueAccessToken: vi.fn(({ orgId }: { orgId: string }) => Promise.resolve(`jwt:${orgId}`)),
  } as unknown as TokensService;
  return new AuthService(
    prisma,
    tokens,
    {} as VerificationService,
    {} as MailService,
    {} as ConfigService<AppEnv, true>,
    {} as TwoFactorService,
    {} as SignupPolicy,
  );
}

describe('active organisation', () => {
  it('honours the sl_org preference only for an org the user belongs to', async () => {
    const auth = service();
    expect(await auth.resolveOrgId('usr_ana', 'org_second')).toBe('org_second');
    expect(await auth.resolveOrgId('usr_ana', 'org_stranger')).toBe('org_first');
    expect(await auth.resolveOrgId('usr_ana')).toBe('org_first');
  });

  it('switches to a member org and 404s any other', async () => {
    const auth = service();
    expect(await auth.switchOrg('usr_ana', 'org_second')).toEqual({
      accessToken: 'jwt:org_second',
      accessTtlSec: 900,
    });
    await expect(auth.switchOrg('usr_ana', 'org_stranger')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
