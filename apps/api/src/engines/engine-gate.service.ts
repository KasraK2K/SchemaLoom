import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  compareEngineVersion,
  type EngineDefinition,
  type EngineId,
  type EngineRegistry,
  type EngineVersionVerdict,
} from '@schemaloom/engine-sdk';
import { ENGINE_REGISTRY } from './engines.tokens';

/**
 * Doc 03 §15 — engine-plugin version drift, and the read-only state it produces.
 *
 * TWO DIFFERENT VERSIONS, never confused: `Project.engineVersion` is the TARGET DATABASE
 * version ("16"). This module reads only `projects.engine_plugin_version`, the semver of the
 * engine plugin whose behaviour contract a project's stored `engineProps` were written for,
 * and compares it with the registered engine's `version`.
 *
 * Per RECONCILIATION and §15.1 there is **no `propsMigrations`, no `EnginePropsMigration` and
 * no upgrade-on-open transaction**. A major bump opens the project READ-ONLY until an operator
 * migrates it — a deliberate job with an advisory lock, run as a system actor, designed in the
 * release that first needs it. That job does not exist. This file makes the waiting state
 * explicit and typed; it does not invent the job.
 */

/** Exactly the fields this check reads. A `Project` row satisfies it structurally. */
export interface ProjectEngineRef {
  readonly engineId: EngineId;
  /** `projects.engine_plugin_version` — a real column, not a key in `settings` (§15). */
  readonly enginePluginVersion: string;
}

export type EngineReadOnlyReason = Extract<
  EngineVersionVerdict,
  { action: 'read-only' }
>['reason'];

export interface WritableEngineState {
  readonly mode: 'read-write';
  readonly engine: EngineDefinition;
  readonly storedPluginVersion: string;
  /** refreshed onto the row by the next write (§15) */
  readonly enginePluginVersion: string;
}

export interface ReadOnlyEngineState {
  readonly mode: 'read-only';
  readonly reason: EngineReadOnlyReason;
  readonly engineId: EngineId;
  /** `null` only for `engine-missing`: there is no engine to describe. */
  readonly engine: EngineDefinition | null;
  readonly storedPluginVersion: string;
  /** The banner names both versions, so both travel with the state. */
  readonly enginePluginVersion: string | null;
}

/**
 * The state of one project with respect to its engine. A discriminated union rather than a
 * `readOnly: boolean` plus a nullable engine: `mode === 'read-write'` is the only shape that
 * carries a non-null `EngineDefinition`, so a caller cannot reach the engine without having
 * passed the check.
 */
export type ProjectEngineState = WritableEngineState | ReadOnlyEngineState;

/**
 * Thrown by `assertWritable`. **423 Locked**, not 403: the subject's permissions are fine and
 * retrying as someone else changes nothing — the project itself is locked until it is migrated
 * or the engine is redeployed. `code` follows the `<scope>.<kebab-slug>` shape the rest of the
 * engine errors use, so the exception filter maps on the field.
 */
export class ProjectReadOnlyException extends HttpException {
  constructor(state: ReadOnlyEngineState) {
    super(
      {
        code: 'engine.read-only',
        reason: state.reason,
        engineId: state.engineId,
        storedPluginVersion: state.storedPluginVersion,
        enginePluginVersion: state.enginePluginVersion,
      },
      HttpStatus.LOCKED,
    );
  }
}

/**
 * §15: evaluated when a project is opened and **re-checked on every write**. A caller that
 * holds a `ProjectEngineState` from the open path passes it here rather than resolving twice.
 */
export function assertWritable(
  state: ProjectEngineState,
): asserts state is WritableEngineState {
  if (state.mode === 'read-only') throw new ProjectReadOnlyException(state);
}

@Injectable()
export class EngineGate {
  constructor(@Inject(ENGINE_REGISTRY) private readonly registry: EngineRegistry) {}

  /**
   * | situation | verdict |
   * | --- | --- |
   * | engine not registered | `read-only / engine-missing` — never a 500, never a lost project |
   * | `stored > engine.version` at ANY semver level | `read-only / project-newer-than-engine` |
   * | `stored.major < engine.major` | `read-only / project-older-major` |
   * | otherwise | `read-write` |
   *
   * `tryGet`, not `get`: an unregistered engine is an expected deployment state with a
   * fallback UI, so it is a verdict rather than a thrown `UnknownEngineError`. The
   * `engine === undefined` branch is taken here rather than left to `compareEngineVersion`
   * only because it is what lets the writable half of the union carry a non-null engine
   * without a non-null assertion; the comparison itself stays in the SDK.
   */
  resolve(project: ProjectEngineRef): ProjectEngineState {
    const { engineId, enginePluginVersion: stored } = project;
    const engine = this.registry.tryGet(engineId);

    if (engine === undefined) {
      return {
        mode: 'read-only',
        reason: 'engine-missing',
        engineId,
        engine: null,
        storedPluginVersion: stored,
        enginePluginVersion: null,
      };
    }

    const verdict = compareEngineVersion(stored, engine);
    if (verdict.action === 'ok') {
      return {
        mode: 'read-write',
        engine,
        storedPluginVersion: stored,
        enginePluginVersion: engine.version,
      };
    }

    return {
      mode: 'read-only',
      reason: verdict.reason,
      engineId,
      engine,
      storedPluginVersion: stored,
      enginePluginVersion: engine.version,
    };
  }
}
