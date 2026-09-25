import { z } from 'zod';

/**
 * The only NEXT_PUBLIC_* schema. Everything here is inlined into the browser bundle by
 * the Next compiler, so nothing secret may ever be added to it.
 *
 * `process.env.NEXT_PUBLIC_API_URL` must be written as a literal member access —
 * Next replaces that exact text at build time and cannot see a dynamic lookup.
 */
const ClientEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.url().default('http://localhost:3001'),
});

export const clientEnv = ClientEnvSchema.parse({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
});
