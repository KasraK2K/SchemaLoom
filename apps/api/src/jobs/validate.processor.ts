import { Inject, Injectable } from '@nestjs/common';
import type { EngineRegistry } from '@schemaloom/engine-sdk';
import { validateModel, type ValidationIssue } from '@schemaloom/schema-model';
import { VisibilityFilter } from '../access';
import { ENGINE_REGISTRY } from '../engines';
import { SchemaLoader } from '../schema';
import type { ValidateJobData } from './queues';

/**
 * Whole-model validation, off the request path.
 *
 * The write path validates the SCOPE it touched (doc 04 §8.6 rule 9). This is the other
 * one: every structural invariant over the whole project, which is too slow to run inside
 * a keystroke-rate write and is exactly what a queue is for.
 *
 * It validates the SUBJECT'S model, and `validateModel` is already redaction-aware — it
 * skips every object carrying `restricted`, so a stub entity does not produce a parade of
 * false "missing name" errors. The issues it returns are therefore safe to hand straight
 * back to the requester, with no per-recipient filtering step to forget.
 *
 * ponytail: per-subject, not project-wide — an issue inside an entity the requester cannot
 * see is not reported. The project-wide cached run doc 03 §2.3 describes needs the
 * UNREDACTED model, which lives behind `snapshots/live-ir.ts` and is deliberately not
 * reachable from here; wire that source in when the cached-and-broadcast validator lands.
 */
@Injectable()
export class ValidateProcessor {
  constructor(
    private readonly loader: SchemaLoader,
    private readonly visibility: VisibilityFilter,
    @Inject(ENGINE_REGISTRY) private readonly registry: EngineRegistry,
  ) {}

  async run(data: ValidateJobData): Promise<ValidationIssue[]> {
    const { projectId, subject } = data;
    const model = await this.visibility.redactModel(
      await this.loader.load(projectId),
      subject,
      projectId,
    );

    // §6.3: name collisions are decided under the engine's folding, so `Orders` and
    // `orders` collide in PostgreSQL and do not in an engine that folds nothing. Wrapped
    // rather than passed by reference — `normalizeName` is a method, and an unbound one
    // is a `this` bug waiting for the first engine that keeps state.
    const engine = this.registry.tryGet(model.engineId);
    if (engine === undefined) return validateModel(model);
    return validateModel(model, { normalizeName: (s: string) => engine.normalizeName(s) });
  }
}
