import type { EngineFeature } from './capabilities.js';
import type { EngineId } from './diagnostics.js';

/**
 * Doc 03 §14.1. Each error carries a stable `code` in the same `<scope>.<kebab-slug>` shape as
 * `Diagnostic.code`, so the Nest exception filter maps on the field rather than on an
 * `instanceof` chain.
 */
export class EngineError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** `registry.register()` with an id already present. 500 — a wiring bug, never user input. */
export class DuplicateEngineError extends EngineError {
  readonly engineId: EngineId;

  constructor(engineId: EngineId) {
    super('engine.duplicate', `Engine "${engineId}" is already registered`);
    this.engineId = engineId;
  }
}

/** `registry.get()` for an unregistered id, i.e. a project whose engine package is not
 *  deployed. Core catches this one and opens the project read-only (§15), so it maps to
 *  200 + a banner, not to an error response. */
export class UnknownEngineError extends EngineError {
  readonly engineId: EngineId;

  constructor(engineId: EngineId) {
    super('engine.unknown', `No engine registered with id "${engineId}"`);
    this.engineId = engineId;
  }
}

/** `assertFeature()` failed. 400 `engine.feature-unsupported`. */
export class EngineFeatureUnsupportedError extends EngineError {
  readonly engineId: EngineId;
  readonly feature: EngineFeature;

  constructor(engineId: EngineId, feature: EngineFeature) {
    super('engine.feature-unsupported', `Engine "${engineId}" does not support "${feature}"`);
    this.engineId = engineId;
    this.feature = feature;
  }
}

/** `defineCapabilities()` found an internal contradiction (§4.1). Thrown at module load, so it
 *  fails the deploy rather than a request. */
export class CapabilitiesContradictionError extends EngineError {
  readonly engineId: EngineId;
  /** the failing invariant id, e.g. 'links-imply-kinds' */
  readonly rule: string;

  constructor(engineId: EngineId, rule: string, detail: string) {
    super(
      'engine.capabilities-contradiction',
      `Engine "${engineId}" capabilities violate ${rule}: ${detail}`,
    );
    this.engineId = engineId;
    this.rule = rule;
  }
}
