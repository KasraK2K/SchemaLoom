import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  renderDiagnostic,
  renderMigrationScript,
  type DiagnosticParam,
  type EngineDefinition,
  type EngineRegistry,
  type ImportReport,
  type IrObjectRef,
  type MigrationPlan,
  type MigrationStep,
  type UnsupportedChange,
} from '@schemaloom/engine-sdk';
import {
  RawSchemaModel,
  diffModels,
  renameCandidates,
  type RedactedModel,
  type RenameCandidate,
  type SchemaDiff,
  type SchemaModel,
  type SnapshotRef,
} from '@schemaloom/schema-model';
import { randomUUID } from 'node:crypto';
import {
  PermissionResolver,
  VisibilityFilter,
  isCompleteView,
  type ProjectPermissionMap,
  type ProjectSkeleton,
} from '../access';
import type { Subject } from '../auth';
import { ENGINE_REGISTRY, EngineGate } from '../engines';
import { PrismaService } from '../prisma/prisma.service';
import {
  SchemaOperationBatchSchema,
  SchemaWriter,
  type SchemaOperationBatch,
  type SchemaOperationResult,
  type WriteContext,
} from '../schema';
import { writeAutoSnapshot } from './auto-snapshot';
import { renameOps, type ConfirmedRename } from './import-renames';
import {
  blobToLive,
  loadLiveProject,
  snapshotBlob,
  type LiveIr,
  type LiveProject,
} from './live-ir';
import { assertFullProjectView, assertSnapshotEngine } from './restore-guards';
import { mergeImport } from './merge-import';
import { planImport, planRestore } from './restore-plan';

/**
 * Build-order step 19 — snapshots, diff and restore.
 *
 * Three rules shape this file and none of them is obvious from the endpoint list:
 *
 * 1. **C3** — the snapshot blob is the ONLY place the IR is the stored form. The live
 *    schema stays relational; nothing here writes a second copy of it.
 * 2. **L18** — a snapshot is stored unredacted and redacted on READ with the CURRENT
 *    context, never the capture-time one. A diff is therefore computed between two
 *    redacted models, which makes `SchemaDiff.redacted` true and makes `opsFromDiff`
 *    refuse it — exactly the behaviour restore needs.
 * 3. **§8.8** — restore is the one path that needs raw models, and it gets them only
 *    through `LiveIr` (see `live-ir.ts`), never from a `RedactedModel`.
 *
 * Every route that reaches here has already been gated: `history:view` at PROJECT scope
 * for read and diff, `schema:edit` at project scope for create and restore. Open
 * question Q8 — an area-scoped editor therefore cannot use history at all — is the
 * accepted design: the blob is opaque, `VisibilityFilter` cannot filter a list, and an
 * area-scoped editor who could list snapshots would read every entity they cannot see.
 */

/** What the guard already resolved. Resolving again per request is the N+1 §10.4 forbids. */
export interface SnapshotContext {
  readonly projectId: string;
  readonly subject: Subject;
  readonly actorUserId: string | null;
  readonly map: ProjectPermissionMap;
  readonly skel: ProjectSkeleton;
}

export interface SnapshotSummary {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  /** §15.2 — the engine plugin version this blob's `engineProps` were written under. */
  enginePluginVersion: string;
  irSchemaVersion: number;
  createdAt: string;
  createdById: string | null;
}

export interface SnapshotView extends SnapshotSummary {
  ir: RedactedModel;
}

export interface CreateSnapshotInput {
  readonly name: string;
  readonly description?: string;
}

const SUMMARY = {
  id: true,
  name: true,
  description: true,
  kind: true,
  enginePluginVersion: true,
  irSchemaVersion: true,
  createdAt: true,
  createdById: true,
} as const;

const FULL = { ...SUMMARY, ir: true } as const;

/** The newest page. A project with more history than this wants a cursor, not a bigger
 *  `take`; nothing in phase 1 pages a snapshot list. */
const LIST_LIMIT = 200;

interface SnapshotRow {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  enginePluginVersion: string;
  irSchemaVersion: number;
  createdAt: Date;
  createdById: string | null;
}

const toSummary = (row: SnapshotRow): SnapshotSummary => ({
  id: row.id,
  name: row.name,
  description: row.description,
  kind: row.kind,
  enginePluginVersion: row.enginePluginVersion,
  irSchemaVersion: row.irSchemaVersion,
  createdAt: row.createdAt.toISOString(),
  createdById: row.createdById,
});

/** Provenance for `diffModels`, which is pure and must never mint a `capturedAt`. */
const refOf = (row: SnapshotRow): SnapshotRef => ({
  kind: 'snapshot',
  id: row.id,
  label: row.name,
  capturedAt: row.createdAt.toISOString(),
});

/**
 * Doc 02 §11 — **not** `stale_version`. A restore is a whole-project rewrite, so the
 * client's correct response is "reload", not "retry", and the editor shows "this project
 * was restored from a snapshot" rather than a conflict dialog it cannot resolve.
 */
const restoredConflict = (projectId: string): ConflictException =>
  new ConflictException({ code: 'project_restored', projectId });

/**
 * Phase 4 §1.1 — the header counts, computed from the diff of two REDACTED models, so they
 * count only what the caller can see (L8). `structural` counts entries that change DDL
 * (every add/remove, and every change with a structural property); `governance` counts
 * changes carrying a governance property (restricted, PII, area moves).
 */
export interface DiffHeaderCounts {
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
  readonly structural: number;
  readonly governance: number;
}

export type HistoryDiff = SchemaDiff & { readonly counts: DiffHeaderCounts };

export type LiveHistoryDiff = HistoryDiff & {
  /** R21′ — whether a restore would be allowed. Discloses only that the caller's view is
   *  partial, which they already know (`assertFullProjectView`). */
  readonly fullView: boolean;
};

export function withCounts(diff: SchemaDiff): HistoryDiff {
  const has = (severity: string) => (e: SchemaDiff['entries'][number]) =>
    e.change === 'changed' && e.properties.some((p) => p.severity === severity);
  return {
    ...diff,
    counts: {
      added: diff.summary.added,
      removed: diff.summary.removed,
      changed: diff.summary.changed,
      structural: diff.entries.filter((e) => e.change !== 'changed' || has('structural')(e)).length,
      governance: diff.entries.filter(has('governance')).length,
    },
  };
}

/**
 * Phase 5 §3 — `GET …/migration/…`. The engine's plan with each reason rendered for the
 * caller, plus the whole script. Rendering server-side is safe only because the route
 * requires the full view (R21′): every object a reason names is one the caller can see.
 */
export interface MigrationView {
  readonly steps: readonly (MigrationStep & { readonly reason: string | null })[];
  readonly summary: MigrationPlan['summary'];
  readonly unsupported: readonly (UnsupportedChange & {
    readonly change: string;
    readonly reason: string;
  })[];
  readonly script: string;
  /** the engine's `queryLanguage.fileExtension`, for the download */
  readonly fileExtension: string;
}

export interface MigrationRequest {
  readonly allowDestructive: boolean;
  readonly transactional: boolean;
}

/** Diagnostic-style rendering (doc 03 §2.4) of a migration code, naming objects from the
 *  newer model first, so a renamed table reads by its new name and a dropped one still has
 *  its old name. */
function reasonRenderer(
  engine: EngineDefinition,
  projectId: string,
  models: readonly SchemaModel[],
): (code: string, params: Readonly<Record<string, DiagnosticParam>>) => string {
  const nameOf = (ref: IrObjectRef): string | null => {
    for (const model of models) {
      const object: { name?: string } | undefined = model.objects[ref.type][ref.id];
      if (object?.name !== undefined && object.name !== '') return object.name;
    }
    return null;
  };
  return (code, params) =>
    renderDiagnostic(
      engine.diagnosticMessages,
      engine.terminology,
      { code, severity: 'info', params, target: { type: 'project', id: projectId } },
      nameOf,
    );
}

/** `POST .../import/preview` — what an import WOULD do. Nothing is written. */
export interface ImportPreview {
  /** Tables the import would create. */
  readonly creates: readonly string[];
  /** Tables the SQL names that the project already has. */
  readonly existing: readonly string[];
  /** Proposals only (§2.2); a human confirms each one. */
  readonly renameCandidates: readonly RenameCandidate[];
}

/** Doc 00 Q22 — larger sources go through the BullMQ import job (`import.processor.ts`). */
export const SYNC_IMPORT_MAX_BYTES = 5_000_000;

export interface ImportOutcome {
  readonly result: SchemaOperationResult;
  readonly report: ImportReport;
  /** Imported tables that already existed and were left unchanged. */
  readonly existing: readonly string[];
}

type BeforeWrite = NonNullable<WriteContext['beforeWrite']>;

/** The hook for the FIRST write only; later batches get none. */
function once(hook: BeforeWrite): () => BeforeWrite | undefined {
  let used = false;
  return () => {
    if (used) return undefined;
    used = true;
    return hook;
  };
}

@Injectable()
export class SnapshotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: SchemaWriter,
    private readonly filter: VisibilityFilter,
    private readonly gate: EngineGate,
    @Inject(ENGINE_REGISTRY) private readonly registry: EngineRegistry,
    private readonly resolver: PermissionResolver,
  ) {}

  /**
   * §8.9 — freeze the CURRENT IR as JSON, stamped with the project's stored
   * `enginePluginVersion` (§15.2). Requires `schema:edit`, NOT `history:view`: taking a
   * snapshot is a write-adjacent act on the project's content, and an auditor who may
   * read history has no business minting new rows.
   */
  async create(ctx: SnapshotContext, input: CreateSnapshotInput): Promise<SnapshotSummary> {
    const { live, enginePluginVersion } = await loadLiveProject(this.prisma, ctx.projectId);
    const row = await this.prisma.snapshot.create({
      data: {
        projectId: ctx.projectId,
        createdById: ctx.actorUserId,
        name: input.name,
        description: input.description ?? null,
        kind: 'manual',
        ir: snapshotBlob(live),
        irSchemaVersion: live.irVersion,
        enginePluginVersion,
      },
      select: SUMMARY,
    });
    return toSummary(row);
  }

  async list(projectId: string): Promise<SnapshotSummary[]> {
    const rows = await this.prisma.snapshot.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
      select: SUMMARY,
    });
    return rows.map(toSummary);
  }

  /** L18 — redacted with the CURRENT context. A snapshot taken when the caller had wider
   *  access does not replay that access. */
  async read(ctx: SnapshotContext, snapshotId: string): Promise<SnapshotView> {
    const row = await this.require(ctx.projectId, snapshotId);
    return { ...toSummary(row), ir: this.redact(ctx, blobToLive(row.ir)) };
  }

  /**
   * L18 — both sides are redacted before they are compared, so `SchemaDiff.redacted` is
   * true and this diff can never be fed to `opsFromDiff`. That is not a limitation of the
   * viewer; it is what stops a diff being laundered into a restore.
   */
  async diff(ctx: SnapshotContext, fromId: string, toId: string): Promise<HistoryDiff> {
    const [from, to] = await Promise.all([
      this.require(ctx.projectId, fromId),
      this.require(ctx.projectId, toId),
    ]);
    return withCounts(
      diffModels(this.redact(ctx, blobToLive(from.ir)), this.redact(ctx, blobToLive(to.ir)), {
        from: refOf(from),
        to: refOf(to),
      }),
    );
  }

  /**
   * Phase 4 §1.1 — snapshot → NOW. Both sides redacted with the caller's CURRENT context
   * (L18), exactly like a snapshot-to-snapshot diff. Refused across an engine major
   * (§15.2, like restore): the blob's `engineProps` would diff as noise.
   */
  async liveDiff(ctx: SnapshotContext, snapshotId: string): Promise<LiveHistoryDiff> {
    const [row, project] = await Promise.all([
      this.require(ctx.projectId, snapshotId),
      loadLiveProject(this.prisma, ctx.projectId),
    ]);
    assertSnapshotEngine(
      this.gate,
      { engineId: project.engineId, enginePluginVersion: project.enginePluginVersion },
      row.enginePluginVersion,
    );
    const live = this.filter.redactWith(project.raw, ctx.subject, ctx.projectId, ctx.map, ctx.skel);
    const diff = diffModels(this.redact(ctx, blobToLive(row.ir)), live, {
      from: refOf(row),
      to: { kind: 'live' },
    });
    const visibility = this.filter.contextFrom(ctx.subject, ctx.projectId, ctx.map, ctx.skel);
    return { ...withCounts(diff), fullView: isCompleteView(visibility) };
  }

  /**
   * Phase 5 §3 — the migration script from one snapshot to another, or (`toId === null`) to
   * the current schema. `history:view` at the project (the guard) AND the full view (R21′,
   * Q1): a script generated from a partial view silently omits every object the caller
   * cannot see, and running it would read as "the database now matches the design".
   *
   * Built from the same redacted models the diff routes use — with the full view required
   * they hold everything — so no unredacted model reaches the engine's output.
   */
  async migration(
    ctx: SnapshotContext,
    fromId: string,
    toId: string | null,
    request: MigrationRequest,
  ): Promise<MigrationView> {
    // R21′ first: an authorization answer, no I/O.
    const visibility = this.filter.contextFrom(ctx.subject, ctx.projectId, ctx.map, ctx.skel);
    assertFullProjectView(visibility);

    const [from, to, project] = await Promise.all([
      this.require(ctx.projectId, fromId),
      toId === null ? Promise.resolve(null) : this.require(ctx.projectId, toId),
      loadLiveProject(this.prisma, ctx.projectId),
    ]);
    const stamp = { engineId: project.engineId, enginePluginVersion: project.enginePluginVersion };
    assertSnapshotEngine(this.gate, stamp, from.enginePluginVersion);
    if (to !== null) assertSnapshotEngine(this.gate, stamp, to.enginePluginVersion);

    const engine = this.registry.tryGet(project.engineId);
    const annotate = engine?.annotateDiff;
    const generator = engine?.migrationGenerator;
    if (engine === undefined || annotate === undefined || generator === undefined) {
      throw new UnprocessableEntityException({ code: 'engine.migrations_unavailable' });
    }

    const before = this.redact(ctx, blobToLive(from.ir));
    const after =
      to === null
        ? this.filter.redactWith(project.raw, ctx.subject, ctx.projectId, ctx.map, ctx.skel)
        : this.redact(ctx, blobToLive(to.ir));
    // The same diff the history screen shows, minus canvas noise (doc 04 §7.1), so the red in
    // the script and the red in the diff come from one `annotateDiff` pass.
    const diff = annotate(
      diffModels(before, after, {
        ignoreCosmetic: true,
        from: refOf(from),
        to: to === null ? { kind: 'live' } : refOf(to),
      }),
      before,
      after,
    );
    const plan = await generator.generate({
      diff,
      before,
      after,
      options: { ...request, engineOptions: {} },
      context: { projectId: ctx.projectId, serverVersion: project.live.engineVersion },
    });

    const render = reasonRenderer(engine, ctx.projectId, [after, before]);
    const language = engine.capabilities.queryLanguage;
    return {
      steps: plan.steps.map((step) => ({
        ...step,
        reason: step.reasonCode === null ? null : render(step.reasonCode, step.reasonParams),
      })),
      summary: plan.summary,
      unsupported: plan.unsupported.map((u) => ({
        ...u,
        change: render(u.changeCode, u.changeParams),
        reason: render(u.reasonCode, u.reasonParams),
      })),
      script: renderMigrationScript(plan, {
        separator: language.statementSeparator,
        lineComment: language.lineComment,
      }),
      fileExtension: language.fileExtension,
    };
  }

  /** §7.8 — `schema:edit`, and `kind = manual` only: automatic ones age out (Q4). A
   *  snapshot of another project reads as absent. */
  async remove(ctx: SnapshotContext, snapshotId: string): Promise<void> {
    const row = await this.prisma.snapshot.findFirst({
      where: { id: snapshotId, projectId: ctx.projectId },
      select: { kind: true },
    });
    if (row === null) {
      throw new NotFoundException({ code: 'not_found', resourceType: 'snapshot', id: snapshotId });
    }
    if (row.kind !== 'manual') throw new ConflictException({ code: 'snapshot_not_manual' });
    await this.prisma.snapshot.deleteMany({
      where: { id: snapshotId, projectId: ctx.projectId, kind: 'manual' },
    });
  }

  /**
   * §8.8 — `opsFromDiff(diffModels(live, snapshot), live)` submitted as ONE batch through
   * `SchemaWriter`, so it takes the same validation, permission, version and broadcast
   * path as hand editing. There is deliberately no second mutation path here.
   */
  async restore(ctx: SnapshotContext, snapshotId: string): Promise<SchemaOperationResult> {
    // R21′ first: it is an authorization answer and it needs no I/O.
    const visibility = this.filter.contextFrom(ctx.subject, ctx.projectId, ctx.map, ctx.skel);
    assertFullProjectView(visibility);

    const row = await this.require(ctx.projectId, snapshotId);
    const project = await loadLiveProject(this.prisma, ctx.projectId);
    assertSnapshotEngine(
      this.gate,
      { engineId: project.engineId, enginePluginVersion: project.enginePluginVersion },
      row.enginePluginVersion,
    );

    const batchId = randomUUID();
    const batch = planRestore(
      project.live,
      blobToLive(row.ir),
      refOf(row),
      batchId,
      `Restore "${row.name}"`,
    );
    return this.applyPlanned(
      ctx,
      project,
      batchId,
      batch,
      this.autoSnapshot(ctx, project, 'restore', `Before restore "${row.name}"`),
    );
  }

  /**
   * Doc 00 Q22 — SQL import. The engine's importer builds a standalone IR (doc 03 §9),
   * `mergeImport` folds it into live additively (existing objects win, nothing is
   * deleted), and the difference is applied as ordinary batches through `SchemaWriter`.
   * R21′ applies for the same reason it does to restore.
   *
   * Phase 4 Q1 — the ONE exception to "existing objects win": `renames` a human confirmed
   * from the preview are validated against the fresh merge and applied FIRST, as ordinary
   * `update { name }` ops, so the renamed object keeps its id and then matches by key.
   * Q4 — the first batch that writes also writes a `kind = import` snapshot of the model
   * as it was, in that batch's transaction.
   *
   * `maxBytes` is the caller's: 5 MB on the request path, larger from the import job.
   */
  async importSource(
    ctx: SnapshotContext,
    source: string,
    maxBytes: number = SYNC_IMPORT_MAX_BYTES,
    renames: readonly ConfirmedRename[] = [],
  ): Promise<ImportOutcome> {
    const { project, model, report } = await this.parseSource(ctx, source, maxBytes);

    let merged = mergeImport(project.live, model);
    const renaming = renames.length === 0 ? [] : renameOps(project.live, merged.imported, renames);
    await this.assertUnchanged(ctx.projectId, project.schemaRevision);

    const snapshotOnce = once(this.autoSnapshot(ctx, project, 'import', 'Before import'));
    let result: SchemaOperationResult | null = null;
    let current = project;
    let batchCtx = ctx;
    // Re-read between batches: the next batch's permission check has to see the entities
    // the previous one created or renamed, in the model AND in the skeleton (a field on an
    // entity the skeleton has never heard of is a 404).
    const reload = async (): Promise<void> => {
      const [live, map, skel] = await Promise.all([
        loadLiveProject(this.prisma, ctx.projectId),
        this.resolver.resolveProject(ctx.subject, ctx.projectId),
        this.resolver.skeleton(ctx.projectId),
      ]);
      current = live;
      batchCtx = { ...ctx, map, skel };
    };

    if (renaming.length > 0) {
      const batch = SchemaOperationBatchSchema.parse({
        batchId: randomUUID(),
        projectId: ctx.projectId,
        ops: renaming,
        label: 'Import SQL: confirmed renames',
      });
      result = await this.write(ctx, project, batch, snapshotOnce());
      await reload();
      // The additive merge now runs against the RENAMED model.
      merged = mergeImport(current.live, model);
    }

    const batches = planImport(current.live, merged.model, randomUUID, 'Import SQL');
    for (const [i, batch] of batches.entries()) {
      if (i > 0) await reload();
      result = await this.write(batchCtx, current, batch, snapshotOnce());
    }
    return {
      result: result ?? this.noop(ctx, randomUUID(), project),
      report,
      existing: merged.existing,
    };
  }

  /** Phase 4 §2.1 — the same parse and merge as an import, and nothing written. */
  async preview(ctx: SnapshotContext, source: string): Promise<ImportPreview> {
    const { project, model } = await this.parseSource(ctx, source, SYNC_IMPORT_MAX_BYTES);
    const merged = mergeImport(project.live, model);
    return {
      creates: Object.values(merged.imported.objects.entity)
        .filter((e) => !(e.id in project.live.objects.entity))
        .map((e) => e.name),
      existing: merged.existing,
      // Only visible objects enter the pools: R21′ in `parseSource` required the full view.
      renameCandidates: renameCandidates(project.live, merged.imported),
    };
  }

  /** R21′, the byte cap and the engine's importer — shared by import and preview. */
  private async parseSource(
    ctx: SnapshotContext,
    source: string,
    maxBytes: number,
  ): Promise<{ project: LiveProject; model: SchemaModel; report: ImportReport }> {
    const visibility = this.filter.contextFrom(ctx.subject, ctx.projectId, ctx.map, ctx.skel);
    assertFullProjectView(visibility);

    if (Buffer.byteLength(source, 'utf8') > maxBytes) {
      throw new PayloadTooLargeException({ code: 'import_too_large', max: maxBytes });
    }

    const project = await loadLiveProject(this.prisma, ctx.projectId);
    const engine = this.registry.tryGet(project.engineId);
    const format = engine?.capabilities.importFormats[0];
    if (engine?.importer === undefined || format === undefined) {
      throw new UnprocessableEntityException({ code: 'engine.import_unavailable' });
    }

    const { model, report } = await engine.importer.import(
      source,
      {
        format: format.id,
        defaultNamespace: engine.capabilities.defaultNamespaceName,
        caseFolding:
          engine.capabilities.identifiers.foldsTo === 'none'
            ? 'preserve'
            : engine.capabilities.identifiers.foldsTo,
        engineOptions: {},
      },
      { projectId: ctx.projectId, serverVersion: project.live.engineVersion, newId: randomUUID },
    );
    return { project, model, report };
  }

  /** Q4 — the snapshot written inside the batch it precedes (see `auto-snapshot.ts`). */
  private autoSnapshot(
    ctx: SnapshotContext,
    project: LiveProject,
    kind: 'import' | 'restore',
    name: string,
  ): BeforeWrite {
    return (tx) =>
      writeAutoSnapshot(tx, {
        projectId: ctx.projectId,
        kind,
        name,
        live: project.live,
        enginePluginVersion: project.enginePluginVersion,
        createdById: ctx.actorUserId,
        now: new Date(),
      });
  }

  /** The shared tail of restore and import: an empty plan is a no-op, anything else is
   *  ONE batch through the ordinary write path. */
  private async applyPlanned(
    ctx: SnapshotContext,
    project: LiveProject,
    batchId: string,
    batch: SchemaOperationBatch | null,
    beforeWrite?: BeforeWrite,
  ): Promise<SchemaOperationResult> {
    // The snapshot already matches live. Writing an empty batch would bump the
    // revision and broadcast a reload for nothing.
    if (batch === null) return this.noop(ctx, batchId, project);

    // ponytail: an advisory re-read, not `SELECT ... FOR UPDATE`. `SchemaWriter` owns the
    // transaction and takes no caller-supplied client, so the row lock doc 02 §11 asks for
    // has to land there. This closes the window the per-object `expectedVersion` cannot
    // see — a concurrently CREATED object, which no op of ours names — and the catch below
    // converts the version conflicts it does see into the same answer.
    await this.assertUnchanged(ctx.projectId, project.schemaRevision);
    return this.write(ctx, project, batch, beforeWrite);
  }

  private noop(ctx: SnapshotContext, batchId: string, project: LiveProject): SchemaOperationResult {
    return {
      batchId,
      projectId: ctx.projectId,
      actorUserId: ctx.actorUserId,
      seq: Number(project.schemaRevision),
      changed: {},
      removed: [],
    };
  }

  private async write(
    ctx: SnapshotContext,
    project: LiveProject,
    batch: SchemaOperationBatch,
    beforeWrite?: BeforeWrite,
  ): Promise<SchemaOperationResult> {
    const redacted = this.filter.redactWith(
      project.raw,
      ctx.subject,
      ctx.projectId,
      ctx.map,
      ctx.skel,
    );
    try {
      return await this.writer.apply(batch, {
        projectId: ctx.projectId,
        actorUserId: ctx.actorUserId,
        map: ctx.map,
        skel: ctx.skel,
        redacted,
        ...(beforeWrite === undefined ? {} : { beforeWrite }),
      });
    } catch (error) {
      if (error instanceof ConflictException) throw restoredConflict(ctx.projectId);
      throw error;
    }
  }

  private redact(ctx: SnapshotContext, model: LiveIr): RedactedModel {
    return this.filter.redactWith(
      new RawSchemaModel(model),
      ctx.subject,
      ctx.projectId,
      ctx.map,
      ctx.skel,
    );
  }

  /** Scoped by `projectId` as well as `id`: the guard authorised a PROJECT, so a snapshot
   *  id from another project must read as absent rather than as forbidden. */
  private async require(projectId: string, id: string): Promise<SnapshotRow & { ir: unknown }> {
    const row = await this.prisma.snapshot.findFirst({
      where: { id, projectId },
      select: FULL,
    });
    if (row === null) {
      throw new NotFoundException({ code: 'not_found', resourceType: 'snapshot', id });
    }
    return row;
  }

  private async assertUnchanged(projectId: string, expected: bigint): Promise<void> {
    const row = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { schemaRevision: true },
    });
    if (row?.schemaRevision !== expected) throw restoredConflict(projectId);
  }
}
