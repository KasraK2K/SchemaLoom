import { Injectable } from '@nestjs/common';
import {
  RawSchemaModel,
  redact,
  type FieldVisibilityIndex,
  type RedactedModel,
  type VisibilityContext,
} from '@schemaloom/schema-model';
import { PermissionResolver } from '../permission-resolver.service';
import type { ProjectPermissionMap, ProjectSkeleton, Subject } from '../types';

/**
 * Doc 05 §8.1 — the ONLY path schema data takes out of the server.
 *
 * This service is deliberately thin. Every redaction RULE lives in
 * `@schemaloom/schema-model`'s pure `redact()`, which has no Nest, no Prisma and no
 * database access; this class exists only to turn a `(subject, projectId)` pair into the
 * `VisibilityContext` that function is a pure function of. Keeping the rules in a pure
 * package is what makes them exhaustively testable without a container, and it is why the
 * leak audit's property test can run thousands of random models in milliseconds.
 *
 * §8.6's single-path rule is enforced by the TYPES, not by this class remembering to be
 * called: the raw model can only exist inside a `RawSchemaModel`, whose payload lives in a
 * module-private WeakMap and whose `toJSON` throws `raw_ir_escaped`. The only exported
 * function that accepts one is `redact`, and the only way to obtain a `RedactedModel` is
 * for `redact` to return it. A handler physically cannot serialise the unredacted model,
 * even by destructuring it out of a loader result — which was the realistic mistake an
 * earlier draft's `readonly ir: SchemaModel` field failed to prevent.
 */
/**
 * Doc 05 R21' — the subject's view of the project is unredacted: every entity visible, and
 * every entity holding a restricted field also `field:viewRestricted`.
 */
export function isCompleteView(ctx: VisibilityContext): boolean {
  return (
    ctx.visibleEntityIds.size === ctx.totalEntityCount &&
    [...ctx.entitiesWithRestrictedFields].every((id) => ctx.restrictedOkEntityIds.has(id))
  );
}

/** The columns `filterQueryRows` reads. A `SavedQuery` row satisfies it structurally. */
export interface QueryRow {
  readonly identifiersResolved: boolean;
  readonly touchedEntityIds: readonly string[];
  readonly touchedFieldIds: readonly string[];
}

@Injectable()
export class VisibilityFilter {
  constructor(private readonly resolver: PermissionResolver) {}

  /**
   * Resolve the subject's permissions and project skeleton, and project them onto the
   * shape `redact()` consumes.
   *
   * Both reads are cached in Redis by the resolver (the map under the three generation
   * counters, the skeleton under the project generation alone), so the common case is two
   * cache hits and no query. They are fetched concurrently because neither depends on the
   * other.
   */
  async computeContext(subject: Subject, projectId: string): Promise<VisibilityContext> {
    const [map, skel] = await Promise.all([
      this.resolver.resolveProject(subject, projectId),
      this.resolver.skeleton(projectId),
    ]);
    return this.contextFrom(subject, projectId, map, skel);
  }

  /**
   * The pure half, split out so a caller that already holds a resolved map (the schema
   * read path in step 13 resolves once for the whole request) does not resolve twice, and
   * so the mapping itself is unit-testable with no Redis.
   */
  contextFrom(
    subject: Subject,
    projectId: string,
    map: ProjectPermissionMap,
    skel: ProjectSkeleton,
  ): VisibilityContext {
    // §8.3's area rule: an area the subject holds a grant on must render even when it
    // contains no entities yet, otherwise sharing an empty area looks like a failed share.
    // "Holds anything at all" is `atomsAt` being non-empty — NOT membership of
    // `map.areaAtoms`, which only carries areas with an explicit override.
    const areasWithAtoms = new Set<string>();
    for (const areaId of skel.areaIds) {
      if (this.resolver.atomsAt(map, skel, { type: 'area', id: areaId }).size > 0) {
        areasWithAtoms.add(areaId);
      }
    }

    return {
      projectId,
      subjectKind: subject.kind,
      subjectKey: map.subjectKey,
      canOpenProject: this.resolver.canOpenProject(map),
      visibleEntityIds: this.resolver.visibleEntityIds(map, skel),
      restrictedOkEntityIds: this.resolver.restrictedOkEntityIds(map, skel),
      areasWithAtoms,
      restrictedFieldMode: map.restrictedFieldMode,
      // R21' — redact() is pure and cannot count rows itself, so the caller supplies both.
      totalEntityCount: skel.entities.length,
      entitiesWithRestrictedFields: skel.entitiesWithRestrictedFields,
    };
  }

  /**
   * The single entry point for serving schema data.
   *
   * Takes a `RawSchemaModel` — not a `SchemaModel` — so a caller cannot hand this an
   * already-redacted model by accident, and cannot hold the raw model in a plain variable
   * on the way here.
   */
  async redactModel(
    raw: RawSchemaModel,
    subject: Subject,
    projectId: string,
  ): Promise<RedactedModel> {
    return redact(raw, await this.computeContext(subject, projectId));
  }

  /** The same, for a caller that already resolved. See `contextFrom`. */
  redactWith(
    raw: RawSchemaModel,
    subject: Subject,
    projectId: string,
    map: ProjectPermissionMap,
    skel: ProjectSkeleton,
  ): RedactedModel {
    return redact(raw, this.contextFrom(subject, projectId, map, skel));
  }

  /**
   * Doc 05 L25 — saved queries (and later AI messages), whose BODY is raw schema text and
   * cannot be partially redacted. A failing row is OMITTED, never stubbed.
   *
   * - `identifiersResolved = true`: kept iff every touched entity is visible and every
   *   touched field is `full` in `fieldVis`. A field missing from the index (hidden, or
   *   deleted since) fails closed.
   * - `identifiersResolved = false`: the arrays mean nothing (an empty array would pass the
   *   test above trivially), so kept only for a subject with a complete view (R21').
   *
   * `fieldVis` is `fieldVisibilityIndex(redactedModel, ctx)`: a masked field survives
   * redaction as a restricted stub and resolves `masked` again; a hidden one is absent.
   */
  filterQueryRows<T extends QueryRow>(
    rows: readonly T[],
    ctx: VisibilityContext,
    fieldVis: FieldVisibilityIndex,
  ): T[] {
    const complete = isCompleteView(ctx);
    return rows.filter((row) =>
      row.identifiersResolved
        ? row.touchedEntityIds.every((id) => ctx.visibleEntityIds.has(id)) &&
          row.touchedFieldIds.every((id) => fieldVis.get(id) === 'full')
        : complete,
    );
  }
}
