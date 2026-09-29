import { Global, Module } from '@nestjs/common';
import { createEngineRegistry, type EngineRegistry } from '@schemaloom/engine-sdk';
import { COMING_SOON } from './coming-soon.const';
import { EngineGate } from './engine-gate.service';
import { EnginesController } from './engines.controller';
import { ENGINE_MANIFEST } from './engines.manifest';
import { ENGINE_REGISTRY } from './engines.tokens';

/**
 * Doc 01 §4.2 — **core; this file names no engine.** The split is the whole point: adding
 * MySQL is a dependency plus one line in `engines.manifest.ts`, and nothing here, under
 * `access/`, `schema/`, `projects/` or `transfer/` changes.
 *
 * `@Global()` so every module injects `ENGINE_REGISTRY` without an import-graph edge, which is
 * what keeps engine resolution from spreading into module metadata all over the app.
 *
 * `EngineRegistry` IS `createEngineRegistry(announced)` from the SDK, wrapped by exactly one
 * Nest provider. There is no Nest-native reimplementation, so the framework-free version stays
 * the single implementation and the same registry runs in the SDK's own tests.
 *
 * DEVIATION from doc 01 §4.2's snippet, stated rather than silently dropped: it registers each
 * engine under a multi-valued `ENGINE_DEFINITION` token and injects the array into the factory.
 * **Nest has no multi-providers** — `Provider` is `Class|Value|Factory|Existing` and none of
 * them carries a `multi` flag (that is Angular; `APP_GUARD` gets its many-registrations
 * behaviour from a special token, not a general mechanism). The factory therefore reads
 * `ENGINE_MANIFEST` directly, which doc 01's own snippet already imports into this file. The
 * property that mattered — one manifest file names the engines, this file names none — holds
 * unchanged, and a token nothing can inject is not worth declaring.
 */
/**
 * Doc 03 §14: constructed from the ANNOUNCED list; "coming soon" is derived by set difference,
 * so a registration always wins and shipping an engine needs no edit to the announcement.
 * `register` throws `DuplicateEngineError` on a repeated id, at boot — a wiring bug fails the
 * deploy rather than a request. Exported for `engine-upgrade.cli.ts`, which runs without Nest.
 */
export function buildEngineRegistry(): EngineRegistry {
  const registry = createEngineRegistry(COMING_SOON);
  for (const engine of ENGINE_MANIFEST) registry.register(engine);
  return registry;
}

@Global()
@Module({
  controllers: [EnginesController],
  providers: [
    {
      provide: ENGINE_REGISTRY,
      useFactory: buildEngineRegistry,
    },
    EngineGate,
  ],
  exports: [ENGINE_REGISTRY, EngineGate],
})
export class EnginesModule {}
