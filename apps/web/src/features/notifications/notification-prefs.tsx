'use client';

import type { NotificationPrefs, NotificationPrefsPatch } from '@schemaloom/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notificationPrefsKey, notificationPrefsQueryOptions, updateNotificationPrefs } from './notifications-api';

const EMAIL_PREFS: readonly { key: keyof NotificationPrefsPatch; label: string }[] = [
  { key: 'emailMentions', label: 'Someone mentions me in a comment' },
  { key: 'emailCommentReplies', label: 'Someone replies in a thread I am part of' },
  { key: 'emailAccessRequests', label: 'Access requests and their decisions' },
  { key: 'emailInvites', label: 'Something is shared with me' },
];

/** Phase 4 Q3 — immediate email per type; the bell always gets every notification. */
export function NotificationPrefsSection() {
  const queryClient = useQueryClient();
  const prefs = useQuery(notificationPrefsQueryOptions());
  const save = useMutation({
    mutationFn: updateNotificationPrefs,
    onSuccess: (next: NotificationPrefs) => {
      queryClient.setQueryData(notificationPrefsKey, next);
    },
  });

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold text-text">Email notifications</h2>
      <p className="text-sm text-text-muted">Send me an email when:</p>
      {prefs.data === undefined ? (
        <p className="text-sm text-text-subtle">{prefs.isError ? 'Could not load your preferences.' : 'Loading…'}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {EMAIL_PREFS.map(({ key, label }) => (
            <li key={key}>
              <label className="flex items-center gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  checked={prefs.data[key]}
                  disabled={save.isPending}
                  onChange={(e) => {
                    save.mutate({ [key]: e.target.checked });
                  }}
                />
                {label}
              </label>
            </li>
          ))}
        </ul>
      )}
      {save.isError ? (
        <p role="alert" className="text-sm text-danger-text">
          Could not save. Try again.
        </p>
      ) : null}
    </section>
  );
}
