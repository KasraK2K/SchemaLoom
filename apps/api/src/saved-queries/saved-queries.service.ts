import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { EngineRegistry, QueryValidationResult, QueryValidator } from '@schemaloom/engine-sdk';
import {
  fieldVisibilityIndex,
  type FieldVisibilityIndex,
  type RedactedModel,
  type VisibilityContext,
} from '@schemaloom/schema-model';
import {
  PermissionResolver,
  VisibilityFilter,
  type ProjectPermissionMap,
  type Subject,
} from '../access';
import { ENGINE_REGISTRY } from '../engines';
import type { SavedQuery } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SchemaLoader } from '../schema';
import type { CreateSavedQueryDto, UpdateSavedQueryDto } from './saved-queries.dto';

/**
 * Doc 02 `SavedQuery` + doc 05 L25 — the saved-query library.
 *
 * Every read goes through `VisibilityFilter.filterQueryRows` under the caller's CURRENT
 * context (the April-narrowing case, doc 05 §12.1): a failing row is omitted from lists
 * and 404s by id. The query text is the payload and SQL cannot be partially redacted, so
 * there is no stub.
 *
 * Every write re-runs the engine `queryValidator` against the CALLER's redacted model and
 * stores `identifiersResolved` together with the touched arrays and the join rows in one
 * transaction. No validator (or anything it could not resolve) saves `false`, which the
 * filter treats fail-closed (R21').
 */

export interface SavedQueryView {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly description: string | null;
  readonly queryText: string;
  readonly language: string;
  readonly tags: readonly string[];
  readonly identifiersResolved: boolean;
  /** Already visible to the caller: the row passed `filterQueryRows`. */
  readonly touchedEntityIds: readonly string[];
  readonly createdById: string | null;
  /** creator, or `sharing:manage` at project scope */
  readonly canEdit: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One caller's view of one project, resolved once per request. */
interface CallerView {
  readonly subject: Subject;
  readonly map: ProjectPermissionMap;
  readonly ctx: VisibilityContext;
  readonly redacted: RedactedModel;
  readonly fieldVis: FieldVisibilityIndex;
  readonly canManage: boolean;
}

/**
 * Strict: parsed, nothing hidden, and every identifier either resolved or query-local.
 * `unchecked` passes only for functions (the validator does not resolve built-ins);
 * an unchecked identifier anywhere else may name something the caller cannot see.
 */
export function identifiersResolved(result: QueryValidationResult): boolean {
  return (
    result.parsed &&
    result.parseErrors.length === 0 &&
    result.hiddenReferences.length === 0 &&
    result.identifiers.every(
      (i) =>
        i.status === 'resolved' ||
        i.status === 'alias-local' ||
        (i.status === 'unchecked' && i.role === 'function'),
    )
  );
}

const notFound = (id: string): NotFoundException =>
  new NotFoundException({ code: 'not_found', resourceType: 'saved_query', id });

@Injectable()
export class SavedQueriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly loader: SchemaLoader,
    private readonly filter: VisibilityFilter,
    private readonly resolver: PermissionResolver,
    @Inject(ENGINE_REGISTRY) private readonly registry: EngineRegistry,
  ) {}

  /** For the agent-token check in the controller (Phase 21 §5). */
  async projectSettings(projectId: string): Promise<unknown> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId },
      select: { settings: true },
    });
    return project?.settings ?? null;
  }

  async list(
    subject: Subject,
    projectId: string,
    map: ProjectPermissionMap,
    tag?: string,
  ): Promise<SavedQueryView[]> {
    const view = await this.view(subject, projectId, map);
    const rows = await this.prisma.savedQuery.findMany({
      where: { projectId, ...(tag ? { tags: { has: tag } } : {}) },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
    return this.filter.filterQueryRows(rows, view.ctx, view.fieldVis).map((r) => toView(r, view));
  }

  async get(subject: Subject, id: string): Promise<SavedQueryView> {
    const { row, view } = await this.visibleRow(subject, id);
    return toView(row, view);
  }

  async create(
    subject: Subject,
    projectId: string,
    map: ProjectPermissionMap,
    body: CreateSavedQueryDto,
  ): Promise<SavedQueryView> {
    const userId = requireUser(subject);
    const view = await this.view(subject, projectId, map);
    const resolution = await this.resolve(view, body.queryText);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.savedQuery.create({
        data: {
          projectId,
          createdById: userId,
          name: body.name,
          description: body.description ?? null,
          queryText: body.queryText,
          tags: body.tags ?? [],
          ...resolution,
        },
      });
      await tx.savedQueryEntity.createMany({
        data: resolution.touchedEntityIds.map((entityId) => ({
          savedQueryId: created.id,
          entityId,
          projectId,
        })),
      });
      return created;
    });
    return toView(row, view);
  }

  async update(subject: Subject, id: string, body: UpdateSavedQueryDto): Promise<SavedQueryView> {
    const { row, view } = await this.editableRow(subject, id);
    // Always re-validated, not only when the text changed: it is what sets a flag the
    // SchemaWriter reset after a rename back to true.
    const resolution = await this.resolve(view, body.queryText ?? row.queryText);
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.savedQuery.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.queryText !== undefined ? { queryText: body.queryText } : {}),
          ...(body.tags !== undefined ? { tags: body.tags } : {}),
          ...resolution,
          version: { increment: 1 },
        },
      });
      await tx.savedQueryEntity.deleteMany({ where: { savedQueryId: id } });
      await tx.savedQueryEntity.createMany({
        data: resolution.touchedEntityIds.map((entityId) => ({
          savedQueryId: id,
          entityId,
          projectId: row.projectId,
        })),
      });
      return next;
    });
    return toView(updated, view);
  }

  async remove(subject: Subject, id: string): Promise<void> {
    await this.editableRow(subject, id);
    // Join rows cascade on `saved_query_id`.
    await this.prisma.savedQuery.deleteMany({ where: { id } });
  }

  /** The editor's live check. 400 when the project's engine has no validator. */
  async validate(
    subject: Subject,
    projectId: string,
    map: ProjectPermissionMap,
    query: string,
  ): Promise<QueryValidationResult> {
    const view = await this.view(subject, projectId, map);
    const validator = this.validatorFor(view.redacted);
    if (validator === undefined) {
      throw new BadRequestException({
        code: 'engine.feature-unsupported',
        engineId: view.redacted.engineId,
        feature: 'queryValidation',
      });
    }
    return this.run(validator, view.redacted, query);
  }

  // --- internals -----------------------------------------------------------------------

  private async view(
    subject: Subject,
    projectId: string,
    known?: ProjectPermissionMap,
  ): Promise<CallerView> {
    const map = known ?? (await this.resolver.resolveProject(subject, projectId));
    // Invisible is 404 (§7.9): a project the caller cannot open does not exist for them.
    if (!this.resolver.canOpenProject(map)) throw notFound(projectId);
    const skel = await this.resolver.skeleton(projectId);
    const ctx = this.filter.contextFrom(subject, projectId, map, skel);
    const redacted = this.filter.redactWith(
      await this.loader.load(projectId),
      subject,
      projectId,
      map,
      skel,
    );
    return {
      subject,
      map,
      ctx,
      redacted,
      fieldVis: fieldVisibilityIndex(redacted, ctx),
      canManage: this.resolver
        .atomsAt(map, skel, { type: 'project', id: projectId })
        .has('sharing:manage'),
    };
  }

  /** Missing, in a project the caller cannot open, or failing L25 — all the same 404. */
  private async visibleRow(
    subject: Subject,
    id: string,
  ): Promise<{ row: SavedQuery; view: CallerView }> {
    const row = await this.prisma.savedQuery.findFirst({ where: { id } });
    if (row === null) throw notFound(id);
    const view = await this.view(subject, row.projectId).catch((error: unknown) => {
      throw error instanceof NotFoundException ? notFound(id) : error;
    });
    if (this.filter.filterQueryRows([row], view.ctx, view.fieldVis).length === 0) {
      throw notFound(id);
    }
    return { row, view };
  }

  /** Visible (else 404), then creator or project `sharing:manage` (else 403). */
  private async editableRow(
    subject: Subject,
    id: string,
  ): Promise<{ row: SavedQuery; view: CallerView }> {
    const found = await this.visibleRow(subject, id);
    if (!canEdit(found.row, found.view)) {
      throw new ForbiddenException({ code: 'forbidden', resourceType: 'saved_query', id });
    }
    return found;
  }

  private validatorFor(model: RedactedModel): QueryValidator | undefined {
    return this.registry.tryGet(model.engineId)?.queryValidator;
  }

  private run(
    validator: QueryValidator,
    model: RedactedModel,
    query: string,
  ): Promise<QueryValidationResult> {
    // No `restrictedProbe`, ever (doc 03 §12.1, doc 05 L13).
    return validator.validate({
      query,
      model,
      context: { projectId: model.projectId, serverVersion: model.engineVersion },
    });
  }

  /** The columns written in the same transaction as the flag. */
  private async resolve(
    view: CallerView,
    queryText: string,
  ): Promise<{
    identifiersResolved: boolean;
    touchedEntityIds: string[];
    touchedFieldIds: string[];
  }> {
    const validator = this.validatorFor(view.redacted);
    if (validator === undefined) {
      return { identifiersResolved: false, touchedEntityIds: [], touchedFieldIds: [] };
    }
    const result = await this.run(validator, view.redacted, queryText);
    // Join rows FK `entities`; a stub or anything not in the caller's model is dropped.
    const entities = view.redacted.objects.entity;
    return {
      identifiersResolved: identifiersResolved(result),
      touchedEntityIds: [...new Set(result.touchedEntityIds)].filter((id) => id in entities),
      touchedFieldIds: [...new Set(result.touchedFieldIds)],
    };
  }
}

function requireUser(subject: Subject): string {
  if (subject.kind !== 'user') throw new NotFoundException({ code: 'not_found' });
  return subject.userId;
}

function canEdit(row: SavedQuery, view: CallerView): boolean {
  if (view.canManage) return true;
  return view.subject.kind === 'user' && row.createdById === view.subject.userId;
}

function toView(row: SavedQuery, view: CallerView): SavedQueryView {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    queryText: row.queryText,
    language: row.language,
    tags: row.tags,
    identifiersResolved: row.identifiersResolved,
    touchedEntityIds: row.touchedEntityIds,
    createdById: row.createdById,
    canEdit: canEdit(row, view),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
