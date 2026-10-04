import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { deriveDatabaseUrl } from './config/database-url';
import { buildEngineRegistry } from './engines/engines.module';
import { PrismaClient } from './generated/prisma/client';
import { refreshRefs } from './schema/refs';

/**
 * `refs:backfill` — computes `refs` (doc 03 §3.1) for every object of every project. Writes
 * have persisted them since 2026-10-04; rows written before that carry the empty default, so
 * VisibilityFilter blanks their expressions for partial viewers and can't tell when a derived
 * name (`idx_emp_salary`) mentions a hidden column. Safe to re-run: it only writes refs that
 * differ.
 *
 *   node dist/refs-backfill.cli.js
 *
 * Each project is its own transaction. Exits 1 if any project failed.
 */
async function main(): Promise<number> {
  loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
  const db = new PrismaClient({ datasourceUrl: deriveDatabaseUrl(process.env) });
  const registry = buildEngineRegistry();
  let failed = 0;
  try {
    const projects = await db.project.findMany({
      where: { deletedAt: null },
      select: { id: true, engineId: true },
    });
    for (const { id, engineId } of projects) {
      const engine = registry.tryGet(engineId);
      if (engine === undefined) {
        console.log(`${id}: skipped (engine ${engineId} not installed)`);
        continue;
      }
      try {
        const changed = await db.$transaction((tx) => refreshRefs(tx, id, engine), {
          timeout: 120_000,
        });
        if (changed.length > 0) console.log(`${id}: ${String(changed.length)} object(s) updated`);
      } catch (error) {
        failed++;
        console.error(`${id}: FAILED — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await db.$disconnect();
  }
  return failed > 0 ? 1 : 0;
}

void main().then((code) => process.exit(code));
