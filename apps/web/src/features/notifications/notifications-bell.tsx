'use client';

import {
  Bell,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  cn,
} from '@schemaloom/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { clientEnv } from '@/env.client';
import { useCanvasStore } from '@/features/canvas/store';
import { relativeTime } from '@/features/projects/relative-time';
import {
  entityOf,
  markAllRead,
  markRead,
  notificationsKey,
  notificationsQueryOptions,
  type NotificationItem,
} from './notifications-api';

/**
 * Phase 4 DESIGN §4 — the bell. Refetches on window focus and on `notification:new`,
 * which the gateway sends to this user's `user:<id>` room.
 *
 * ponytail: its own socket, beside the canvas's on project pages. Share one connection
 * if sockets per tab ever matter.
 */
export function NotificationsBell() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data } = useQuery(notificationsQueryOptions());

  useEffect(() => {
    const socket = io(clientEnv.NEXT_PUBLIC_API_URL, {
      transports: ['websocket'],
      withCredentials: true,
    });
    socket.on('notification:new', () => {
      void queryClient.invalidateQueries({ queryKey: notificationsKey });
    });
    return () => {
      socket.disconnect();
    };
  }, [queryClient]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: notificationsKey });
  const open = async (item: NotificationItem) => {
    if (item.readAt === null) await markRead(item.id).catch(() => undefined);
    void refresh();
    if (item.url === null) return;
    const entityId = entityOf(item);
    if (entityId !== null) useCanvasStore.getState().select([entityId]);
    router.push(item.url);
  };

  const unread = data?.unreadCount ?? 0;
  const items = data?.notifications ?? [];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={unread === 0 ? 'Notifications' : `Notifications, ${String(unread)} unread`}
        >
          <Bell className="size-4" aria-hidden="true" />
          {unread === 0 ? null : (
            <span className="absolute top-1 right-1 min-w-4 rounded-full bg-accent px-1 text-[0.625rem] leading-4 text-on-accent">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="flex items-center justify-between">
          Notifications
          {unread === 0 ? null : (
            <button
              type="button"
              className="text-xs font-normal text-accent-text hover:underline"
              onClick={() => void markAllRead().then(refresh)}
            >
              Mark all read
            </button>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.length === 0 ? (
          <p className="px-2 py-3 text-sm text-text-muted">Nothing yet.</p>
        ) : (
          items.map((item) => (
            <DropdownMenuItem
              key={item.id}
              className="flex flex-col items-start gap-0.5"
              onSelect={() => void open(item)}
            >
              <span
                className={cn(
                  'text-sm',
                  item.readAt === null ? 'font-medium text-text' : 'text-text-muted',
                )}
              >
                {item.title}
              </span>
              {item.body === null ? null : (
                <span className="line-clamp-2 text-xs text-text-muted">{item.body}</span>
              )}
              <span className="text-xs text-text-subtle">{relativeTime(item.createdAt)}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
