import type { EngineDefinition, EngineRegistry } from '@schemaloom/engine-sdk';
import {
  RawSchemaModel,
  assembleModel,
  type RedactedModel,
  type SchemaModel,
} from '@schemaloom/schema-model';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { VisibilityFilter } from '../access';
import { fakePrisma, type Store } from '../schema/fake-prisma';
import { PROJECT, baseStore, entityRow, fieldRow, redactFully } from '../schema/fixture';
import type { SchemaLoader } from '../schema';
import { readProjectRows } from '../schema/row-read';
import type { ValidateJobData } from './queues';
import { ValidateProcessor } from './validate.processor';

/**
 * Two tables whose names differ only in case. PostgreSQL folds them together and an engine
 * that folds nothing does not — which is the whole reason `normalizeName` is threaded in.
 */
const STORE: Partial<Store> = baseStore({
  entity: [entityRow('ent_a', { name: 'Orders' }), entityRow('ent_b', { name: 'orders' })],
  field: [fieldRow('fld_id', 'ent_a', { name: 'id' })],
});

const DATA: ValidateJobData = {
  projectId: PROJECT,
  subject: { kind: 'user', userId: 'usr_ana', orgId: 'org_acme' },
};

let model: SchemaModel;

beforeAll(async () => {
  const rows = await readProjectRows(fakePrisma(STORE).client, PROJECT);
  model = assembleModel({ projectId: PROJECT, engineId: 'postgresql', engineVersion: '16', rows });
});

function harness(engine: EngineDefinition | undefined): {
  processor: ValidateProcessor;
  redactModel: ReturnType<typeof vi.fn>;
} {
  const redactModel = vi.fn((): Promise<RedactedModel> => Promise.resolve(redactFully(model)));
  const loader = {
    load: () => Promise.resolve(new RawSchemaModel(model)),
  } as unknown as SchemaLoader;
  const registry = { tryGet: () => engine } as unknown as EngineRegistry;

  return {
    processor: new ValidateProcessor(
      loader,
      { redactModel } as unknown as VisibilityFilter,
      registry,
    ),
    redactModel,
  };
}

const folding = (fold: (s: string) => string): EngineDefinition =>
  ({ id: 'postgresql', normalizeName: fold }) as unknown as EngineDefinition;

describe('ValidateProcessor', () => {
  it('validates the model VisibilityFilter produced, never the raw one', async () => {
    const h = harness(folding((s) => s));
    await h.processor.run(DATA);

    expect(h.redactModel).toHaveBeenCalledTimes(1);
    const [, subject, projectId] = h.redactModel.mock.calls[0] ?? [];
    expect(subject).toEqual(DATA.subject);
    expect(projectId).toBe(PROJECT);
  });

  it("applies the engine's name folding, so `Orders` and `orders` collide", async () => {
    const issues = await harness(folding((s) => s.toLowerCase())).processor.run(DATA);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('folds nothing when the engine folds nothing', async () => {
    const issues = await harness(folding((s) => s)).processor.run(DATA);
    expect(issues).toEqual([]);
  });

  it('still runs when the engine is not registered on this deployment', async () => {
    await expect(harness(undefined).processor.run(DATA)).resolves.toEqual([]);
  });
});
