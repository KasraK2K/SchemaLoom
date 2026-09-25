import {
  AreaSchema,
  ConstraintSchema,
  CustomTypeSchema,
  EntitySchema,
  FieldSchema,
  IR_OBJECT_TYPES,
  IdSchema,
  IndexSchema,
  LinkSchema,
  NamespaceSchema,
  PointSchema,
  type Id,
  type IrCollections,
  type IrObject,
  type IrObjectType,
} from '@schemaloom/schema-model';
import { z } from 'zod';

/**
 * Doc 04 §8.4 — THE operation type, and the zod schemas that parse it at the trust
 * boundary.
 *
 * The types are INFERRED from the schemas, the house rule in `schema-model`: an op shape
 * written twice is an op shape that drifts, and this one is the write API's entire
 * surface area.
 *
 * §8.3 — the server-owned fields, removed from every payload by construction rather than
 * stripped by a handler that has to remember:
 *
 *  - `version`        C7; the server bumps it.
 *  - `restricted` /   produced by `VisibilityFilter` only.
 *    `propsRedacted`
 *  - `refs`           the engine's `extractReferences` owns it. A client able to patch it
 *                     could empty the array and un-redact the expression doc 05 R27 uses
 *                     it to hide.
 *  - `doc`            DERIVED from the TipTap tree by the docs module; forgeable
 *                     `excerpt` means forged search results and forged AI context.
 *  - `ordinal`        on CREATE of a field only (§8.6 rule 6). Keeping it out of the
 *                     payload type is what makes "the client cannot mint an ordinal"
 *                     structural — two concurrent appends that both read 6 cannot both
 *                     write 7 if neither is allowed to write it at all.
 */

const SERVER_OWNED = {
  version: true,
  restricted: true,
  propsRedacted: true,
  refs: true,
} as const;

const expectedVersion = z.number().int().nonnegative();

// ── create payloads ────────────────────────────────────────────────────────────────

const areaCreate = AreaSchema.omit({ ...SERVER_OWNED, doc: true });
const namespaceCreate = NamespaceSchema.omit(SERVER_OWNED);
const customTypeCreate = CustomTypeSchema.omit(SERVER_OWNED);
const entityCreate = EntitySchema.omit({ ...SERVER_OWNED, doc: true });
/** `ordinal` is absent: fields are APPENDED by the server (§8.6 rule 6). */
const fieldCreate = FieldSchema.omit({ ...SERVER_OWNED, doc: true, ordinal: true });
const constraintCreate = ConstraintSchema.omit(SERVER_OWNED);
const indexCreate = IndexSchema.omit(SERVER_OWNED);
const linkCreate = LinkSchema.omit(SERVER_OWNED);

export const CreateOpSchema = z.discriminatedUnion('type', [
  z.object({ op: z.literal('create'), type: z.literal('area'), object: areaCreate }),
  z.object({ op: z.literal('create'), type: z.literal('namespace'), object: namespaceCreate }),
  z.object({ op: z.literal('create'), type: z.literal('customType'), object: customTypeCreate }),
  z.object({ op: z.literal('create'), type: z.literal('entity'), object: entityCreate }),
  z.object({ op: z.literal('create'), type: z.literal('field'), object: fieldCreate }),
  z.object({ op: z.literal('create'), type: z.literal('constraint'), object: constraintCreate }),
  z.object({ op: z.literal('create'), type: z.literal('index'), object: indexCreate }),
  z.object({ op: z.literal('create'), type: z.literal('link'), object: linkCreate }),
]);

// ── update patches ─────────────────────────────────────────────────────────────────

/**
 * Canvas geometry is NOT patchable through an op: `position`, `width` and `height` go
 * through the geometry endpoint (§8.11), which neither reads nor bumps `version`.
 * Leaving them in the patch type would make every auto-layout a 300-version bump and
 * 409 every concurrent property-panel edit.
 *
 * `ordinal` is out of the FIELD patch for the same structural reason as on create:
 * reordering is a `MoveOp` over the TRUE sibling list (§8.6 rule 6, doc 05 R22). Areas
 * keep theirs — a legend is not a redacted collection.
 */
const areaPatch = AreaSchema.omit({ ...SERVER_OWNED, id: true, doc: true }).partial();
const namespacePatch = NamespaceSchema.omit({ ...SERVER_OWNED, id: true }).partial();
const customTypePatch = CustomTypeSchema.omit({ ...SERVER_OWNED, id: true }).partial();
const entityPatch = EntitySchema.omit({
  ...SERVER_OWNED,
  id: true,
  doc: true,
  position: true,
  width: true,
  height: true,
}).partial();
const fieldPatch = FieldSchema.omit({
  ...SERVER_OWNED,
  id: true,
  doc: true,
  ordinal: true,
}).partial();
const constraintPatch = ConstraintSchema.omit({ ...SERVER_OWNED, id: true }).partial();
const indexPatch = IndexSchema.omit({ ...SERVER_OWNED, id: true }).partial();
const linkPatch = LinkSchema.omit({ ...SERVER_OWNED, id: true }).partial();

const updateOp = { op: z.literal('update'), id: IdSchema, expectedVersion };

export const UpdateOpSchema = z.discriminatedUnion('type', [
  z.object({ ...updateOp, type: z.literal('area'), patch: areaPatch }),
  z.object({ ...updateOp, type: z.literal('namespace'), patch: namespacePatch }),
  z.object({ ...updateOp, type: z.literal('customType'), patch: customTypePatch }),
  z.object({ ...updateOp, type: z.literal('entity'), patch: entityPatch }),
  z.object({ ...updateOp, type: z.literal('field'), patch: fieldPatch }),
  z.object({ ...updateOp, type: z.literal('constraint'), patch: constraintPatch }),
  z.object({ ...updateOp, type: z.literal('index'), patch: indexPatch }),
  z.object({ ...updateOp, type: z.literal('link'), patch: linkPatch }),
]);

/** Identical for every type, so no per-type arm exists to get wrong. */
export const DeleteOpSchema = z.object({
  op: z.literal('delete'),
  type: z.enum(IR_OBJECT_TYPES),
  id: IdSchema,
  expectedVersion,
});

/**
 * Reordering a field is a MOVE, never a patch of `ordinal` and never a full ordered list
 * (doc 05 R22 / L20): a redacted client cannot send a dense ordinal array without
 * clobbering the positions of fields it was never shown. The server recomputes ordinals
 * over the TRUE sibling list, so `beforeFieldId` may legitimately name a field the
 * client sees masked, and `null` means "append after the true last sibling".
 *
 * `expectedVersion` is the OWNING ENTITY's (doc 02 §9.3): one conflict check per
 * gesture, not N racing per-row checks.
 */
export const MoveOpSchema = z.object({
  op: z.literal('move'),
  type: z.literal('field'),
  id: IdSchema,
  /** Omit to keep the current parent; `null` re-parents to top level. */
  parentFieldId: IdSchema.nullable().optional(),
  beforeFieldId: IdSchema.nullable(),
  expectedVersion,
});

export const SchemaOperationSchema = z.union([
  CreateOpSchema,
  UpdateOpSchema,
  DeleteOpSchema,
  MoveOpSchema,
]);

/**
 * One user gesture, one batch, one transaction, one permission check, one broadcast
 * (§8.2). The bound is a denial-of-service guard, not a design limit — a DDL import
 * arrives as several batches.
 */
export const MAX_OPS_PER_BATCH = 2000;

export const SchemaOperationBatchSchema = z.object({
  /** A CORRELATION id, not an idempotency key (§8.7): the client uses it to recognise
   *  its own echo, and a timed-out batch is resolved by REFETCHING, never by retrying. */
  batchId: IdSchema,
  projectId: IdSchema,
  ops: z.array(SchemaOperationSchema).min(1).max(MAX_OPS_PER_BATCH),
  /** Shown in the activity log: "Import DDL", "Paste 3 tables", "Auto-layout". */
  label: z.string().max(120).optional(),
});

/** §8.11 — the one write that is not an op. `batchId` is here for the same reason it is
 *  on an op batch: the author's client has to recognise its own echo on the frame. */
export const GeometryBatchSchema = z.object({
  batchId: IdSchema,
  entities: z
    .array(
      z.object({
        id: IdSchema,
        position: PointSchema,
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
      }),
    )
    .min(1)
    .max(MAX_OPS_PER_BATCH),
});

export type CreateOp = z.infer<typeof CreateOpSchema>;
export type UpdateOp = z.infer<typeof UpdateOpSchema>;
export type DeleteOp = z.infer<typeof DeleteOpSchema>;
export type MoveOp = z.infer<typeof MoveOpSchema>;
export type SchemaOperation = z.infer<typeof SchemaOperationSchema>;
export type SchemaOperationBatch = z.infer<typeof SchemaOperationBatchSchema>;
export type GeometryBatch = z.infer<typeof GeometryBatchSchema>;

/** Every op except `create` names an object that already exists. */
export type TargetedOp = UpdateOp | DeleteOp | MoveOp;

export const isTargeted = (op: SchemaOperation): op is TargetedOp => op.op !== 'create';

/**
 * §8.4 — what a successful write returns, and what the realtime frame carries. Server
 * produced, so there is no schema: nothing parses it on the way out.
 */
export interface SchemaOperationResult {
  batchId: Id;
  /** Routing: a client subscribed to two projects must discard the other one's frames. */
  projectId: Id;
  /** Null for system writes. Lets the author's client tell its own echo from a peer's. */
  actorUserId: Id | null;
  /** Per-project monotonic, assigned in the same transaction as the write. A client more
   *  than one behind MUST refetch rather than apply (§8.7). */
  seq: number;
  /** Post-images of everything created, updated, OR modified by a server-side cascade
   *  (§8.6 rule 8), ready to merge into `model.objects[type][id]`. */
  changed: Partial<IrCollections>;
  /** Everything removed, cascades included. NEVER filtered per recipient (§8.7): an id
   *  alone leaks nothing and every client must converge. */
  removed: { type: IrObjectType; id: Id }[];
}

/** Doc 05 §8.1 names the realtime payload `IrPatch`. It IS this type. */
export type IrPatch = SchemaOperationResult;

export interface VersionConflict {
  type: IrObjectType;
  id: Id;
  expectedVersion: number;
  actualVersion: number;
  /** ALWAYS the redacted object. §8.6 rule 1 makes an invisible target unreachable here,
   *  so by the time a conflict is built the object is one the caller may fully see. */
  current: IrObject;
}
