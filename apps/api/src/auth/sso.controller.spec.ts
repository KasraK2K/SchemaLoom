import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import type Redis from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../config/env';
import type { AuthService } from './auth.service';
import { SsoController } from './sso.controller';
import { samlResponseHints } from './sso.protocols';
import type { SsoConnectionRecord, SsoService } from './sso.service';

const API = 'https://app.test';
const SECRET = 'test-secret-test-secret-test-secret';
const ENV: Partial<AppEnv> = {
  API_PUBLIC_URL: API,
  WEB_PUBLIC_URL: API,
  INTROSPECT_ALLOW_PRIVATE_HOSTS: false,
  JWT_ACCESS_SECRET: SECRET,
};

const conn: SsoConnectionRecord = {
  id: 'cm1saml',
  organizationId: 'org_acme',
  protocol: 'saml',
  domains: ['acme.com'],
  oidcIssuer: null,
  oidcClientId: null,
  oidcClientSecret: null,
  samlEntryPoint: 'https://idp.acme.com/sso',
  samlIdpCert: 'MIIC',
  jit: false,
  defaultOrgRole: 'member',
  groupsClaim: null,
};

/** A SAML response as an IdP sends it, base64. Never signed: it must never get that far. */
const samlResponse = (o: { inResponseTo?: string; audience?: string } = {}) =>
  Buffer.from(
    `<?xml version="1.0"?><samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r1"${
      o.inResponseTo === undefined ? '' : ` InResponseTo="${o.inResponseTo}"`
    } Version="2.0"><saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">` +
      `<saml:Subject><saml:SubjectConfirmation><saml:SubjectConfirmationData InResponseTo="_x"/>` +
      `</saml:SubjectConfirmation></saml:Subject><saml:Conditions><saml:AudienceRestriction>` +
      `<saml:Audience>${o.audience ?? `${API}/api/auth/sso/${conn.id}/saml/metadata`}</saml:Audience>` +
      `</saml:AudienceRestriction></saml:Conditions></saml:Assertion></samlp:Response>`,
  ).toString('base64');

function harness() {
  const jwt = new JwtService();
  const sso = { record: vi.fn(() => Promise.resolve(conn)) };
  const redis = { set: vi.fn(), get: vi.fn(), del: vi.fn() };
  const config = { get: (k: keyof AppEnv) => ENV[k] };
  const controller = new SsoController(
    sso as unknown as SsoService,
    {} as AuthService,
    jwt,
    config as unknown as ConfigService<AppEnv, true>,
    redis as unknown as Redis,
  );
  const res = { redirect: vi.fn(), cookie: vi.fn(), clearCookie: vi.fn() };
  const cookie = (payload: object) =>
    jwt.sign(payload, { secret: SECRET, audience: 'sl_sso', expiresIn: 600 });
  const req = (token?: string) =>
    ({ headers: token === undefined ? {} : { cookie: `sl_sso=${token}` } }) as Request;
  return { controller, sso, res, cookie, req, jwt };
}

describe('samlResponseHints — routing only, never trust (roadmap 14c §3)', () => {
  it('reads InResponseTo from the Response, not from the assertion', () => {
    expect(samlResponseHints(samlResponse(), API)).toEqual({
      requested: false,
      connectionId: conn.id,
    });
    expect(samlResponseHints(samlResponse({ inResponseTo: '_req' }), API).requested).toBe(true);
  });

  it('names a connection only when the Audience is exactly our entity ID', () => {
    const other = samlResponse({
      audience: `https://evil.test/api/auth/sso/${conn.id}/saml/metadata`,
    });
    expect(samlResponseHints(other, API).connectionId).toBeNull();
    expect(samlResponseHints(samlResponse({ audience: 'urn:x' }), API).connectionId).toBeNull();
    expect(samlResponseHints('not base64 xml', API)).toEqual({
      requested: false,
      connectionId: null,
    });
  });
});

describe('SsoController.samlAcs — an unrequested response (roadmap 14c §3)', () => {
  it('is not processed: the browser bounces to the start route', async () => {
    const { controller, sso, res, req } = harness();
    await controller.samlAcs(req(), res as unknown as Response, { SAMLResponse: samlResponse() });
    expect(res.redirect).toHaveBeenCalledWith(`${API}/api/auth/sso/${conn.id}/start?bounce=1`);
    expect(sso.record).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('bounces when the sl_sso cookie belongs to another sign-in', async () => {
    const { controller, res, req, cookie } = harness();
    const token = cookie({ cid: conn.id, next: '/', rs: 'abc' });
    await controller.samlAcs(req(token), res as unknown as Response, {
      SAMLResponse: samlResponse(),
      RelayState: 'other',
    });
    expect(res.redirect).toHaveBeenCalledWith(`${API}/api/auth/sso/${conn.id}/start?bounce=1`);
  });

  it('refuses a second unrequested response after a bounce, so it cannot loop', async () => {
    const { controller, sso, res, req, cookie } = harness();
    const token = cookie({ cid: conn.id, next: '/', rs: 'abc', b: true });
    await controller.samlAcs(req(token), res as unknown as Response, {
      SAMLResponse: samlResponse(),
    });
    expect(res.redirect).toHaveBeenCalledWith(`${API}/login?sso_error=sso_state`);
    expect(sso.record).not.toHaveBeenCalled();
  });

  it('refuses a response to a request this browser did not make, and an unknown audience', async () => {
    for (const SAMLResponse of [
      samlResponse({ inResponseTo: '_someone_elses' }),
      samlResponse({ audience: 'urn:x' }),
    ]) {
      const { controller, sso, res, req } = harness();
      await controller.samlAcs(req(), res as unknown as Response, { SAMLResponse });
      expect(res.redirect).toHaveBeenCalledWith(`${API}/login?sso_error=sso_state`);
      expect(sso.record).not.toHaveBeenCalled();
    }
  });
});

describe('SsoController.start — the bounce target', () => {
  it('marks a bounced sign-in in sl_sso, and only then', async () => {
    for (const [bounce, b] of [
      ['1', true],
      [undefined, undefined],
    ] as const) {
      const { controller, res, jwt } = harness();
      await controller.start(conn.id, undefined, bounce, res as unknown as Response);
      expect(res.redirect).toHaveBeenCalledWith(
        expect.stringMatching(/^https:\/\/idp\.acme\.com\/sso\?/),
      );
      const token = res.cookie.mock.calls[0]?.[1] as string;
      const pending = jwt.verify<{ b?: true; rs: string }>(token, {
        secret: SECRET,
        audience: 'sl_sso',
      });
      expect(pending.b).toBe(b);
      expect(pending.rs).toEqual(expect.any(String));
    }
  });
});
