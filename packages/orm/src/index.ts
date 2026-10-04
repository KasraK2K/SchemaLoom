import type { ExportInput, ExportResult } from '@schemaloom/engine-sdk';
import type { OrmDialect, OrmId } from './dialect.js';
import { buildDjangoExport } from './django.js';
import { buildDrizzleExport } from './drizzle.js';
import { buildPrismaExport } from './prisma.js';
import { buildTypeormExport } from './typeorm.js';

export * from './dialect.js';
export { compare } from './util.js';
export { importPrisma, scanBlocks, type PrismaBlock } from './import-prisma.js';
export { planModels, type OrmPlan } from './plan.js';
export { defaultValue, prismaName, prismaString } from './prisma.js';

/** Phase 8 — one ORM export for an engine's dialect. */
export function buildOrmExport(orm: OrmId, input: ExportInput, dialect: OrmDialect): ExportResult {
  switch (orm) {
    case 'prisma':
      return buildPrismaExport(input, dialect);
    case 'drizzle':
      return buildDrizzleExport(input, dialect);
    case 'typeorm':
      return buildTypeormExport(input, dialect);
    case 'django':
      return buildDjangoExport(input, dialect);
  }
}
