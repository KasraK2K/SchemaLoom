import { ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import type { VisibilityContext } from '@schemaloom/schema-model';
import { isCompleteView } from '../access';
import { assertWritable, type EngineGate, type ProjectEngineRef } from '../engines';

/**
 * The two checks that stand between `schema:edit` and a whole-project rewrite.
 */

/**
 * Doc 05 R21′ — the no-partial-view rule. Restore, DDL import and migration generation
 * regenerate or overwrite the WHOLE project, so they require an unredacted view: every
 * entity visible, and every entity holding a restricted field also `field:viewRestricted`.
 *
 * Without it, `SchemaWriter`'s rule-1 visibility check would still refuse each individual
 * op — but the restore would have been PLANNED against a model missing those objects, so
 * the user would get a confusing per-op 404 instead of the honest answer. The message may
 * be explicit: it discloses only that your view is partial, which you already know.
 */
export function assertFullProjectView(ctx: VisibilityContext): void {
  if (!isCompleteView(ctx)) {
    throw new ForbiddenException({ code: 'requires_full_project_access' });
  }
}

/**
 * Doc 03 §15.2 — the snapshot's own engine stamp. **422**, not 423: the project is fine,
 * this one blob is unreadable by the current engine, and picking a different snapshot
 * resolves it.
 */
export class SnapshotEngineMismatchException extends HttpException {
  constructor(engineId: string, snapshotPluginVersion: string, enginePluginVersion: string) {
    super(
      {
        code: 'engine.snapshot-major-mismatch',
        engineId,
        snapshotPluginVersion,
        enginePluginVersion,
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/** `major.minor.patch`, pre-release and build metadata ignored; an unparseable version
 *  reads as major 0, which mismatches a real engine rather than passing. */
function majorOf(version: string): number {
  const core = version.split(/[-+]/)[0] ?? '';
  const major = Number.parseInt(core.split('.')[0] ?? '', 10);
  return Number.isNaN(major) ? 0 : major;
}

/**
 * §15.2: "a different MAJOR refuses the operation; same major proceeds." A March snapshot
 * restored after a June major bump writes `engineProps` no subsequent edit can save,
 * because every write re-parses them through a `.strict()` schema that no longer models
 * those keys.
 *
 * MAJOR-ONLY, and deliberately weaker than `EngineGate.resolve`'s full-semver rule for a
 * PROJECT: a project opens read-only when its stored version is newer at any level (a
 * rollback can leave rows the current schema rejects), but a snapshot is inert data —
 * restoring one written under a newer patch or minor of the same major is exactly what
 * §15.2 says must keep working.
 *
 * The project's own state is checked first and with the full rule: restoring INTO a
 * read-only project is a write, and `assertWritable` already owns that answer (423).
 */
export function assertSnapshotEngine(
  gate: EngineGate,
  project: ProjectEngineRef,
  snapshotPluginVersion: string,
): void {
  assertWritable(gate.resolve(project));

  const state = gate.resolve({
    engineId: project.engineId,
    enginePluginVersion: snapshotPluginVersion,
  });
  // `read-write` already implies the same major and a snapshot no newer than the engine.
  if (state.mode === 'read-write') return;
  if (state.engine !== null && majorOf(snapshotPluginVersion) === majorOf(state.engine.version)) {
    return;
  }
  throw new SnapshotEngineMismatchException(
    project.engineId,
    snapshotPluginVersion,
    state.enginePluginVersion ?? 'unregistered',
  );
}
