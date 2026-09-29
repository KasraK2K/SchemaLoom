import type { SchemaModel } from '@schemaloom/schema-model';

/**
 * Doc 05 L8 / §8 — "documented X/Y", computed post-redaction over the model this reader
 * already holds. Entities and fields only (the IR's `doc` is the input: null means
 * undocumented). A stub entity or a masked field is in neither the numerator nor the
 * denominator; a hidden field is not in the model at all.
 */
export function docCoverage(model: SchemaModel): { documented: number; total: number } {
  let documented = 0;
  let total = 0;
  for (const object of [...Object.values(model.objects.entity), ...Object.values(model.objects.field)]) {
    if (object.restricted === true) continue;
    total += 1;
    if (object.doc !== null) documented += 1;
  }
  return { documented, total };
}
