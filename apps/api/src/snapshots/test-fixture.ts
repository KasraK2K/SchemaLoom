import { assembleModel } from '@schemaloom/schema-model';
import { fakePrisma, type Store } from '../schema/fake-prisma';
import { PROJECT } from '../schema/fixture';
import { readProjectRows } from '../schema/row-read';
import { asLive, type LiveIr } from './live-ir';

/**
 * Test-only. Builds a `LiveIr` from the same fake store `src/schema`'s specs use, through
 * the same `readProjectRows` + `assembleModel` pair the real loader uses — so a spec here
 * never hand-writes an IR literal that can drift from what the loader actually produces.
 *
 * Docker is not a test dependency: every rule this module encodes is a rule about which
 * ops a diff produces and which statements they become.
 */
export async function liveFrom(store: Partial<Store>): Promise<LiveIr> {
  const rows = await readProjectRows(fakePrisma(store).client, PROJECT);
  return asLive(
    assembleModel({ projectId: PROJECT, engineId: 'postgresql', engineVersion: '16', rows }),
  );
}
