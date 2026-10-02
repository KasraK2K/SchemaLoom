import type { EngineCapabilities } from './capabilities.js';
import type { EngineDefinition, EngineParadigm } from './definition.js';
import type { EngineId } from './diagnostics.js';
import { DuplicateEngineError, UnknownEngineError } from './errors.js';
import type { ProjectTemplateSummary } from './templates.js';
import type { TerminologyBundle } from './terminology.js';

/** Data, not code: an engine the picker advertises before any implementation exists. The LIST
 *  lives in `apps/api` — it is deployment policy, not an SDK contract — and is passed to
 *  `createEngineRegistry`. engine-sdk owns only this type. */
export interface AnnouncedEngine {
  readonly id: EngineId;
  readonly displayName: string;
  readonly paradigm: EngineParadigm;
  readonly icon: string;
  readonly summary: string;
}

/** What the picker renders for an implemented engine. Fully JSON-serialisable — this and
 *  `AnnouncedEngine` are the whole `GET /engines` payload. */
export interface EngineDescriptor extends AnnouncedEngine {
  readonly version: string;
  readonly capabilities: EngineCapabilities;
  readonly terminology: TerminologyBundle;
  /** Phase 12 — never the source; `GET /engines/:id/templates/:templateId` serves that. */
  readonly templates: readonly ProjectTemplateSummary[];
}

export interface EngineCatalog {
  readonly available: readonly EngineDescriptor[];
  readonly comingSoon: readonly AnnouncedEngine[];
}

export interface EngineRegistry {
  /** throws `DuplicateEngineError` on a repeated id */
  register(definition: EngineDefinition): void;
  has(id: EngineId): boolean;
  /** throws `UnknownEngineError` — use for a project whose engine must exist */
  get(id: EngineId): EngineDefinition;
  tryGet(id: EngineId): EngineDefinition | undefined;
  list(): readonly EngineDefinition[];
  /** Registered engines become `available`; announced ids with no registration become
   *  `comingSoon`. Registration always wins, so shipping an engine needs no edit to the
   *  announcement list. Both arrays are ordered by displayName. */
  catalog(): EngineCatalog;
}

function describe(engine: EngineDefinition): EngineDescriptor {
  return {
    id: engine.id,
    displayName: engine.displayName,
    paradigm: engine.paradigm,
    icon: engine.icon,
    summary: engine.summary,
    version: engine.version,
    capabilities: engine.capabilities,
    terminology: engine.terminology,
    templates: (engine.templates ?? []).map(({ id, title, summary, tableCount }) => ({
      id,
      title,
      summary,
      tableCount,
    })),
  };
}

/** Byte comparison, like every other ordering in this SDK: no ICU dependency, so the payload is
 *  identical on every machine and diff-stable in a cache. */
function byDisplayName(a: { displayName: string }, b: { displayName: string }): number {
  return a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : 0;
}

/**
 * A "not yet implemented" engine is a row of data with no matching registration.
 * `EngineDefinition` carries no `status` field — status is a property of the DEPLOYMENT, not of
 * the engine — so the registry derives it by set difference. That is what makes the picker
 * registry-driven end to end and keeps every engine id out of `apps/web`.
 */
export function createEngineRegistry(announced: readonly AnnouncedEngine[]): EngineRegistry {
  const engines = new Map<EngineId, EngineDefinition>();

  return {
    register(definition: EngineDefinition): void {
      if (engines.has(definition.id)) throw new DuplicateEngineError(definition.id);
      engines.set(definition.id, definition);
    },
    has(id: EngineId): boolean {
      return engines.has(id);
    },
    get(id: EngineId): EngineDefinition {
      const engine = engines.get(id);
      if (engine === undefined) throw new UnknownEngineError(id);
      return engine;
    },
    tryGet(id: EngineId): EngineDefinition | undefined {
      return engines.get(id);
    },
    list(): readonly EngineDefinition[] {
      return [...engines.values()].sort(byDisplayName);
    },
    catalog(): EngineCatalog {
      return {
        available: [...engines.values()].map(describe).sort(byDisplayName),
        comingSoon: announced.filter((a) => !engines.has(a.id)).sort(byDisplayName),
      };
    },
  };
}
