import { BadRequestException } from '@nestjs/common';
import { SAML, ValidateInResponseTo, type CacheProvider, type Profile } from '@node-saml/node-saml';
import type Redis from 'ioredis';
import type * as OpenIdClientModule from 'openid-client' with { 'resolution-mode': 'import' };
import { resolveCheckedAddress } from '../introspect/address-guard';
import type { SsoConnectionRecord, SsoIdentity } from './sso.service';

/**
 * Roadmap 14 §1 — the two wire protocols, each behind a maintained library (Q9): nothing
 * about signatures, nonces or audiences is hand-rolled here.
 */

// ------------------------------------------------------------------------- OIDC

type OpenIdClient = typeof OpenIdClientModule;
let openIdClient: Promise<OpenIdClient> | undefined;
/** openid-client 6 is ESM-only and this package is CommonJS; a dynamic import bridges it. */
const oidcLib = (): Promise<OpenIdClient> => (openIdClient ??= import('openid-client'));

/**
 * Every request the OIDC client makes (discovery, JWKS, token) goes to a host an org owner
 * typed, so each one passes the same private-address guard as live database reads.
 * ponytail: the guard resolves, then fetch resolves again (DNS rebinding window); pin the
 * checked address with a custom dispatcher if an IdP host is ever hostile.
 */
function guardedFetch(allowPrivate: boolean) {
  return async (url: string, options: RequestInit): Promise<Response> => {
    await resolveCheckedAddress(new URL(url).hostname, allowPrivate);
    return fetch(url, options);
  };
}

async function oidcConfig(conn: SsoConnectionRecord, allowPrivate: boolean) {
  const client = await oidcLib();
  const issuer = new URL(conn.oidcIssuer ?? '');
  // Plain http only for a local IdP on an install that allows private hosts (dev, e2e).
  const insecure = issuer.protocol === 'http:';
  if (insecure && !allowPrivate) throw new BadRequestException({ code: 'sso_issuer_not_https' });
  return client.discovery(
    issuer,
    conn.oidcClientId ?? '',
    conn.oidcClientSecret ?? undefined,
    undefined,
    {
      [client.customFetch]: guardedFetch(allowPrivate),
      // Deprecated only as a warning sign; gated above to private-host installs.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      execute: insecure ? [client.allowInsecureRequests] : [],
      timeout: 10,
    },
  );
}

/** What the browser carries between start and callback, in the signed `sl_sso` cookie. */
export interface OidcPending {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
}

export async function oidcStart(
  conn: SsoConnectionRecord,
  redirectUri: string,
  allowPrivate: boolean,
): Promise<{ url: string; pending: OidcPending }> {
  const client = await oidcLib();
  const config = await oidcConfig(conn, allowPrivate);
  const verifier = client.randomPKCECodeVerifier();
  const pending = { state: client.randomState(), nonce: client.randomNonce(), verifier };
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: 'openid email profile',
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state: pending.state,
    nonce: pending.nonce,
  });
  return { url: url.href, pending };
}

/** Code → tokens → ID-token claims. The library checks state, nonce, PKCE, issuer, audience. */
export async function oidcFinish(
  conn: SsoConnectionRecord,
  callbackUrl: URL,
  pending: OidcPending,
  allowPrivate: boolean,
): Promise<SsoIdentity> {
  const client = await oidcLib();
  const config = await oidcConfig(conn, allowPrivate);
  const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
    pkceCodeVerifier: pending.verifier,
    expectedState: pending.state,
    expectedNonce: pending.nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (claims === undefined) throw new BadRequestException({ code: 'sso_no_id_token' });
  const email = typeof claims.email === 'string' ? claims.email : null;
  // An unverified address proves nothing (§1.2): no email, so only a known subject signs in.
  const verified = claims.email_verified === true;
  const name = typeof claims.name === 'string' ? claims.name : null;
  return {
    subject: claims.sub,
    email: verified ? email : null,
    name,
    groups: groupsOf(claims, conn.groupsClaim),
  };
}

/**
 * Roadmap 14b §2 — the values of the connection's groups claim (OIDC) or attribute (SAML):
 * a list or a single string. `undefined` when the connection has no groups claim (no sync);
 * an empty list when the IdP sent none, which removes the person from mapped groups.
 */
export function groupsOf(
  source: Record<string, unknown>,
  claim: string | null,
): readonly string[] | undefined {
  if (claim === null) return undefined;
  const raw = source[claim];
  const list: unknown[] = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return list.filter((v): v is string => typeof v === 'string');
}

// ------------------------------------------------------------------------- SAML

/** Our side of a SAML connection, as the IdP admin needs it (and as node-saml checks it). */
export function samlEndpoints(apiPublicUrl: string, connectionId: string) {
  const base = apiPublicUrl.replace(/\/+$/, '');
  return {
    entityId: `${base}/api/auth/sso/${connectionId}/saml/metadata`,
    acsUrl: `${base}/api/auth/sso/saml/acs`,
  };
}

/** `InResponseTo` bookkeeping in Redis, so a response is accepted once, on any api node. */
export function redisSamlCache(redis: Redis, ttlSec: number): CacheProvider {
  const k = (key: string) => `sso:saml:req:${key}`;
  return {
    async saveAsync(key, value) {
      await redis.set(k(key), value, 'EX', ttlSec);
      return { value, createdAt: Date.now() };
    },
    getAsync: (key) => redis.get(k(key)),
    async removeAsync(key) {
      if (key === null) return null;
      const value = await redis.get(k(key));
      await redis.del(k(key));
      return value;
    },
  };
}

export function samlClient(
  conn: SsoConnectionRecord,
  apiPublicUrl: string,
  cacheProvider: CacheProvider,
): SAML {
  const { entityId, acsUrl } = samlEndpoints(apiPublicUrl, conn.id);
  return new SAML({
    entryPoint: conn.samlEntryPoint ?? '',
    idpCert: conn.samlIdpCert ?? '',
    issuer: entityId,
    callbackUrl: acsUrl,
    audience: entityId,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: 10 * 60 * 1000,
    cacheProvider,
    acceptedClockSkewMs: 60_000,
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  });
}

/** The email from a SAML profile: an `email`/`mail` attribute, or an email-format NameID. */
export function samlIdentity(profile: Profile, groupsClaim: string | null): SsoIdentity {
  const attribute = [
    profile.email,
    profile.mail,
    profile['urn:oid:0.9.2342.19200300.100.1.3'],
  ].find((v): v is string => typeof v === 'string' && v.includes('@'));
  const fromNameId = profile.nameIDFormat.endsWith(':emailAddress') ? profile.nameID : undefined;
  const first = typeof profile.firstName === 'string' ? profile.firstName : undefined;
  const last = typeof profile.lastName === 'string' ? profile.lastName : undefined;
  return {
    subject: profile.nameID,
    email: attribute ?? fromNameId ?? null,
    name: [first, last].filter(Boolean).join(' ') || null,
    groups: groupsOf(profile, groupsClaim),
  };
}
