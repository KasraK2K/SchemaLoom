import { expect, test } from '@playwright/test';
import { signIn, signedInPage, write, type Session } from '../fixtures/api';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * Phase 4 DESIGN §3-§4 — comments and notifications, end to end.
 *
 * The owner comments on `products` and @-mentions the analyst (who sees it) and the
 * freelancer (who does not: `products` is in the Catalog area). The analyst gets a
 * `comment.mentioned` notification and sees it in the bell; the freelancer gets nothing
 * and cannot read the thread (L17, invisible is 404).
 *
 * Cleans up in `finally`: the comment is deleted and its notification marked read (there
 * is no delete route for a notification).
 */
const P = SEED.projectId;
const PRODUCTS = SEED.entities.products;
const { member: analyst, guest: freelancer } = SEED.users;

const mention = (id: string, label: string) => ({ type: 'mention', attrs: { id, label } });

interface NotificationRow {
  id: string;
  type: string;
  title: string;
  data: { commentId?: string };
}

const inbox = async (session: Session): Promise<NotificationRow[]> => {
  const response = await session.api.get('/api/notifications');
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { notifications: NotificationRow[] }).notifications;
};

test.describe('workflow 8 — comments and notifications', () => {
  test('a mention notifies the viewer who can see the table, and nobody else', async ({
    browser,
  }) => {
    const owner = await signIn(SEED_EMAILS.owner);
    const reader = await signIn(SEED_EMAILS.analyst);
    const guest = await signIn(SEED_EMAILS.freelancer);

    const candidates = await owner.api.get(
      `/api/projects/${P}/comments/mention-candidates?targetType=entity&targetId=${PRODUCTS}`,
    );
    expect(candidates.status()).toBe(200);
    const ids = ((await candidates.json()) as { users: { id: string }[] }).users.map((u) => u.id);
    expect(ids).toContain(analyst.id);
    expect(ids).not.toContain(freelancer.id);

    const created = await owner.api.post(`/api/projects/${P}/comments`, {
      headers: write(owner),
      data: {
        targetType: 'entity',
        targetId: PRODUCTS,
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Please review ' },
                mention(analyst.id, analyst.name),
                mention(freelancer.id, freelancer.name),
              ],
            },
          ],
        },
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const commentId = ((await created.json()) as { id: string }).id;
    let notificationId: string | undefined;

    try {
      const mine = (await inbox(reader)).find((n) => n.data.commentId === commentId);
      notificationId = mine?.id;
      expect(mine?.type).toBe('comment.mentioned');
      expect(mine?.title).toContain('mentioned you');
      expect((await inbox(guest)).some((n) => n.data.commentId === commentId)).toBe(false);

      const hidden = await guest.api.get(
        `/api/projects/${P}/comments?targetType=entity&targetId=${PRODUCTS}`,
      );
      expect(hidden.status()).toBe(404);

      // The bell shows it.
      const page = await signedInPage(browser, SEED_EMAILS.analyst);
      await page.goto(`/${SEED.orgSlug}`);
      await page.getByRole('button', { name: /Notifications, \d+ unread/ }).click();
      await expect(page.getByText(mine?.title ?? '').first()).toBeVisible({ timeout: 15_000 });
    } finally {
      const removed = await owner.api.delete(`/api/comments/${commentId}`, {
        headers: write(owner),
      });
      expect(removed.status()).toBe(204);
      if (notificationId !== undefined) {
        await reader.api.post(`/api/notifications/${notificationId}/read`, {
          headers: write(reader),
        });
      }
    }
  });
});
