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
});
export class RegisterDto extends createZodDto(registerSchema) {}

export const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
export class LoginDto extends createZodDto(loginSchema) {}

export const emailOnlySchema = z.object({ email });
export class EmailOnlyDto extends createZodDto(emailOnlySchema) {}

export const tokenSchema = z.object({ token: z.string().min(1).max(512) });
export class TokenDto extends createZodDto(tokenSchema) {}

export const resetPasswordSchema = z.object({ token: z.string().min(1).max(512), password });
export class ResetPasswordDto extends createZodDto(resetPasswordSchema) {}
