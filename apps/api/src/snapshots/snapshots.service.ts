import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  RawSchemaModel,
  diffModels,
  type RedactedModel,
  type SchemaDiff,
  type SnapshotRef,
} from '@schemaloom/schema-model';
import { randomUUID } from 'node:crypto';
import { VisibilityFilter, type ProjectPermissionMap, type ProjectSkeleton } from '../access';
import type { Subject } from '../auth';
import { EngineGate } from '../engines';
import { PrismaService } from '../prisma/prisma.service';
import { SchemaWriter, type SchemaOperationResult } from '../schema';
import { blobToLive, loadLiveProject, snapshotBlob, type LiveIr } from './live-ir';
import { assertFullProjectView, assertSnapshotEngine } from './restore-guards';
import { planRestore } from './restore-plan';

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

@Injectable()
export class SnapshotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: SchemaWriter,
    private readonly filter: VisibilityFilter,
    private readonly gate: EngineGate,
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
  async diff(ctx: SnapshotContext, fromId: string, toId: string): Promise<SchemaDiff> {
    const [from, to] = await Promise.all([
      this.require(ctx.projectId, fromId),
      this.require(ctx.projectId, toId),
    ]);
    return diffModels(
      this.redact(ctx, blobToLive(from.ir)),
      this.redact(ctx, blobToLive(to.ir)),
      { from: refOf(from), to: refOf(to) },
    );
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
    if (batch === null) {
      // The snapshot already matches live. Writing an empty batch would bump the
      // revision and broadcast a reload for nothing.
      return {
        batchId,
        projectId: ctx.projectId,
        actorUserId: ctx.actorUserId,
        seq: Number(project.schemaRevision),
        changed: {},
        removed: [],
      };
    }

    // ponytail: an advisory re-read, not `SELECT ... FOR UPDATE`. `SchemaWriter` owns the
    // transaction and takes no caller-supplied client, so the row lock doc 02 §11 asks for
    // has to land there. This closes the window the per-object `expectedVersion` cannot
    // see — a concurrently CREATED object, which no op of ours names — and the catch below
    // converts the version conflicts it does see into the same answer.
    await this.assertUnchanged(ctx.projectId, project.schemaRevision);

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
