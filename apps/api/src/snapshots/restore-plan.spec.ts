import { RedactedDiffError, diffModels, type SnapshotRef } from '@schemaloom/schema-model';
import { describe, expect, it } from 'vitest';
import type { SchemaOperation } from '../schema';
import { baseStore, entityRow, fieldRow, redactFully } from '../schema/fixture';
import { blobToLive, type LiveIr } from './live-ir';
import { planRestore } from './restore-plan';
import { liveFrom } from './test-fixture';

const TO: SnapshotRef = {
  kind: 'snapshot',
  id: 'snap_1',
  label: 'v1 — before billing rework',
  capturedAt: '2026-01-01T00:00:00.000Z',
};

const plan = (live: LiveIr, snapshot: LiveIr): readonly SchemaOperation[] =>
  planRestore(live, snapshot, TO, 'batch_1', 'Restore "v1"')?.ops ?? [];

const created = (ops: readonly SchemaOperation[], type: string): Record<string, unknown> => {
  const op = ops.find((o) => o.op === 'create' && o.type === type);
  return op?.op === 'create' ? { ...op.object } : {};
};

const patched = (ops: readonly SchemaOperation[], type: string): Record<string, unknown> => {
  const op = ops.find((o) => o.op === 'update' && o.type === type);
  return op?.op === 'update' ? { ...op.patch } : {};
};

describe('snapshot blob', () => {
  it('round-trips through JSON unchanged', async () => {
    const live = await liveFrom(
      baseStore({
        entity: [entityRow('ent_a', { areaId: 'area_billing' })],
        field: [fieldRow('f_a', 'ent_a', { isRestricted: true })],
      }),
    );

    // The blob is the ONLY stored form of the IR (C3), so a parse that loses a column is
    // a snapshot that silently restores something else.
    expect(blobToLive(JSON.parse(JSON.stringify(live)) as unknown)).toEqual(live);
  });
});

describe('planRestore', () => {
  it('returns null when the snapshot already matches live', async () => {
    const store = baseStore({ entity: [entityRow('ent_a')] });
    expect(planRestore(await liveFrom(store), await liveFrom(store), TO, 'b', 'l')).toBeNull();
  });

  it('creates what the snapshot has and live does not, with R28 fail-closed defaults', async () => {
    const live = await liveFrom(baseStore({ entity: [entityRow('ent_a')] }));
    const snapshot = await liveFrom(
      baseStore({
        entity: [entityRow('ent_a'), entityRow('ent_b', { areaId: 'area_billing' })],
        field: [fieldRow('f_b', 'ent_b', { isRestricted: false })],
      }),
    );

    const ops = plan(live, snapshot);
    // R28: the snapshot said `area_billing`, but `areaId` is an access-control attribute
    // and there is no live row to preserve it from, so the fail-closed default wins.
    expect(created(ops, 'entity')).toMatchObject({ id: 'ent_b', areaId: null });
    // Likewise `isRestricted` — the snapshot said false; a restore may never un-restrict.
    expect(created(ops, 'field')).toMatchObject({ id: 'f_b', isRestricted: true });
  });

  it('strips the server-owned fields at the same zod boundary a hand edit crosses', async () => {
    const live = await liveFrom(baseStore({}));
    const snapshot = await liveFrom(
      baseStore({
        entity: [entityRow('ent_b')],
        field: [fieldRow('f_b', 'ent_b', { position: 7, version: 9 })],
      }),
    );

    const object = created(plan(live, snapshot), 'field');
    expect(object).toMatchObject({ id: 'f_b' });
    // §8.6 rule 6 — the server appends; neither a client nor a restore mints an ordinal.
    expect(object).not.toHaveProperty('ordinal');
    expect(object).not.toHaveProperty('version');
    expect(object).not.toHaveProperty('refs');
  });

  it('freezes isRestricted and areaId on an update (R28)', async () => {
    const live = await liveFrom(
      baseStore({
        entity: [entityRow('ent_a', { name: 'orders', areaId: 'area_billing' })],
        field: [fieldRow('f_a', 'ent_a', { name: 'ssn', isRestricted: true })],
      }),
    );
    const snapshot = await liveFrom(
      baseStore({
        entity: [entityRow('ent_a', { name: 'purchases', areaId: null })],
        field: [fieldRow('f_a', 'ent_a', { name: 'social', isRestricted: false })],
      }),
    );

    const ops = plan(live, snapshot);
    expect(patched(ops, 'entity')).toMatchObject({ name: 'purchases' });
    expect(patched(ops, 'entity')).not.toHaveProperty('areaId');
    expect(patched(ops, 'field')).toMatchObject({ name: 'social' });
    expect(patched(ops, 'field')).not.toHaveProperty('isRestricted');
  });

  it('takes expectedVersion from LIVE, never from the frozen snapshot', async () => {
    const live = await liveFrom(baseStore({ entity: [entityRow('ent_a', { version: 12 })] }));
    const snapshot = await liveFrom(baseStore({}));

    expect(plan(live, snapshot)).toEqual([
      { op: 'delete', type: 'entity', id: 'ent_a', expectedVersion: 12 },
    ]);
  });
});

/**
 * Doc 04 §8.8 rule 1, and the reason this module has a `LiveIr` type at all.
 *
 * A user who cannot see an entity must not be able to delete it by restoring a snapshot
 * that merely *appears* not to contain it. `planRestore` takes `LiveIr` on both sides, so a
 * `RedactedModel` is a COMPILE error; these tests force one through a cast to prove the
 * runtime net underneath it holds too.
 */
describe('planRestore refuses a redacted model', () => {
  const hiddenField = async (): Promise<{ live: LiveIr; redacted: LiveIr }> => {
    const live = await liveFrom(
      baseStore({
        entity: [entityRow('ent_a')],
        field: [
          fieldRow('f_public', 'ent_a'),
          fieldRow('f_secret', 'ent_a', { isRestricted: true }),
        ],
      }),
    );
    const view = redactFully(live, {
      restrictedOkEntityIds: new Set(),
      restrictedFieldMode: 'hide',
      entitiesWithRestrictedFields: new Set(['ent_a']),
    });
    return { live, redacted: view as unknown as LiveIr };
  };

  it('would otherwise emit a delete for the object the viewer cannot see', async () => {
    const { live, redacted } = await hiddenField();
    // The danger, demonstrated rather than asserted in a comment: diffed naively against a
    // redacted snapshot, the hidden column reads as "removed" and restore drops it.
    const naive = diffModels(live, redacted, { to: TO });
    expect(naive.redacted).toBe(true);
    expect(naive.entries).toContainEqual(
      expect.objectContaining({ change: 'removed', objectType: 'field', id: 'f_secret' }),
    );
  });

  it('throws instead, whichever side is redacted', async () => {
    const { live, redacted } = await hiddenField();
    expect(() => plan(live, redacted)).toThrow(RedactedDiffError);
    expect(() => plan(redacted, live)).toThrow(RedactedDiffError);
  });
});
