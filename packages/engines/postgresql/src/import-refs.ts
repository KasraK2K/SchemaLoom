import type { Id, IrObject, IrObjectType, ObjectRefs, SchemaModel } from '@schemaloom/engine-sdk';
import { extractReferences } from './references.js';

/**
 * Seat `refs` on every object an import produced — the same thing core does on every write
 * (doc 03 §3.1: "called by core on EVERY write of an expression-bearing object **and on
 * import**").
 *
 * Skipping it would be invisible until it mattered, and then it would matter in two places at
 * once:
 *
 *  - REDACTION. Doc 05's R27 blanks an `engineProps` bag whose expressions name something the
 *    viewer may not see, and it decides that from `refs`. An imported model with no `refs`
 *    takes the fail-closed path — every CHECK body, default and view definition blanked for
 *    anyone without `field:viewRestricted` over the whole entity.
 *  - EXPORT ORDER. §10.1 rule 2 puts a table before the view that selects from it, and the
 *    exporter reads that dependency off `refs.entityIds`. Without it a freshly imported schema
 *    exports its views first, which is invalid DDL produced deterministically.
 *
 * It runs after both import passes because `extractReferences` matches names against the
 * WHOLE model: a view's body may name a table declared further down the file.
 */

/** Sub-kind is the engine's own `kind` for the types that have one, and null for the rest. */
function subKindOf(type: IrObjectType, object: IrObject): string | null {
  if (type === 'entity' || type === 'link' || type === 'constraint' || type === 'customType') {
    return 'kind' in object ? object.kind : null;
  }
  return null;
}

const BEARERS: readonly IrObjectType[] = [
  'customType',
  'entity',
  'field',
  'constraint',
  'index',
  'link',
];

export function seatReferences(model: SchemaModel): void {
  for (const type of BEARERS) {
    const bag: Record<Id, IrObject> = model.objects[type];
    for (const [id, object] of Object.entries(bag)) {
      const found = extractReferences(object, subKindOf(type, object), model);
      if (found.length === 0) continue;

      const refs: ObjectRefs = { entityIds: [], fieldIds: [] };
      for (const reference of found) {
        if (reference.type === 'entity') refs.entityIds.push(reference.id);
        else if (reference.type === 'field') refs.fieldIds.push(reference.id);
      }
      if (refs.entityIds.length === 0 && refs.fieldIds.length === 0) continue;
      bag[id] = { ...object, refs };
    }
  }
}
