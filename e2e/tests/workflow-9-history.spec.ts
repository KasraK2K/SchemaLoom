import { expect, test } from '@playwright/test';
import { signIn, signedInPage, write, type Session } from '../fixtures/api';
import { fetchIr } from '../fixtures/ir';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * Phase 4 §1–§2 against the real API: a snapshot, an edit, the live diff showing it, and a
 * SQL re-import whose confirmed rename keeps the table's id.
 *
 * Restores the pre-test snapshot at the end, so the seed is exactly as it was for any
 * later workflow (the restore itself leaves one `restore` auto snapshot behind, like
 * workflow 5 leaves its manual ones).
 */

const P = SEED.projectId;
const tag = String(Date.now());
const OLD = `w9_customer_${tag}`;
const NEW = `w9_customers_${tag}`;
// Distinctive column names, so no seed table is a better rename candidate.
const columns = '(w9_id int4, w9_email text, w9_name text)';

interface Diff {
  entries: { change: string; objectType: string; id: string }[];
  counts: { added: number; removed: number; changed: number };
  fullView: boolean;
}

const importSql = async (session: Session, source: string, renames: unknown[] = []) => {
  const response = await session.api.post(`/api/projects/${P}/import`, {
    headers: write(session),
    data: { source, renames },
  });
  expect(response.status(), await response.text()).toBe(201);
};

const entityIdNamed = async (session: Session, name: string): Promise<string | undefined> =>
  Object.values((await fetchIr(session, P)).objects.entity).find((e) => e.name === name)?.id;

test.describe('workflow 9 — history, live diff and rename on import', () => {
  test('snapshot → edit → live diff; re-import with a confirmed rename keeps the id', async ({ browser }) => {
    const owner = await signIn(SEED_EMAILS.owner);
    const created = await owner.api.post(`/api/projects/${P}/snapshots`, {
      headers: write(owner),
      data: { name: `w9_before_${tag}` },
    });
    expect(created.status(), await created.text()).toBe(201);
    const before = (await created.json()) as { id: string };

    try {
      await importSql(owner, `CREATE TABLE ${OLD} ${columns};`);
      const oldId = await entityIdNamed(owner, OLD);
      expect(oldId).toBeDefined();

      const live = await owner.api.get(`/api/projects/${P}/snapshots/${before.id}/diff/live`);
      expect(live.status(), await live.text()).toBe(200);
      const diff = (await live.json()) as Diff;
      expect(diff.entries).toContainEqual(expect.objectContaining({ change: 'added', objectType: 'entity', id: oldId }));
      expect(diff.counts.added).toBeGreaterThan(0);
      expect(diff.fullView).toBe(true);

      // The history screen lists the snapshot.
      const page = await signedInPage(browser, SEED_EMAILS.owner);
      await page.goto(`/${SEED.orgSlug}/p/${P}/history`);
      await expect(page.getByText(`w9_before_${tag}`).first()).toBeVisible();
      await page.context().close();

      // Re-import with the table renamed: the preview proposes it, nothing is written.
      const renamedSql = `CREATE TABLE ${NEW} ${columns};`;
      const preview = await owner.api.post(`/api/projects/${P}/import/preview`, {
        headers: write(owner),
        data: { source: renamedSql },
      });
      expect(preview.status(), await preview.text()).toBe(200);
      const { renameCandidates, creates } = (await preview.json()) as {
        creates: string[];
        renameCandidates: { type: string; fromId: string; toName: string; reason: string }[];
      };
      expect(creates).toContain(NEW);
      const candidate = renameCandidates.find((c) => c.type === 'entity' && c.fromId === oldId);
      expect(candidate?.toName).toBe(NEW);
      expect(candidate?.reason).toBe('3 of 3 columns match');
      expect(await entityIdNamed(owner, NEW)).toBeUndefined();

      await importSql(owner, renamedSql, [{ type: 'entity', fromId: oldId, toName: NEW }]);
      expect(await entityIdNamed(owner, NEW)).toBe(oldId);
      expect(await entityIdNamed(owner, OLD)).toBeUndefined();

      // Q4: the applied import wrote a `kind = import` snapshot first.
      const list = (await (await owner.api.get(`/api/projects/${P}/snapshots`)).json()) as { kind: string }[];
      expect(list.some((s) => s.kind === 'import')).toBe(true);
    } finally {
      const restored = await owner.api.post(`/api/projects/${P}/snapshots/${before.id}/restore`, {
        headers: write(owner),
      });
      expect(restored.status(), await restored.text()).toBe(201);
      expect(await entityIdNamed(owner, OLD)).toBeUndefined();
      expect(await entityIdNamed(owner, NEW)).toBeUndefined();
      const removed = await owner.api.delete(`/api/projects/${P}/snapshots/${before.id}`, {
        headers: write(owner),
      });
      expect(removed.status()).toBe(204);
    }
  });
});
