import { z } from 'zod';

/**
 * Open dotted-verb set, mirroring `activity_log.action`.
 *
 * Stored as `notifications.type String`, validated here — the `notification_type`
 * PostgreSQL enum was cut for the same reason as `permission_atom`: adding a
 * value and using it in one migration is not expressible in a single transaction.
 */
export const NOTIFICATION_TYPES = [
  'org.invited',
  'resource.shared',
  'comment.mentioned',
  'comment.replied',
  'access.requested',
  'access.decided',
  'ai.job_finished',
  'export.ready',
] as const;

export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
