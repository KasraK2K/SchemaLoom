import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AUDIT_STREAM_FORMATS } from './audit-stream.core';

/** Headers the api sets itself; the owner's auth header can't replace them. */
const RESERVED = /^(content-type|content-length|host|user-agent|x-schemaloom-.*)$/i;

export const auditStreamSchema = z.object({
  url: z.url({ protocol: /^https$/ }).max(2000),
  format: z.enum(AUDIT_STREAM_FORMATS),
  /** empty or absent: no auth header */
  authHeaderName: z
    .string()
    .trim()
    .max(100)
    .regex(/^[A-Za-z0-9-]*$/, 'letters, digits and dashes only')
    .refine((name) => !RESERVED.test(name), 'that header is set by SchemaLoom')
    .optional(),
  /** absent on an edit: the stored value is kept */
  authHeaderValue: z
    .string()
    .min(1)
    .max(4000)
    .regex(/^[^\r\n]*$/, 'one line')
    .optional(),
  paused: z.boolean().default(false),
});
export class AuditStreamDto extends createZodDto(auditStreamSchema) {}
