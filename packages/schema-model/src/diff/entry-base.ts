/**
 * The header every diff entry carries: what it is, where it groups, and where it sorts.
 * Built from ONE model — the before model for a `removed` entry, the after model for
 * `added` and `changed` (§7.5).
 */
import type { Id } from '../ids.js';
import { logicalKey } from '../logical-key.js';
import type { IrObjectType, SchemaModel } from '../model.js';
import type { NormalizeName } from '../normalize-name.js';
import { sortPath } from './sort-path.js';

/**
 * §7.2 — the entity a change belongs to, for `entriesByEntity` grouping and for the
 * migration generator's one-`ALTER TABLE`-per-entity pass. Undefined for namespace,
 * customType, area, and for the entity entry itself.
 */
export function ownerEntityId(
  model: SchemaModel,
  type: IrObjectType,
  id: Id,
): Id | undefined {
  switch (type) {
    case 'field':
      return model.objects.field[id]?.entityId;
    case 'constraint':
      return model.objects.constraint[id]?.entityId;
    case 'index':
      return model.objects.index[id]?.entityId;
    case 'link':
      return model.objects.link[id]?.from.entityId;
    case 'area':
    case 'namespace':
    case 'customType':
    case 'entity':
      return undefined;
  }
}

export interface EntryBase {
  id: Id;
  logicalKey: string;
  ownerEntityId?: Id;
  sortPath: string;
}

export function entryBase(
  model: SchemaModel,
  type: IrObjectType,
  id: Id,
  normalize: NormalizeName,
): EntryBase {
  return {
    id,
    logicalKey: logicalKey(model, type, id, normalize),
    ownerEntityId: ownerEntityId(model, type, id),
    sortPath: sortPath(model, type, id),
  };
}
