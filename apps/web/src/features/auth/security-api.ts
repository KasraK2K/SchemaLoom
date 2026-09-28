import { z } from 'zod';
import { apiFetch } from '@/lib/api-client';
import { AuthUserSchema, type AuthUser } from './auth-api';

/** The account-security calls behind `/settings/security`. All need a signed-in user. */

export async function fetchMe(): Promise<AuthUser> {
  return AuthUserSchema.parse(await apiFetch<unknown>('/auth/me'));
}

const EnrolmentSchema = z.object({ secret: z.string(), otpauthUri: z.string() });
export type Enrolment = z.infer<typeof EnrolmentSchema>;

export async function enrolTwoFactor(): Promise<Enrolment> {
  return EnrolmentSchema.parse(await apiFetch<unknown>('/auth/2fa/enrol', { method: 'POST' }));
}

const RecoveryCodesSchema = z.object({ recoveryCodes: z.array(z.string()) });

export async function confirmTwoFactor(code: string): Promise<string[]> {
  const data = await apiFetch<unknown>('/auth/2fa/confirm', { method: 'POST', body: { code } });
  return RecoveryCodesSchema.parse(data).recoveryCodes;
}

export async function disableTwoFactor(proof: { code: string } | { password: string }): Promise<void> {
  await apiFetch<unknown>('/auth/2fa/disable', { method: 'POST', body: proof });
}

export async function regenerateRecoveryCodes(code: string): Promise<string[]> {
  const data = await apiFetch<unknown>('/auth/2fa/recovery-codes', {
    method: 'POST',
    body: { code },
  });
  return RecoveryCodesSchema.parse(data).recoveryCodes;
}

const DeviceSessionSchema = z.object({
  familyId: z.string(),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  signedInAt: z.string(),
  lastActiveAt: z.string(),
  current: z.boolean(),
});
export type DeviceSession = z.infer<typeof DeviceSessionSchema>;

export async function listSessions(): Promise<DeviceSession[]> {
  const data = await apiFetch<unknown>('/auth/sessions');
  return z.object({ sessions: z.array(DeviceSessionSchema) }).parse(data).sessions;
}

export async function revokeSession(familyId: string): Promise<void> {
  await apiFetch<unknown>(`/auth/sessions/${encodeURIComponent(familyId)}`, { method: 'DELETE' });
}

export async function revokeOtherSessions(): Promise<void> {
  await apiFetch<unknown>('/auth/sessions/revoke-others', { method: 'POST' });
}
