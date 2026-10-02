import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * NIST SP 800-63B: a minimum of 8 and a maximum no lower than 64, and no composition
 * rules — "at least one symbol" drives users to `Password1!` and buys nothing against
 * an offline attack that argon2id is already the defence for. 128 is the ceiling so a
 * megabyte POST cannot turn one request into a memory-hard denial of service.
 */
const password = z.string().min(8).max(128);
const email = z.email().max(254);

export const registerSchema = z.object({
  email,
  password,
  name: z.string().trim().min(1).max(120),
  /** From an invitation link: lets a closed install accept this sign-up (roadmap 16). */
  inviteToken: z.string().min(1).max(512).optional(),
});
export class RegisterDto extends createZodDto(registerSchema) {}

export const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
export class LoginDto extends createZodDto(loginSchema) {}

export const emailOnlySchema = z.object({ email });
export class EmailOnlyDto extends createZodDto(emailOnlySchema) {}

/**
 * `next` rides along in the emailed link so an invitee lands back on `/invite/…`. Same
 * rule as the web's `safeNextPath`: a same-origin path, never `//host` or `/\host`.
 */
export const magicLinkSchema = z.object({
  email,
  next: z
    .string()
    .max(512)
    .regex(/^\/(?![/\\])/)
    .optional(),
});
export class MagicLinkDto extends createZodDto(magicLinkSchema) {}

export const tokenSchema = z.object({ token: z.string().min(1).max(512) });
export class TokenDto extends createZodDto(tokenSchema) {}

export const resetPasswordSchema = z.object({ token: z.string().min(1).max(512), password });
export class ResetPasswordDto extends createZodDto(resetPasswordSchema) {}

export const switchOrgSchema = z.object({ organizationId: z.string().min(1).max(64) });
export class SwitchOrgDto extends createZodDto(switchOrgSchema) {}

/** A 6-digit TOTP code or a recovery code; `TwoFactorService` tells them apart. */
const code = z.string().trim().min(6).max(32);

export const codeSchema = z.object({ code });
export class CodeDto extends createZodDto(codeSchema) {}

export const disableTwoFactorSchema = z
  .object({ code: code.optional(), password: z.string().min(1).max(128).optional() })
  .refine((v) => v.code !== undefined || v.password !== undefined, {
    message: 'code or password is required',
  });
export class DisableTwoFactorDto extends createZodDto(disableTwoFactorSchema) {}
