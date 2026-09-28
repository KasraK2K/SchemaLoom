import { describe, expect, it } from 'vitest';
import type { SchemaDb } from '../schema/row-read';
import { AUTO_SNAPSHOT_MAX_AGE_MS, AUTO_SNAPSHOTS_KEPT, writeAutoSnapshot } from './auto-snapshot';
import { liveFrom } from './test-fixture';
import { baseStore } from '../schema/fixture';

interface SnapRow {
  id: string;
  projectId: string;
  kind: string;
  createdAt: Date;
}

const NOW = new Date(Date.UTC(2026, 8, 28));
const DAY = 24 * 60 * 60 * 1000;

/** Just enough of `tx.snapshot` for the three calls the helper makes. */
function fakeTx(rows: SnapRow[]): SchemaDb {
  return {
    snapshot: {
      create: ({ data }: { data: { projectId: string; kind: string } }) => {
        rows.push({ id: `new_${String(rows.length)}`, projectId: data.projectId, kind: data.kind, createdAt: NOW });
        return Promise.resolve({ id: 'x' });
      },
      findMany: ({ skip }: { skip: number }) =>
        Promise.resolve(
          rows
            .filter((r) => r.kind !== 'manual')
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(skip),
        ),
      deleteMany: ({ where }: { where: { id: { in: string[] } } }) => {
        for (const id of where.id.in) {
          const i = rows.findIndex((r) => r.id === id && r.kind !== 'manual');
          if (i >= 0) rows.splice(i, 1);
        }
        return Promise.resolve({ count: where.id.in.length });
      },
    },
  } as unknown as SchemaDb;
}

const row = (i: number, kind: string, ageMs: number): SnapRow => ({
  id: `s_${String(i)}`,
  projectId: 'prj_shop',
  kind,
  createdAt: new Date(NOW.getTime() - ageMs),
});

async function run(rows: SnapRow[]): Promise<SnapRow[]> {
  await writeAutoSnapshot(fakeTx(rows), {
    projectId: 'prj_shop',
    kind: 'import',
    name: 'Before import',
    live: await liveFrom(baseStore()),
    enginePluginVersion: '1.0.0',
    createdById: 'usr_ana',
    now: NOW,
  });
  return rows;
}

describe('writeAutoSnapshot pruning (Phase 4 Q4)', () => {
  it('keeps the newest 50 non-manual snapshots however old they are', async () => {
    const rows = Array.from({ length: AUTO_SNAPSHOTS_KEPT - 1 }, (_, i) => row(i, 'import', 200 * DAY + i));
    const after = await run(rows);
    expect(after).toHaveLength(AUTO_SNAPSHOTS_KEPT);
  });

  it('prunes beyond the newest 50 only what is older than 90 days', async () => {
    const recent = Array.from({ length: 55 }, (_, i) => row(i, 'restore', DAY + i));
    const old = Array.from({ length: 5 }, (_, i) => ({ ...row(i, 'import', 91 * DAY + i), id: `old_${String(i)}` }));
    const after = await run([...recent, ...old]);
    // 61 non-manual: the 11 beyond the newest 50 are 6 recent (kept) + 5 old (pruned).
    expect(after).toHaveLength(56);
    expect(after.some((r) => r.id.startsWith('old_'))).toBe(false);
  });

  it('keeps one exactly 90 days old (strictly older only)', async () => {
    const rows = [
      ...Array.from({ length: 50 }, (_, i) => row(i, 'import', i + 1)),
      row(999, 'import', AUTO_SNAPSHOT_MAX_AGE_MS),
    ];
    const after = await run(rows);
    expect(after.some((r) => r.id === 's_999')).toBe(true);
  });

  it('never prunes a manual snapshot', async () => {
    const rows = [
      ...Array.from({ length: 60 }, (_, i) => row(i, 'import', 100 * DAY + i)),
      row(500, 'manual', 1000 * DAY),
    ];
    const after = await run(rows);
    expect(after.find((r) => r.id === 's_500')).toBeDefined();
    expect(after.filter((r) => r.kind !== 'manual')).toHaveLength(50);
  });
});
