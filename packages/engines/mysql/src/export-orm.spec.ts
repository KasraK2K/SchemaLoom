import { renderStatements } from '@schemaloom/engine-sdk';
import { checkDjango, checkPrisma, checkTypeScript } from '@schemaloom/orm/testing';
import type { RedactedModel } from '@schemaloom/schema-model';
import { describe, expect, it } from 'vitest';
import { redactedModel, referenceModel } from './conformance-fixtures.js';
import { EXPORTER } from './exporter.js';
import { fullyVisible } from './fixture-model.js';

/** Phase 8 — MySQL's ORM exports, through the shared writers (`docs/phase8/DESIGN.md`). */

const FORMATS = [
  {
    id: 'prisma',
    file: 'reference.prisma',
    check: (t: string) => {
      checkPrisma(t, 'mysql');
    },
  },
  { id: 'drizzle', file: 'reference.drizzle.ts.snap', check: checkTypeScript },
  { id: 'typeorm', file: 'reference.typeorm.ts.snap', check: checkTypeScript },
  { id: 'django', file: 'reference.models.py', check: (t: string) => void checkDjango(t) },
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
    context: { projectId: 'p1', serverVersion: 'MySQL 8.4' },
  });
  return { result, text: renderStatements(result) };
}

describe.each(FORMATS)('$id export (MySQL)', ({ id, file, check }) => {
  it('matches the reviewed file', async () => {
    const { text, result } = await render(id, fullyVisible(referenceModel()));
    expect(result.incomplete).toBe(false);
    await expect(text).toMatchFileSnapshot(`__snapshots__/${file}`);
  });

  it("is accepted by the ORM's own checker", async () => {
    check((await render(id, fullyVisible(referenceModel()))).text);
  }, 120_000);

  it('says it is incomplete when the model was redacted', async () => {
    const { text, result } = await render(id, redactedModel());
    expect(result.incomplete).toBe(true);
    expect(text).toContain('Some objects are not included because of your access level.');
  });
});
