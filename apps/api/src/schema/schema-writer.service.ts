import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PermissionAtom } from '@schemaloom/contracts';
import { Subject } from 'rxjs';
import type { Id, IrObject, IrObjectType, RedactedModel } from '@schemaloom/schema-model';
import {
  PermissionResolver,
  type ProjectPermissionMap,
  type ProjectSkeleton,
  type ResourceRef,
} from '../access';
import { PrismaService } from '../prisma/prisma.service';
import { cascadeDelete } from './cascade';
import { sortOps } from './op-order';
import {
  isTargeted,
  type SchemaOperation,
  type SchemaOperationBatch,
  type SchemaOperationResult,
  type VersionConflict,
} from './ops';
import { postImages } from './post-images';
import type { SchemaDb } from './row-read';
import { createRow, replaceChildren, updateRow } from './row-write';
import { requirementsOf } from './requirements';
import { readVersions } from './versions';
import { assertOpsVisible } from './visibility-gate';

/**
 * Doc 04 §8.2-§8.7, build-order step 14 — **the only schema write path.**
 *
 * One user gesture is one batch, one transaction, one permission check, one broadcast.
 * Plain REST would make "create a table with five columns and a primary key" seven
 * requests, seven transactions, seven permission checks and a half-created table if
 * number four fails; JSON Patch would need a whitelist of legal paths, which is this
 * typed op list written in a worse language (§8.2).
 *
 * The ORDER of the four checks is the security design, not an implementation detail:
 *
 *   1. visibility (§8.6 rule 1) — 404 / 403, and it happens BEFORE any version is read,
 *      which is what stops `expectedVersion` being used as a read primitive;
 *   2. permissions (§8.5) — the derived atoms, all-or-nothing;
 *   3. `expectedVersion` (C7) — 409, with the REDACTED current object so the client can
 *      rebase without a refetch;
 *   4. the writes themselves, atomic (§8.6 rule 5) — any failure rolls the whole batch
 *      back, because partial application of a user gesture is worse than a retry.
 */
export interface WriteContext {
  readonly projectId: Id;
  /** Null for a system write (a job, a cascade from a project setting). */
  readonly actorUserId: Id | null;
  readonly map: ProjectPermissionMap;
  readonly skel: ProjectSkeleton;
  /**
   * The actor's redacted view, resolved ONCE for the request by `VisibilityFilter`.
   *
   * This is deliberately the only model the write path is handed. Rule 1 refuses every
   * op whose target is redacted in any way, so everything downstream — requirement
   * derivation, the 409 body — is reading objects the actor may fully see, and there is
   * no unredacted model in scope that a future conflict body could leak.
   */
  readonly redacted: RedactedModel;
}

/**
 * Doc 04 §8.7 — every COMMITTED write result, for the realtime gateway. Both writers
 * (`SchemaWriter`, `GeometryWriter`) publish here after their transaction commits, and
 * nothing else writes schema rows, so this is the single place a frame originates. SQL
 * import and snapshot restore route through `SchemaWriter.apply` and publish for free.
 */
@Injectable()
export class SchemaCommits {
  readonly results = new Subject<SchemaOperationResult>();
}

@Injectable()
export class SchemaWriter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
    private readonly commits: SchemaCommits,
  ) {}

  async apply(batch: SchemaOperationBatch, ctx: WriteContext): Promise<SchemaOperationResult> {
    if (batch.projectId !== ctx.projectId) {
      // Cross-project batches are not supported (doc 05 §10.4): every ref in one request
      // belongs to the project the route named, validated against it.
      throw new BadRequestException({ code: 'project_mismatch' });
    }

    assertOpsVisible(ctx.redacted, batch.ops);
    this.assertPermissions(batch.ops, ctx);

    const ops = sortOps(batch.ops);
    const result = await this.prisma
      .$transaction(async (tx) => this.run(tx, ops, batch, ctx))
      .catch((error: unknown) => {
        // A partial `lower(name)` unique index (migration 0002) is the arbiter of name
        // collisions; surfacing its P2002 as a 500 told the user nothing. 422, not 409, so
        // restore's "409 means the project moved" conversion does not swallow it.
        if ((error as { code?: unknown }).code === 'P2002') {
          const meta = (error as { meta?: { modelName?: unknown } }).meta;
          throw new UnprocessableEntityException({
            code: 'duplicate_name',
            resourceType: meta?.modelName ?? null,
          });
        }
        throw error;
      });
    // Doc 05 §9.3: commit, THEN drop the keys. Correctness rides on the bumped `pg` in the
    // cache key; the DEL only stops dead entries lingering until their TTL.
    // `notify: false`: this commit's own frame carries the visibility transition.
    if (changesSkeleton(ops, result.removed)) {
      await this.resolver.invalidate({ project: ctx.projectId }, { notify: false });
    }
    this.commits.results.next(result);
    return result;
  }

  /**
   * §8.5 + §10.4 — N ops cost N SET LOOKUPS against the already-resolved map, never N
   * resolver calls. Grouped by atom because `assertAll` is all-or-nothing per atom and
   * checks invisibility across every ref before permission on any of them.
   */
  private assertPermissions(ops: readonly SchemaOperation[], ctx: WriteContext): void {
    const scopeOfNew = scopeOfCreated(ops, ctx.projectId);
    const byAtom = new Map<PermissionAtom, Map<string, ResourceRef>>();
    for (const op of ops) {
      for (const requirement of requirementsOf(op, { model: ctx.redacted })) {
        const ref = scopeOfNew(requirement.ref);
        const refs = byAtom.get(requirement.atom) ?? new Map<string, ResourceRef>();
        refs.set(`${ref.type}:${ref.id}`, ref);
        byAtom.set(requirement.atom, refs);
      }
    }
    for (const [atom, refs] of byAtom) {
      this.resolver.assertAll(ctx.map, ctx.skel, [...refs.values()], atom);
    }
  }

  private async run(
    tx: SchemaDb,
    ops: readonly SchemaOperation[],
    batch: SchemaOperationBatch,
    ctx: WriteContext,
  ): Promise<SchemaOperationResult> {
    const { projectId } = ctx;
    await this.assertVersions(tx, ops, ctx);

    const touched: { type: IrObjectType; id: Id }[] = [];
    const removed: { type: IrObjectType; id: Id }[] = [];
    /** Per `(entityId, parentFieldId)`, the next ordinal to hand out (§8.6 rule 6). */
    const nextOrdinal = new Map<string, number>();

    for (const op of ops) {
      switch (op.op) {
        case 'create': {
          const ordinal =
            op.type === 'field'
              ? await this.appendOrdinal(tx, projectId, op.object.entityId, op.object.parentFieldId, nextOrdinal)
              : 0;
          await createRow(tx, projectId, op, ordinal);
          touched.push({ type: op.type, id: op.object.id });
          break;
        }
        case 'update': {
          const ok = await updateRow(tx, projectId, op.type, op.id, op.expectedVersion, op.patch);
          if (!ok) throw raceConflict(op.type, op.id, op.expectedVersion);
          await replaceChildren(tx, projectId, op.type, op.id, op.patch);
          touched.push({ type: op.type, id: op.id });
          break;
        }
        case 'delete': {
          // The guarded bump doubles as the version check AND as the row lock: it fails
          // closed against a commit that landed between the pre-read and here.
          const ok = await updateRow(tx, projectId, op.type, op.id, op.expectedVersion, {});
          if (!ok) throw raceConflict(op.type, op.id, op.expectedVersion);
          const cascade = await cascadeDelete(tx, projectId, op.type, op.id);
          removed.push(...cascade.removed);
          touched.push(...cascade.modified);
          break;
        }
        case 'move': {
          const entityId = this.owningEntityId(ctx, op.id);
          const ok = await updateRow(tx, projectId, 'entity', entityId, op.expectedVersion, {});
          if (!ok) throw raceConflict('entity', entityId, op.expectedVersion);
          const moved = await this.applyMove(tx, projectId, entityId, op);
          touched.push({ type: 'entity', id: entityId });
          for (const id of moved) touched.push({ type: 'field', id });
          break;
        }
      }
    }

    // Doc 02 SavedQuery: a rename or delete of an entity or field (or its namespace) can break any saved
    // query's resolution, so every one in the project falls back to the fail-closed branch
    // (R21') until it is re-validated. Raw SQL so `updated_at` keeps meaning "edited".
    if (renamesOrDeletesNames(ops, removed)) {
      await tx.$executeRaw`UPDATE saved_queries SET identifiers_resolved = false WHERE project_id = ${projectId} AND identifiers_resolved`;
    }

    // Per-project monotonic, assigned INSIDE this transaction so a client can detect a
    // gap and refetch (§8.7). It cannot be `max(version)`: a maximum does not move when
    // a non-maximal object is edited and falls when its holder is deleted.
    // Doc 05 §9.3 + R29: a batch that changes what the skeleton says bumps `pg` exactly
    // once, in this transaction. Without it the cached skeleton outlives the write and a
    // new area is invisible even to the org owner.
    const project = await tx.project.update({
      where: { id: projectId },
      data: {
        schemaRevision: { increment: 1 },
        ...(changesSkeleton(ops, removed) ? { permGeneration: { increment: 1 } } : {}),
      },
      select: { schemaRevision: true },
    });

    const dropped = new Set(removed.map((r) => `${r.type}:${r.id}`));
    const survivors = touched.filter((t) => !dropped.has(`${t.type}:${t.id}`));

    return {
      batchId: batch.batchId,
      projectId,
      actorUserId: ctx.actorUserId,
      seq: Number(project.schemaRevision),
      changed: await postImages(tx, projectId, survivors),
      removed,
    };
  }

  /**
   * C7 — read the current versions, one query per touched TYPE, and report EVERY
   * mismatch at once. A conflict response that names one object at a time turns a
   * ten-op gesture into ten round trips.
   */
  private async assertVersions(
    tx: SchemaDb,
    ops: readonly SchemaOperation[],
    ctx: WriteContext,
  ): Promise<void> {
    const wanted = new Map<IrObjectType, Map<Id, number>>();
    for (const op of ops) {
      if (!isTargeted(op)) continue;
      // A move carries the OWNING ENTITY's version (doc 02 §9.3): one conflict check per
      // gesture, so two concurrent reorders collide instead of interleaving.
      const type: IrObjectType = op.op === 'move' ? 'entity' : op.type;
      const id = op.op === 'move' ? this.owningEntityId(ctx, op.id) : op.id;
      const byId = wanted.get(type) ?? new Map<Id, number>();
      byId.set(id, op.expectedVersion);
      wanted.set(type, byId);
    }

    const conflicts: VersionConflict[] = [];
    for (const [type, byId] of wanted) {
      const actual = await readVersions(tx, ctx.projectId, type, [...byId.keys()]);
      for (const [id, expectedVersion] of byId) {
        const actualVersion = actual.get(id);
        if (actualVersion === undefined) {
          throw new NotFoundException({ code: 'not_found', resourceType: type, id });
        }
        if (actualVersion === expectedVersion) continue;
        conflicts.push({
          type,
          id,
          expectedVersion,
          actualVersion,
          current: this.currentObject(ctx, type, id),
        });
      }
    }
    if (conflicts.length > 0) {
      throw new ConflictException({ code: 'VERSION_CONFLICT', conflicts });
    }
  }

  /**
   * §8.6 rule 6 — `max(sibling ordinals) + 1`, computed inside the transaction, with a
   * per-batch counter so two fields created in the same gesture get 7 and 8 rather than
   * 7 and 7. Revision 1 let the client mint it, and two users adding a column at the same
   * moment both read 6, both wrote 7, neither batch conflicted (nothing bumps the
   * ENTITY's version when a child is created), both committed, and the project
   * permanently failed its own `ORDINAL_COLLISION` check.
   */
  private async appendOrdinal(
    tx: SchemaDb,
    projectId: Id,
    entityId: Id,
    parentFieldId: Id | null,
    counters: Map<string, number>,
  ): Promise<number> {
    const key = `${entityId}\u0000${parentFieldId ?? ''}`;
    const cached = counters.get(key);
    if (cached !== undefined) {
      counters.set(key, cached + 1);
      return cached;
    }
    const top = await tx.field.findFirst({
      where: { projectId, entityId, parentFieldId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const next = (top?.position ?? -1) + 1;
    counters.set(key, next + 1);
    return next;
  }

  /**
   * §8.4 — the server recomputes dense ordinals over the TRUE sibling list, which is why
   * `beforeFieldId` may name a field the client only ever saw masked, and why `null`
   * means "after the true last sibling" rather than "after the last one you can see".
   */
  private async applyMove(
    tx: SchemaDb,
    projectId: Id,
    entityId: Id,
    op: { id: Id; parentFieldId?: Id | null; beforeFieldId: Id | null },
  ): Promise<Id[]> {
    const field = await tx.field.findFirst({
      where: { projectId, id: op.id },
      select: { parentFieldId: true },
    });
    if (field === null) {
      throw new NotFoundException({ code: 'not_found', resourceType: 'field', id: op.id });
    }
    const from = field.parentFieldId;
    const to = op.parentFieldId === undefined ? from : op.parentFieldId;
    if (to !== from) {
      await tx.field.updateMany({ where: { projectId, id: op.id }, data: { parentFieldId: to } });
    }

    const order = await this.siblingIds(tx, projectId, entityId, to);
    const rest = order.filter((id) => id !== op.id);
    const at = op.beforeFieldId === null ? -1 : rest.indexOf(op.beforeFieldId);
    rest.splice(at < 0 ? rest.length : at, 0, op.id);
    await this.writePositions(tx, projectId, rest);

    // Re-parenting leaves a hole in the list the field came from; a sparse ordinal set
    // fails the model's own density check, so the old list is re-densified too.
    if (to === from) return rest;
    const old = await this.siblingIds(tx, projectId, entityId, from);
    await this.writePositions(tx, projectId, old);
    return [...rest, ...old];
  }

  private async siblingIds(
    tx: SchemaDb,
    projectId: Id,
    entityId: Id,
    parentFieldId: Id | null,
  ): Promise<Id[]> {
    const rows = await tx.field.findMany({
      where: { projectId, entityId, parentFieldId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  private async writePositions(tx: SchemaDb, projectId: Id, ids: readonly Id[]): Promise<void> {
    await Promise.all(
      ids.map((id, position) =>
        tx.field.updateMany({ where: { projectId, id }, data: { position } }),
      ),
    );
  }

  /** From the REDACTED model; rule 1 has already proved the field fully visible. */
  private owningEntityId(ctx: WriteContext, fieldId: Id): Id {
    const field = ctx.redacted.objects.field[fieldId];
    if (field === undefined) {
      throw new NotFoundException({ code: 'not_found', resourceType: 'field', id: fieldId });
    }
    return field.entityId;
  }

  private currentObject(ctx: WriteContext, type: IrObjectType, id: Id): IrObject {
    const object: IrObject | undefined = ctx.redacted.objects[type][id];
    if (object === undefined) {
      throw new NotFoundException({ code: 'not_found', resourceType: type, id });
    }
    return object;
  }
}

/**
 * An entity or area CREATED in this batch is not in the skeleton yet, so `assertAll`
 * would 404 a field, index or link that names it — which made "a table and its columns in
 * one batch" (SQL import, a pasted table) impossible. No grant can name an id that does
 * not exist, so the new object's effective scope is exactly the one it is being created
 * in: its area if it has one, else the project. Chains through a new area to the project.
 */
function scopeOfCreated(
  ops: readonly SchemaOperation[],
  projectId: Id,
): (ref: ResourceRef) => ResourceRef {
  const project: ResourceRef = { type: 'project', id: projectId };
  const newAreas = new Set<Id>();
  const newEntities = new Map<Id, Id | null>();
  for (const op of ops) {
    if (op.op !== 'create') continue;
    if (op.type === 'area') newAreas.add(op.object.id);
    if (op.type === 'entity') newEntities.set(op.object.id, op.object.areaId);
  }
  const ofArea = (id: Id): ResourceRef => (newAreas.has(id) ? project : { type: 'area', id });
  return (ref) => {
    if (ref.type === 'area') return ofArea(ref.id);
    if (ref.type !== 'entity' || !newEntities.has(ref.id)) return ref;
    const areaId = newEntities.get(ref.id) ?? null;
    return areaId === null ? project : ofArea(areaId);
  };
}

/**
 * Doc 05 §9.3 — the only schema writes that move `Project.permGeneration`: entity or area
 * create/delete (including cascades), an entity's `areaId`, and `field.isRestricted`.
 */
export function changesSkeleton(
  ops: readonly SchemaOperation[],
  removed: readonly { type: IrObjectType }[],
): boolean {
  if (removed.some((r) => r.type === 'entity' || r.type === 'area')) return true;
  return ops.some((op) => {
    if (op.op === 'create' || op.op === 'delete') return op.type === 'entity' || op.type === 'area';
    if (op.op !== 'update') return false;
    const patch = op.patch as Record<string, unknown>;
    return (op.type === 'entity' && 'areaId' in patch) || (op.type === 'field' && 'isRestricted' in patch);
  });
}

/** An entity or field (or the namespace qualifying it) was renamed or removed, directly
 *  or by cascade. */
export function renamesOrDeletesNames(
  ops: readonly SchemaOperation[],
  removed: readonly { type: IrObjectType }[],
): boolean {
  const named = (type: IrObjectType): boolean =>
    type === 'entity' || type === 'field' || type === 'namespace';
  if (removed.some((r) => named(r.type))) return true;
  return ops.some(
    (op) =>
      named(op.type) &&
      (op.op === 'delete' || (op.op === 'update' && 'name' in (op.patch as Record<string, unknown>))),
  );
}

/**
 * Lost the row-level race: the guarded `UPDATE … WHERE version = ?` matched nothing, so
 * somebody committed between the pre-read and the write. `current` is deliberately
 * absent — the object in hand is now known to be stale, and shipping a stale post-image
 * labelled "current" is worse than making the client refetch.
 */
const raceConflict = (type: IrObjectType, id: Id, expectedVersion: number): ConflictException =>
  new ConflictException({
    code: 'VERSION_CONFLICT',
    conflicts: [{ type, id, expectedVersion }],
  });
