import { notificationPrefsPatchSchema } from '@schemaloom/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class NotificationPrefsPatchDto extends createZodDto(notificationPrefsPatchSchema) {}

export const listNotificationsQuerySchema = z.object({
  cursor: z.string().min(1).max(64).optional(),
});
export class ListNotificationsQueryDto extends createZodDto(listNotificationsQuerySchema) {}
