import type { Id } from '../ids.js';
import { IR_OBJECT_TYPES, type IrCollections, type IrObjectType } from '../model.js';
import type { RedactedModel } from './brand.js';

/** The part of a realtime frame (`SchemaOperationResult`, doc 04 §8.4) this touches. */
export interface ModelPatch {
  readonly changed: Partial<IrCollections>;
  readonly removed: readonly { type: IrObjectType; id: Id }[];
}

/**
 * Doc 04 §8.7 / doc 05 §8.1 — one recipient's frame, as a VISIBILITY TRANSITION.
 *
 * Deviation from doc 05's `redactPatch(patch, ctx)`: a patch alone cannot answer the
 * transition question. Whether an object was visible BEFORE, and whether an untouched
 * object's redacted form moved (a hidden entity becoming a link stub, a link whose
 * endpoint field was just restricted), needs both redacted models. So the frame is the
 * diff of what this recipient held (`before`) against what they may hold now (`after`),
 * both produced by `redact`:
 *
 * | transition           | emitted                                   |
 * |----------------------|-------------------------------------------|
 * | invisible → invisible | nothing                                  |
 * | visible → visible     | the redacted post-image, when it differs |
 * | hidden → visible      | the full (recipient-redacted) post-image |
 * | visible → masked      | the masked post-image                    |
 * | visible → hidden      | a synthetic `removed` entry              |
 *
 * The patch's own `changed` post-images are RAW and are never read here — only `after`'s
 * objects leave. Its `removed` is passed through unfiltered: an id alone leaks nothing
 * and every client must converge.
 *
 * Returns `null` when nothing is left — the caller must not emit.
 *
 * ponytail: JSON equality per object, O(model) per recipient per commit. Fine at the
 * spec's 300-entity scale; compare `version` + a geometry tuple if profiles disagree.
 */
export function redactPatch<P extends ModelPatch>(
  patch: P,
  before: RedactedModel,
  after: RedactedModel,
): P | null {
  const changed: Partial<Record<IrObjectType, Record<Id, unknown>>> = {};
  const removed = new Map<string, { type: IrObjectType; id: Id }>();
  for (const r of patch.removed) removed.set(`${r.type}:${r.id}`, { type: r.type, id: r.id });

  let changes = 0;
  for (const type of IR_OBJECT_TYPES) {
    const was: Record<Id, unknown> = before.objects[type];
    const now: Record<Id, unknown> = after.objects[type];
    for (const [id, object] of Object.entries(now)) {
      const prior = was[id];
      if (prior !== undefined && JSON.stringify(prior) === JSON.stringify(object)) continue;
      (changed[type] ??= {})[id] = object;
      changes += 1;
    }
    for (const id of Object.keys(was)) {
      if (now[id] === undefined) removed.set(`${type}:${id}`, { type, id });
    }
  }

  if (changes === 0 && removed.size === 0) return null;
  return { ...patch, changed: changed as Partial<IrCollections>, removed: [...removed.values()] };
}
