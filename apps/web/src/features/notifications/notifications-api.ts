import {
  notificationPrefsStoredSchema,
  type NotificationPrefs,
  type NotificationPrefsPatch,
} from '@schemaloom/contracts';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from '@/lib/api-client';

/** Wire shapes of `apps/api/src/notifications`. */

const notificationSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  url: z.string().nullable(),
  data: z.unknown(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
export type NotificationItem = z.infer<typeof notificationSchema>;

const pageSchema = z.object({
  notifications: z.array(notificationSchema),
  unreadCount: z.number(),
  nextCursor: z.string().nullable(),
});
export type NotificationPage = z.infer<typeof pageSchema>;

export const notificationsKey = ['notifications'] as const;
export const notificationPrefsKey = ['auth', 'me', 'notification-prefs'] as const;

export function notificationsQueryOptions() {
  return queryOptions({
    queryKey: notificationsKey,
    queryFn: async (): Promise<NotificationPage> =>
      pageSchema.parse(await apiFetch<unknown>('/notifications')),
    // Without a socket the bell still catches up when the tab regains focus (DESIGN §4).
    refetchOnWindowFocus: true,
  });
}

export async function markRead(id: string): Promise<void> {
  await apiFetch<unknown>(`/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
}

export async function markAllRead(): Promise<void> {
  await apiFetch<unknown>('/notifications/read-all', { method: 'POST' });
}

export function notificationPrefsQueryOptions() {
  return queryOptions({
    queryKey: notificationPrefsKey,
    queryFn: async (): Promise<NotificationPrefs> =>
      notificationPrefsStoredSchema.parse(await apiFetch<unknown>('/auth/me/notification-prefs')),
  });
}

export async function updateNotificationPrefs(
  patch: NotificationPrefsPatch,
): Promise<NotificationPrefs> {
  return notificationPrefsStoredSchema.parse(
    await apiFetch<unknown>('/auth/me/notification-prefs', { method: 'PATCH', body: patch }),
  );
}

/** The canvas entity a comment notification points at, when there is one. */
export function entityOf(item: NotificationItem): string | null {
  const data = item.data as { entityId?: unknown } | null;
  return typeof data?.entityId === 'string' ? data.entityId : null;
}
