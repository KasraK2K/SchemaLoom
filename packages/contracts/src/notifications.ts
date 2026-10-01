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
  // Phase 6d — scheduled drift checks
  'drift.detected',
  'drift.check_failed',
  'drift.check_recovered',
  // Phase 10 — change requests
  'change_request.review_requested',
  'change_request.reviewed',
  'change_request.merged',
] as const;

export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * `users.notification_prefs` (doc 02 §7). Declared once, exported twice: `Input` (.strict())
 * validates a client write, `Stored` (.strip()) reads a row back so a renamed key never
 * turns into an outage. `inAppDigest` stays unbuilt (Phase 4 DESIGN §4).
 */
const notificationPrefsShape = {
  emailMentions: z.boolean().default(true),
  emailInvites: z.boolean().default(true),
  emailAccessRequests: z.boolean().default(true),
  emailCommentReplies: z.boolean().default(true),
  emailDrift: z.boolean().default(true),
  emailChangeRequests: z.boolean().default(true),
  inAppDigest: z.enum(['off', 'daily', 'weekly']).default('off'),
};
export const notificationPrefsInputSchema = z.object(notificationPrefsShape).strict();
export const notificationPrefsStoredSchema = z.object(notificationPrefsShape);
export type NotificationPrefs = z.infer<typeof notificationPrefsStoredSchema>;

/** `PATCH /auth/me/notification-prefs` — only the keys sent change; no defaults applied. */
export const notificationPrefsPatchSchema = z
  .object({
    emailMentions: z.boolean(),
    emailInvites: z.boolean(),
    emailAccessRequests: z.boolean(),
    emailCommentReplies: z.boolean(),
    emailDrift: z.boolean(),
    emailChangeRequests: z.boolean(),
  })
  .partial()
  .strict();
export type NotificationPrefsPatch = z.infer<typeof notificationPrefsPatchSchema>;

/** Phase 4 comments target a table or a column only (doc 05 §7.8). */
export const COMMENT_TARGET_TYPES = ['entity', 'field'] as const;
export const commentTargetTypeSchema = z.enum(COMMENT_TARGET_TYPES);
export type CommentTargetType = (typeof COMMENT_TARGET_TYPES)[number];
