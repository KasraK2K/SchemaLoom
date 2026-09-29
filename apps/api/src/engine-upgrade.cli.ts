import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { deriveDatabaseUrl } from './config/database-url';
import { upgradeProject } from './engines/engine-upgrade';
import { buildEngineRegistry } from './engines/engines.module';
import { PrismaClient } from './generated/prisma/client';

/**
 * Doc 00 Q19 — `engines:upgrade`: moves projects off an older engine major.
 *
 *   node dist/engine-upgrade.cli.js --all          every project that needs it
 *   node dist/engine-upgrade.cli.js <projectId>…   just these
 *
 * Run it after deploying an engine with a new major; until then those projects are
 * read-only. Each project is its own transaction, so one failure leaves the others upgraded.
 * Exits 1 if any project failed.
 */
async function main(args: readonly string[]): Promise<number> {
  loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
  const all = args.includes('--all');
  const ids = args.filter((a) => a !== '--all');
  if (all === ids.length > 0) {
    console.error('usage: engine-upgrade (--all | <projectId>...)');
    return 2;
  }

  const db = new PrismaClient({ datasourceUrl: deriveDatabaseUrl(process.env) });
  const registry = buildEngineRegistry();
  let failed = 0;
  try {
    const targets = all
      ? (await db.project.findMany({ where: { deletedAt: null }, select: { id: true } })).map(
          (p) => p.id,
        )
      : ids;
    for (const id of targets) {
      try {
        const result = await upgradeProject(db, registry, id);
        if (result.status === 'upgraded') {
          console.log(
            `${id}: upgraded ${result.from} -> ${result.to}, ${String(result.rowsChanged)} row(s)`,
          );
        } else if (result.status === 'skipped') {
          console.log(`${id}: skipped (${result.reason})`);
        } else if (!all) {
          console.log(`${id}: already current`);
        }
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

void main(process.argv.slice(2)).then((code) => process.exit(code));
