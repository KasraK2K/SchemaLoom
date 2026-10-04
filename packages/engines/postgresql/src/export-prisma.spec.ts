import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderStatements, type SchemaModel } from '@schemaloom/engine-sdk';
import type { RedactedModel } from '@schemaloom/schema-model';
import { describe, expect, it } from 'vitest';
import { redactedModel, referenceModel } from './conformance-fixtures.js';
import { defaultValue } from '@schemaloom/orm';
import { EXPORTER } from './exporter.js';
import { fullyVisible } from './fixture-model.js';

import { shopModel } from './fixture-shop.js';

async function render(redacted: RedactedModel, includeComments = true) {
  const result = await EXPORTER.export({
    model: redacted,
    options: {
      format: 'prisma',
      includeComments,
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

describe('prisma export', () => {
  it('maps every design construct the way prisma db pull would', async () => {
    const { result, text } = await render(fullyVisible(shopModel()));
    expect(result.incomplete).toBe(false);
    await expect(text).toMatchFileSnapshot('__snapshots__/shop.prisma');
  });

  it('writes a file prisma validate accepts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-prisma-'));
    const require = createRequire(import.meta.url);
    const cli = join(require.resolve('prisma/package.json'), '..', 'build', 'index.js');
    for (const [name, m] of [
      ['shop', shopModel()],
      ['reference', referenceModel()],
    ] as const) {
      const file = join(dir, `${name}.prisma`);
      writeFileSync(file, (await render(fullyVisible(m))).text);
      // Throws with prisma's error output when the schema is invalid.
      execFileSync(process.execPath, [cli, 'validate', '--schema', file], {
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
          PRISMA_HIDE_UPDATE_MESSAGE: '1',
        },
        stdio: 'pipe',
      });
    }
  }, 60_000);

  it('is byte-identical whatever order the objects arrive in', async () => {
    const straight = (await render(fullyVisible(shopModel()))).text;
    expect((await render(fullyVisible(reversed(shopModel())))).text).toBe(straight);
  });

  it('leaves hidden objects out and says so once, without a count', async () => {
    const { result, text } = await render(redactedModel());
    expect(result.incomplete).toBe(true);
    expect(text.startsWith('// Some objects are not included because of your access level.')).toBe(
      true,
    );
    expect(text).not.toContain('model customers');
    expect(text).not.toMatch(/\btotal\b/);
    expect(result.diagnostics).toEqual([]);
  });

  it('drops doc comments when comments are off', async () => {
    expect((await render(fullyVisible(shopModel()), false)).text).not.toContain(
      'People who sign in',
    );
  });
});

describe('defaultValue', () => {
  it.each([
    ['42', 'Int', '42'],
    ['true', 'Boolean', 'true'],
    ['CURRENT_TIMESTAMP', 'DateTime', 'now()'],
    ["'it''s'::text", 'String', '"it\'s"'],
    ["'2020-01-01'::date", 'DateTime', 'dbgenerated("\'2020-01-01\'::date")'],
    ["nextval('s'::regclass)", 'Int', 'dbgenerated("nextval(\'s\'::regclass)")'],
  ])('%s as %s → %s', (sql, scalar, expected) => {
    expect(defaultValue(sql, scalar, undefined, false)).toBe(expected);
  });
});
