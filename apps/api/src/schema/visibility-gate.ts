import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { SchemaModel } from '@schemaloom/schema-model';
import { isTargeted, type SchemaOperation } from './ops';

/**
 * Doc 04 §8.6 RULE 1 — **visibility is checked first, before versions.**
 *
 * An op whose target `VisibilityFilter` would redact for this actor IN ANY WAY — a stub,
 * a masked field, or merely `propsRedacted` — fails here and never reaches the version
 * comparison. That ordering is the whole point, not a stylistic preference:
 * `expectedVersion` is otherwise a READ PRIMITIVE. Send a deliberately wrong version
 * against a guessed id and a 409 that says "actual 7" has confirmed the object exists,
 * told you how often it has been edited, and (in revision 1, which shipped `current`
 * raw) handed back its name, type, docs and `engineProps`. A 404 ordered ahead of the
 * version read says nothing at all.
 *
 * 403 vs 404 follows doc 05 §7.10: the object is DISCLOSED to this actor (it is in their
 * redacted model as a stub or a mask) so refusing with 403 is honest — they already know
 * it is there. An object absent from the redacted model is HIDDEN, and its existence must
 * not be confirmed, so it is a 404 indistinguishable from a wrong id.
 *
 * This rule is also what makes a whole-collection patch safe. `Index.columns` and
 * `Constraint.fieldIds` are replaced wholesale by an update op — exactly the
 * full-list-replacement hazard doc 05 R22 forbids — except that doc 05 §8.3 marks any
 * index or constraint touching a redacted field `restricted`, so the op is refused before
 * the list is ever read. Only `Field.ordinal` needs a move op, because there the ENTITY is
 * visible while a FIELD is masked.
 *
 * Pure, and takes the already-redacted model: it needs no resolver, no Prisma and no
 * request, and there is nothing here that could accidentally consult the raw model.
 */
export function assertOpsVisible(
  redacted: SchemaModel,
  ops: readonly SchemaOperation[],
): void {
  for (const op of ops) {
    // A create names no existing target. Its PARENTS (entityId, areaId, link endpoints)
    // are checked by `requirementsOf` + `assertAll`, which 404s an invisible one under
    // the same rule; and a colliding id is `DUPLICATE_ID` at insert time.
    if (!isTargeted(op)) continue;

    const object: unknown = redacted.objects[op.type][op.id];
    if (object === undefined) {
      throw new NotFoundException({ code: 'not_found', resourceType: op.type, id: op.id });
    }
    const mark = object as { restricted?: true; propsRedacted?: true };
    if (mark.restricted === true || mark.propsRedacted === true) {
      throw new ForbiddenException({
        code: 'object_redacted',
        resourceType: op.type,
        id: op.id,
      });
    }
  }
}
