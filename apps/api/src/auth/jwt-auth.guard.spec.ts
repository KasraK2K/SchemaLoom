import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { getSubject } from './subject';
import { TokensService } from './tokens.service';

const config = {
  get: (key: keyof AppEnv) =>
    ({
      ACCESS_TOKEN_TTL: '15m',
      REFRESH_TOKEN_TTL: '30d',
      JWT_ACCESS_SECRET: 'access-secret-that-is-at-least-32-chars-long',
    })[key as string],
} as unknown as ConfigService<AppEnv, true>;

/** Stands in for the controller class the reflector would read metadata off. */
class AnonymousController {
  readonly name = 'AnonymousController';
}

function context(request: Request): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => () => undefined,
    getClass: () => AnonymousController,
  } as unknown as ExecutionContext;
}

function request(cookie?: string): Request {
  return { headers: cookie === undefined ? {} : { cookie } } as unknown as Request;
}

const reflector = (isPublic: boolean) =>
  ({ getAllAndOverride: () => (isPublic ? true : undefined) }) as unknown as Reflector;

let tokens: TokensService;

beforeEach(() => {
  tokens = new TokensService({} as PrismaService, new JwtService({}), config);
});

describe('JwtAuthGuard', () => {
  it('resolves a user subject in the shape doc 05 §7.1 specifies', async () => {
    const access = await tokens.issueAccessToken({ userId: 'u1', orgId: 'org1' });
    const req = request(`sl_access=${access}`);
    await new JwtAuthGuard(reflector(false), tokens).canActivate(context(req));

    expect(req.auth).toEqual({ kind: 'user', userId: 'u1', orgId: 'org1' });
    expect(getSubject(req)).toEqual({ kind: 'user', userId: 'u1', orgId: 'org1' });
  });

  it('resolves a share-link subject from sl_session', async () => {
    const { token } = await tokens.issueShareSession(
      { shareLinkId: 'l1', projectId: 'p1', resourceId: 'a1' },
      null,
    );
    const req = request(`sl_session=${token}`);
    await new JwtAuthGuard(reflector(false), tokens).canActivate(context(req));

    expect(req.auth).toEqual({
      kind: 'share_link',
      shareLinkId: 'l1',
      projectId: 'p1',
      resourceId: 'a1',
    });
    expect(getSubject(req)).toEqual({ kind: 'share_link', shareLinkId: 'l1', projectId: 'p1' });
  });

  it('authenticates an org-less user but hands the resolver no subject', async () => {
    const access = await tokens.issueAccessToken({ userId: 'u1', orgId: null });
    const req = request(`sl_access=${access}`);
    await new JwtAuthGuard(reflector(false), tokens).canActivate(context(req));

    expect(req.auth).toEqual({ kind: 'user', userId: 'u1', orgId: null });
    expect(getSubject(req)).toBeNull();
  });

  it('rejects an unauthenticated request on a guarded route', async () => {
    await expect(
      new JwtAuthGuard(reflector(false), tokens).canActivate(context(request())),
    ).rejects.toThrow();
  });

  it('lets a @Public() route through, and still names the caller when it can', async () => {
    const guard = new JwtAuthGuard(reflector(true), tokens);
    const anonymous = request();
    await expect(guard.canActivate(context(anonymous))).resolves.toBe(true);
    expect(anonymous.auth).toBeUndefined();

    const access = await tokens.issueAccessToken({ userId: 'u1', orgId: 'org1' });
    const known = request(`sl_access=${access}`);
    await guard.canActivate(context(known));
    expect(known.auth).toMatchObject({ userId: 'u1' });
  });

  it('ignores a forged access cookie rather than trusting it', async () => {
    const forged = new JwtService({});
    const token = await forged.signAsync(
      { org: 'org1' },
      { subject: 'u9', secret: 'a-different-secret-that-is-long-enough!!', audience: 'sl_access' },
    );
    await expect(
      new JwtAuthGuard(reflector(false), tokens).canActivate(context(request(`sl_access=${token}`))),
    ).rejects.toThrow();
  });
});
