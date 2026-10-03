'use client';

import type { NotificationType } from '@schemaloom/contracts';
import {
  GitPullRequestArrow,
  Inbox,
  MessageSquare,
  TriangleAlert,
  Users,
  cn,
  type LucideIcon,
} from '@schemaloom/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { relativeTime } from '@/features/projects/relative-time';
import { markRead, notificationsKey, notificationsQueryOptions } from './notifications-api';

/** The notifications that ask the reader to do something, and how each looks. */
const ACTIONABLE: Partial<
  Record<NotificationType, { icon: LucideIcon; tone: 'accent' | 'warning' }>
> = {
  'change_request.review_requested': { icon: GitPullRequestArrow, tone: 'accent' },
  'change_request.reviewed': { icon: GitPullRequestArrow, tone: 'accent' },
  'access.requested': { icon: Users, tone: 'accent' },
  'comment.mentioned': { icon: MessageSquare, tone: 'accent' },
  'drift.detected': { icon: TriangleAlert, tone: 'warning' },
  'drift.check_failed': { icon: TriangleAlert, tone: 'warning' },
};

/**
 * The projects page's "Waiting on you": unread notifications that need an answer. Built on
 * the bell's own query, so it adds no request and can show nothing the bell would not.
 */
export function WaitingOnYou() {
  const queryClient = useQueryClient();
  const page = useQuery(notificationsQueryOptions());
  const read = useMutation({
    mutationFn: markRead,
    onSettled: () => queryClient.invalidateQueries({ queryKey: notificationsKey }),
  });
  const items = (page.data?.notifications ?? [])
    .filter((n) => n.readAt === null && n.type in ACTIONABLE)
    .slice(0, 5);

  return (
    <section
      aria-labelledby="waiting-on-you"
      className="rounded-lg border border-border bg-surface shadow-panel"
    >
      <h2
        id="waiting-on-you"
        className="flex items-center gap-2 border-b border-border px-4 py-3 text-sm font-semibold text-text"
      >
        <Inbox className="size-4 text-text-muted" aria-hidden="true" />
        Waiting on you
      </h2>
      {page.data === undefined ? (
        <div className="flex flex-col gap-3 p-4" aria-hidden="true">
          {[0, 1].map((i) => (
            <div key={i} className="flex gap-3">
              <div className="size-7 animate-pulse rounded-md bg-surface-sunken" />
              <div className="flex flex-1 flex-col gap-1.5">
                <div className="h-3 w-2/3 animate-pulse rounded bg-surface-sunken" />
                <div className="h-3 w-full animate-pulse rounded bg-surface-sunken" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="px-4 py-5 text-sm text-text-muted">
          Nothing needs you right now. Review requests, mentions and drift alerts show up here.
        </p>
      ) : (
        <ul>
          {items.map((n) => {
            const look = ACTIONABLE[n.type as NotificationType] ?? ACTIONABLE['comment.mentioned'];
            const Icon = look?.icon ?? Inbox;
            return (
              <li
                key={n.id}
                className="flex gap-3 border-t border-border px-4 py-3 first:border-t-0"
              >
                <span
                  className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded-md',
                    look?.tone === 'warning'
                      ? 'bg-warning-subtle text-warning-text'
                      : 'bg-accent-subtle text-accent-text',
                  )}
                >
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text">{n.title}</p>
                  {n.body !== null && <p className="text-xs text-text-muted">{n.body}</p>}
                  <div className="mt-1.5 flex items-center gap-3 text-xs">
                    {n.url !== null && (
                      <Link
                        href={n.url}
                        onClick={() => {
                          read.mutate(n.id);
                        }}
                        className="font-medium text-accent-text hover:underline"
                      >
                        Open
                      </Link>
                    )}
                    <span className="text-text-subtle">
                      <time dateTime={n.createdAt}>{relativeTime(n.createdAt)}</time>
                    </span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
