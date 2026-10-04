import {
  renderStatements,
  type ImportContext,
  type ImportOptions,
  type SchemaModel,
} from '@schemaloom/engine-sdk';
import { describe, expect, it } from 'vitest';
import { referenceModel } from './conformance-fixtures.js';
import { EXPORTER } from './exporter.js';
import { fullyVisible } from './fixture-model.js';
import { shopModel } from './fixture-shop.js';
import { IMPORTER } from './importer.js';

/** Phase 7b (`docs/phase7/PRISMA-IMPORT.md` §3): `schema.prisma` into a PostgreSQL design. */

const OPTIONS: ImportOptions = {
  format: 'prisma',
  defaultNamespace: 'public',
  caseFolding: 'lower',
  engineOptions: {},
};

function context(): ImportContext {
  let n = 0;
  return { projectId: 'p1', serverVersion: '16', newId: () => `id${String(++n)}` };
}

const importPrisma = (source: string) => IMPORTER.import(source, OPTIONS, context());

async function exportPrisma(model: SchemaModel): Promise<string> {
  const result = await EXPORTER.export({
    model: fullyVisible(model),
    options: {
      format: 'prisma',
      includeComments: false,
      includeDrops: false,
      includeIfNotExists: false,
      engineOptions: {},
    },
    context: { projectId: 'p1', serverVersion: '16' },
  });
  return renderStatements(result);
}

/**
 * What Prisma can't express is a comment in the export; the round trip compares every other
 * line. Lines are compared sorted and with their padding collapsed: a unique key read back as
 * a constraint prints before the indexes instead of among them, which is the same schema.
 */
const withoutComments = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line !== '' && !line.startsWith('//'))
    .sort()
    .join('\n');

describe('prisma import (PostgreSQL)', () => {
  it.each([
    ['shop', shopModel()],
    ['reference', referenceModel()],
  ])('round-trips the %s design through schema.prisma', async (_name, model) => {
    const first = await exportPrisma(model);
    const { model: imported, report } = await importPrisma(first);
    expect(report.countsByStatus.failed).toBe(0);
    expect(withoutComments(await exportPrisma(imported))).toBe(withoutComments(first));
  });

  it('accounts for every block and keeps docs beside the model', async () => {
    const source = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

/// People who sign in
model User {
  id        String   @id @default(cuid())
  /// Where we write
  email     String   @unique
  updatedAt DateTime @updatedAt
  tags      Tag[]
}

model Tag {
  id    Int    @id @default(autoincrement())
  users User[]
}
`;
    const { model, report, docs } = await importPrisma(source);
    expect(report.statements.map((s) => [s.kind, s.status])).toEqual([
      ['datasource', 'ignored'],
      ['generator', 'ignored'],
      ['model', 'partial'],
      ['model', 'applied'],
    ]);
    expect(report.statements[2]?.reason).toContain('cuid() on “id” is filled in by Prisma Client');
    expect(report.statements[2]?.reason).toContain('@updatedAt on “updatedAt”');
    expect(docs?.map((d) => d.text)).toEqual(['People who sign in', 'Where we write']);

    // The implicit many-to-many table Prisma creates, with Prisma 6's primary key.
    const join = Object.values(model.objects.entity).find((e) => e.name === '_TagToUser');
    expect(join).toBeDefined();
    const columns = Object.values(model.objects.field).filter((f) => f.entityId === join?.id);
    expect(columns.map((c) => [c.name, c.type.name])).toEqual([
      ['A', 'integer'],
      ['B', 'text'],
    ]);
    const keys = Object.values(model.objects.constraint).filter((c) => c.entityId === join?.id);
    expect(keys.map((c) => [c.kind, c.name])).toEqual([['primaryKey', '_TagToUser_AB_pkey']]);
  });

  it('refuses a file for another database, saying which', async () => {
    const { report, model } = await importPrisma(
      'datasource db {\n  provider = "mysql"\n  url = env("X")\n}\nmodel A {\n  id Int @id\n}\n',
    );
    expect(report.statements.every((s) => s.status === 'failed')).toBe(true);
    expect(report.statements[0]?.reason).toBe('This file is for MySQL; the project is PostgreSQL.');
    expect(Object.keys(model.objects.entity)).toEqual([]);
  });

  it("reports a file Prisma rejects with Prisma's reason", async () => {
    const { report } = await importPrisma(
      'datasource db {\n  provider = "postgresql"\n  url = env("X")\n}\nmodel A {\n  id Nope @id\n}\n',
    );
    expect(report.countsByStatus.failed).toBe(2);
    expect(report.statements[1]?.reason).toMatch(/^Prisma rejected the file: .*Nope/);
  });
});
