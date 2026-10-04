import { createHash } from 'node:crypto';
import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnv } from '../config/env';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Same scheme as `VerificationService`: only `sha256(token)` is stored. */
export function hashInviteToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Serialises "is this the first account?" so two people racing to be first cannot both win. */
const FIRST_ACCOUNT_LOCK = 16_0001;

export interface SignupProof {
  /** The token from an invitation link. Proves the inbox, so the new account is verified. */
  readonly inviteToken?: string;
  /** The caller already proved the address (a magic link, a verified OAuth email). */
  readonly emailProven: boolean;
  /**
   * Roadmap 14 §1.2: an org's own IdP vouched for the person and that connection has JIT on
   * for this domain (`SsoService` checks both). That org's invitation, in effect.
   */
  readonly ssoOrgId?: string;
}

/**
 * Roadmap 16 (`docs/phase16/DESIGN.md` §1): who may create an account. Every path that
 * inserts a `User` goes through `createUser`; there is no second way in.
 *
 * In `invite` mode an account is created only for the very first user, for a valid
 * invitation token naming this address, or for an address that is already proven AND has
 * a live invitation. A password sign-up never counts as proven: someone who merely knows
 * an invited address could otherwise register it first and lock the invitee out.
 */
@Injectable()
export class SignupPolicy {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  private get inviteOnly(): boolean {
    return this.config.get('SIGNUP_MODE', { infer: true }) === 'invite';
  }

  /** `GET /auth/signup-policy`: may a stranger use the sign-up form right now? */
  async isOpen(): Promise<boolean> {
    if (!this.inviteOnly) return true;
    return (await this.prisma.user.findFirst({ select: { id: true } })) === null;
  }

  /**
   * Runs `create` in a transaction once the policy allows it; `verified` says the invite
   * token proved the inbox. Throws 403 `signup_closed` otherwise.
   */
  createUser<T>(
    email: string,
    proof: SignupProof,
    create: (tx: Prisma.TransactionClient, verified: boolean) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const viaToken =
        proof.inviteToken !== undefined &&
        (await liveInvitation(tx, { email, tokenHash: hashInviteToken(proof.inviteToken) }));
      if (this.inviteOnly && !viaToken && proof.ssoOrgId === undefined) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FIRST_ACCOUNT_LOCK})`;
        const first = (await tx.user.findFirst({ select: { id: true } })) === null;
        const invited = proof.emailProven && (await liveInvitation(tx, { email }));
        if (!first && !invited) throw new ForbiddenException({ code: 'signup_closed' });
      }
      return create(tx, viaToken);
    });
  }
}

async function liveInvitation(
  tx: Prisma.TransactionClient,
  match: { email: string; tokenHash?: string },
): Promise<boolean> {
  const row = await tx.invitation.findFirst({
    where: {
      ...match,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      organization: { deletedAt: null },
    },
    select: { id: true },
  });
  return row !== null;
}
