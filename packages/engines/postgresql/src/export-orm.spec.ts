import { renderStatements, type SchemaModel } from '@schemaloom/engine-sdk';
import { checkDjango, checkTypeScript } from '@schemaloom/orm/testing';
import type { RedactedModel } from '@schemaloom/schema-model';
import { describe, expect, it } from 'vitest';
import { redactedModel, referenceModel } from './conformance-fixtures.js';
import { EXPORTER } from './exporter.js';
import { fullyVisible } from './fixture-model.js';
import { shopModel } from './fixture-shop.js';

/** Phase 8 (`docs/phase8/DESIGN.md` §4): Drizzle, TypeORM and Django for PostgreSQL. */

const FORMATS = [
  { id: 'drizzle', file: 'shop.drizzle.ts.snap', check: checkTypeScript },
  { id: 'typeorm', file: 'shop.typeorm.ts.snap', check: checkTypeScript },
  { id: 'django', file: 'shop.models.py', check: (text: string) => void checkDjango(text) },
] as const;

async function render(format: string, model: RedactedModel) {
  const result = await EXPORTER.export({
    model,
    options: {
      format,
      includeComments: true,
      includeDrops: false,
      includeIfNotExists: false,
      engineOptions: {},
    },
    context: { projectId: 'p1', serverVersion: '16' },
  });
  return { result, text: renderStatements(result) };
}

function reversed(base: SchemaModel): SchemaModel {
  const flip = <T>(bag: Record<string, T>) => Object.fromEntries(Object.entries(bag).reverse());
  const o = base.objects;
  return {
    ...base,
    objects: {
      area: o.area,
      namespace: flip(o.namespace),
      customType: flip(o.customType),
      entity: flip(o.entity),
      field: flip(o.field),
      constraint: flip(o.constraint),
      index: flip(o.index),
      link: flip(o.link),
    },
  };
}

describe.each(FORMATS)('$id export (PostgreSQL)', ({ id, file, check }) => {
  it('matches the reviewed file', async () => {
    const { text, result } = await render(id, fullyVisible(shopModel()));
    expect(result.incomplete).toBe(false);
    await expect(text).toMatchFileSnapshot(`__snapshots__/${file}`);
  });

  it("is accepted by the ORM's own checker", async () => {
    check((await render(id, fullyVisible(shopModel()))).text);
    check((await render(id, fullyVisible(referenceModel()))).text);
  }, 120_000);

  it('is byte-identical whatever order the objects arrive in', async () => {
    const straight = (await render(id, fullyVisible(shopModel()))).text;
    expect((await render(id, fullyVisible(reversed(shopModel())))).text).toBe(straight);
  });

  it('says it is incomplete when the model was redacted, and names nothing hidden', async () => {
    const { result, text } = await render(id, redactedModel());
    expect(result.incomplete).toBe(true);
    expect(text).toContain('Some objects are not included because of your access level.');
    expect(result.diagnostics).toEqual([]);
  });
});
