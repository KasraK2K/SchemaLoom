import { z } from 'zod';
import { apiFetch } from '@/lib/api-client';

/**
 * The auth calls, all through `apiFetch` so the CSRF echo and `credentials: 'include'`
 * are not re-implemented per form.
 *
 * Deliberately NOT Next Server Actions: the API already owns authentication, and a
 * second hop through the Next server would be a second place to get cookie attributes,
 * CSRF and refresh rotation subtly wrong. The browser talks to the API directly and the
 * API sets the cookies.
 *
 * Cookies work across the two ports in dev because cookie scope is the registrable
 * domain, not the origin: `localhost:3001` sets them and `localhost:3000` sends them
 * back. Same-site is decided the same way, so `SameSite=Lax` holds.
 */

export const AuthUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  theme: z.string(),
  emailVerified: z.boolean(),
  twoFactorEnabled: z.boolean(),
  organizationId: z.string().nullable(),
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

/** Register also returns the CSRF token, because the caller has no cookie yet to read. */
const SessionSchema = z.object({
  csrfToken: z.string().optional(),
  user: AuthUserSchema,
});

/**
 * Every first-factor login (password, magic link) either finishes or, for an account
 * with 2FA, answers `{ mfaRequired: true }` and leaves a short-lived challenge cookie
 * for `/two-factor` to spend.
 */
const LoginResultSchema = z.union([
  z.object({ mfaRequired: z.literal(true) }),
  SessionSchema.transform(({ user }) => ({ mfaRequired: false as const, user })),
]);
export type LoginResult = z.infer<typeof LoginResultSchema>;

export async function signIn(email: string, password: string): Promise<LoginResult> {
  const data = await apiFetch<unknown>('/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  return LoginResultSchema.parse(data);
}

/** Always 202 from the API, known address or not. */
export async function requestMagicLink(email: string, next?: string): Promise<void> {
  await apiFetch<unknown>('/auth/magic-link', { method: 'POST', body: { email, next } });
}

export async function consumeMagicLink(token: string): Promise<LoginResult> {
  const data = await apiFetch<unknown>('/auth/magic-link/consume', {
    method: 'POST',
    body: { token },
  });
  return LoginResultSchema.parse(data);
}

/** A 6-digit TOTP code or a recovery code, against the challenge cookie. */
export async function verifyTwoFactor(code: string): Promise<void> {
  await apiFetch<unknown>('/auth/2fa/verify', { method: 'POST', body: { code } });
}

const ProvidersSchema = z.object({ google: z.boolean(), github: z.boolean() });
export type OAuthProviders = z.infer<typeof ProvidersSchema>;

export async function fetchOAuthProviders(): Promise<OAuthProviders> {
  return ProvidersSchema.parse(await apiFetch<unknown>('/auth/providers'));
}

/**
 * Where to send the browser after a first factor: straight on, or to the code prompt
 * carrying the same `next` so the second factor lands where the first was headed.
 */
export function afterFirstFactor(result: LoginResult, next: string | null): string {
  const target = safeNextPath(next);
  return result.mfaRequired ? `/two-factor?next=${encodeURIComponent(target)}` : target;
}

/** Roadmap 16: false once an invite-only install has its first account. */
export async function fetchSignupOpen(): Promise<boolean> {
  return z.object({ open: z.boolean() }).parse(await apiFetch<unknown>('/auth/signup-policy'))
    .open;
}

/** The address an invitation link is for; the sign-up form locks its email field to it. */
export async function fetchInvitedEmail(token: string): Promise<string> {
  return z
    .object({ email: z.string() })
    .parse(await apiFetch<unknown>(`/invitations/${encodeURIComponent(token)}`)).email;
}

export async function signUp(input: {
  email: string;
  password: string;
  name: string;
  inviteToken?: string;
}): Promise<AuthUser> {
  const data = await apiFetch<unknown>('/auth/register', {
    method: 'POST',
    body: input,
  });
  return SessionSchema.parse(data).user;
}

export async function signOut(): Promise<void> {
  await apiFetch<unknown>('/auth/logout', { method: 'POST' });
}

/**
 * Where to send the browser after a successful sign-in.
 *
 * `?next=` comes off the URL, so it is attacker-controlled: `?next=https://evil.test`
 * would turn our own login page into an open redirect, and a convincing one, because
 * the user really did just authenticate. Only a path on this origin is accepted.
 *
 * `//evil.test` is rejected too — it is protocol-relative and the browser reads it as a
 * different host, which is the version of this bug that survives a naive
 * `startsWith('/')` check.
 */
export function safeNextPath(next: string | null | undefined, fallback = '/'): string {
  if (next === null || next === undefined || next === '') return fallback;
  if (!next.startsWith('/')) return fallback;
  if (next.startsWith('//')) return fallback;
  // A backslash is normalised to a forward slash by some browsers, so `/\evil.test`
  // is the same trick wearing a different hat.
  if (next.startsWith('/\\')) return fallback;
  return next;
}
