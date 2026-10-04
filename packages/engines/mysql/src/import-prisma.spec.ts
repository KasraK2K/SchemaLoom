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
import { IMPORTER } from './importer.js';

/** Phase 7b (`docs/phase7/PRISMA-IMPORT.md` §3): `schema.prisma` into a MySQL design. */

const OPTIONS: ImportOptions = {
  format: 'prisma',
  defaultNamespace: '',
  caseFolding: 'preserve',
  engineOptions: {},
};

function context(): ImportContext {
  let n = 0;
  return { projectId: 'p1', serverVersion: 'MySQL 8.4', newId: () => `id${String(++n)}` };
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
    context: { projectId: 'p1', serverVersion: 'MySQL 8.4' },
  });
  return renderStatements(result);
}

/** Every line but comments, padding collapsed, sorted (see the PostgreSQL spec). */
const withoutComments = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line !== '' && !line.startsWith('//'))
    .sort()
    .join('\n');

describe('prisma import (MySQL)', () => {
  it('round-trips the reference design through schema.prisma', async () => {
    const first = await exportPrisma(referenceModel());
    const { model, report } = await importPrisma(first);
    expect(report.countsByStatus.failed).toBe(0);
    expect(withoutComments(await exportPrisma(model))).toBe(withoutComments(first));
  });

  it('keeps an enum on its column, unsigned integers and prefix lengths', async () => {
    const { model } = await importPrisma(`
datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}

enum Status {
  active
  closed
}

model customers {
  id     BigInt @id @default(autoincrement()) @db.UnsignedBigInt
  email  String @db.VarChar(255)
  status Status @default(active)

  @@index([email(length: 20)], map: "idx_email_prefix")
}
`);
    const fields = Object.values(model.objects.field);
    expect(fields.map((f) => [f.name, f.type.name, f.type.args ?? [], f.engineProps])).toEqual([
      ['id', 'bigint', [], { unsigned: true, autoIncrement: true }],
      ['email', 'varchar', [255], {}],
      ['status', 'enum', ['active', 'closed'], { default: "'active'" }],
    ]);
    expect(Object.values(model.objects.customType)).toEqual([]);
    const [index] = Object.values(model.objects.index);
    expect(index?.columns[0]?.engineProps).toEqual({ length: 20 });
    const [key] = Object.values(model.objects.constraint);
    expect(key?.name).toBe('PRIMARY');
  });

  it('refuses a PostgreSQL file', async () => {
    const { report } = await importPrisma(
      'datasource db {\n  provider = "postgresql"\n  url = env("X")\n}\n',
    );
    expect(report.statements[0]?.reason).toBe('This file is for PostgreSQL; the project is MySQL.');
  });
});
