import { describe, expect, it } from 'vitest';
import { baseStore, entityRow } from '../schema/fixture';
import { layoutMoves } from './change-requests.service';
import { liveFrom } from './test-fixture';

/** Three tables at the origin, then each side's positions. */
const at = (positions: Record<string, [number, number]>) =>
  liveFrom(
    baseStore({
      entity: ['ent_a', 'ent_b', 'ent_c']
        .filter((id) => id in positions)
        .map((id) => {
          const [x, y] = positions[id] ?? [0, 0];
          return entityRow(id, { positionX: x, positionY: y });
        }),
    }),
  );

describe('layoutMoves (Phase 10c §4)', () => {
  it("carries the draft's moves, and main's own move wins", async () => {
    const base = await at({ ent_a: [0, 0], ent_b: [0, 0], ent_c: [0, 0] });
    const main = await at({ ent_a: [0, 0], ent_b: [500, 0], ent_c: [0, 0] });
    const draft = await at({ ent_a: [100, 50], ent_b: [900, 900], ent_c: [0, 0] });

    expect(layoutMoves(base, main, draft)).toEqual([{ id: 'ent_a', position: { x: 100, y: 50 } }]);
  });

  it('ignores a table either side deleted', async () => {
    const base = await at({ ent_a: [0, 0], ent_b: [0, 0] });
    const main = await at({ ent_a: [0, 0] });
    const draft = await at({ ent_b: [300, 0] });
    expect(layoutMoves(base, main, draft)).toEqual([]);
  });
});
