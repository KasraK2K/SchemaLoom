import type { EngineDefinition, EngineStaticFacet } from './definition.js';
import type { EnginePropsKind } from './diagnostics.js';
import type { EngineProps } from './ir.js';

/**
 * TWO DIFFERENT VERSIONS, and they must not be confused.
 * `Project.engineVersion` / `EngineContext.serverVersion` is the TARGET DATABASE version ("16").
 * `EngineDefinition.version` is semver describing the engine PLUGIN's behaviour contract, and
 * `projects.engine_plugin_version` records the one a project's stored `engineProps` were
 * written for. This module compares only the second pair.
 */
export type EngineVersionVerdict =
  | { readonly action: 'ok' }
  | { readonly action: 'read-only'; readonly reason: 'project-newer-than-engine' }
  | { readonly action: 'read-only'; readonly reason: 'project-older-major' }
  | { readonly action: 'read-only'; readonly reason: 'engine-missing' };

/** `major.minor.patch`; a missing or non-numeric component reads as 0, and anything after a
 *  `-` or `+` is ignored. An unparseable stored version therefore compares as 0.0.0 and lands
 *  on `project-older-major` rather than silently reading as `ok`. */
function parseSemver(version: string): readonly [number, number, number] {
  const core = version.split(/[-+]/)[0] ?? '';
  const parts = core.split('.');
  const at = (i: number): number => {
    const n = Number.parseInt(parts[i] ?? '', 10);
    return Number.isNaN(n) ? 0 : n;
  };
  return [at(0), at(1), at(2)];
}

function compare(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * FULL-SEMVER comparison, not major-only, and that is the load-bearing part.
 *
 * The incident it exists for: 1.5 adds an optional `engineProps.compression`, users set it on a
 * few hundred columns, 1.5 turns out to have a bug, ops rolls back to 1.4. Major-only
 * comparison says `ok`, the project opens read-write, and every subsequent write to one of
 * those columns hits the props schema's `.strict()`, trips the unknown key and 422s — an error
 * the user cannot fix from the UI, because they cannot see or clear a prop the current schema
 * does not model. Comparing the whole version opens the project read-only with an accurate
 * reason, which is recoverable by redeploying. Stripping unknown keys instead would silently
 * destroy the data on the way back up, so `.strict()` stays and this comparison does the work.
 *
 * There is no upgrade-on-open transaction: a major bump opens the project read-only until an
 * operator migrates it (`PropsUpgrade`, below; the api's `engines:upgrade` command).
 */
export function compareEngineVersion(
  storedPluginVersion: string,
  engine: EngineStaticFacet | undefined,
): EngineVersionVerdict {
  if (engine === undefined) return { action: 'read-only', reason: 'engine-missing' };

  const stored = parseSemver(storedPluginVersion);
  const current = parseSemver(engine.version);

  if (compare(stored, current) > 0) {
    return { action: 'read-only', reason: 'project-newer-than-engine' };
  }
  if (stored[0] < current[0]) {
    return { action: 'read-only', reason: 'project-older-major' };
  }
  return { action: 'ok' };
}

/**
 * Doc 00 Q19 / doc 03 §15.1 — rewrites one object's stored `engineProps` from major `fromMajor`
 * to `fromMajor + 1`. Pure, total and deterministic. It runs once per object, inside the
 * operator's upgrade transaction, and every result must pass the NEW `propsSchemas`: one
 * rejection rolls the whole project back and leaves it read-only.
 */
export interface PropsUpgrade {
  readonly fromMajor: number;
  readonly upgrade: (
    kind: EnginePropsKind,
    subKind: string | null,
    props: EngineProps,
  ) => EngineProps;
}

export function majorOf(version: string): number {
  return parseSemver(version)[0];
}

/**
 * The upgrades that take props written under `storedVersion` up to `engine.version`, in order.
 * Throws when a step is missing, so an engine that forgot one fails the upgrade loudly instead
 * of stamping the project with a version its props were never converted to.
 */
export function propsUpgradePath(
  storedVersion: string,
  engine: Pick<EngineDefinition, 'id' | 'version' | 'propsUpgrades'>,
): readonly PropsUpgrade[] {
  const path: PropsUpgrade[] = [];
  for (let major = majorOf(storedVersion); major < majorOf(engine.version); major++) {
    const step = engine.propsUpgrades?.find((u) => u.fromMajor === major);
    if (step === undefined) {
      throw new Error(`engine ${engine.id} has no propsUpgrade from major ${String(major)}`);
    }
    path.push(step);
  }
  return path;
}
