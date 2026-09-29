/**
 * Doc 04 §7 — `diffModels`, a PURE function.
 *
 * No clock, no randomness, no I/O, no ambient state. The same two models produce
 * byte-identical output on every run and on every machine: every collection is iterated in
 * sorted-id order, every property walk sorts its key union, and `entries` is sorted by the
 * total `sortPath`. Provenance (`from` / `to`, including `capturedAt`) is supplied by the
 * caller precisely because this function must not read a clock.
 */
import { IR_OBJECT_TYPES, type IrObject, type IrObjectType, type SchemaModel } from '../model.js';
import { identityNormalizeName } from '../normalize-name.js';
import { entryBase } from './entry-base.js';
import { matchType } from './match.js';
import { propertyChanges } from './properties.js';
import type {
  DiffCounts,
  DiffEntry,
  DiffEntryOf,
  DiffOptions,
  SchemaDiff,
  SnapshotRef,
} from './types.js';

const LIVE: SnapshotRef = { kind: 'live' };

function zeroCounts(): Record<IrObjectType, DiffCounts> {
  return {
    area: { added: 0, removed: 0, changed: 0 },
    namespace: { added: 0, removed: 0, changed: 0 },
    customType: { added: 0, removed: 0, changed: 0 },
    entity: { added: 0, removed: 0, changed: 0 },
    field: { added: 0, removed: 0, changed: 0 },
    constraint: { added: 0, removed: 0, changed: 0 },
    index: { added: 0, removed: 0, changed: 0 },
    link: { added: 0, removed: 0, changed: 0 },
  };
}

/**
 * A `changed` entry whose every `PropertyChange` is cosmetic. `ignoreCosmetic` drops
 * exactly these — never an `added` or `removed` entry, and never one carrying a
 * `governance` change, because hiding a permission change from the review meant to catch
 * it is the failure mode the fourth severity exists to prevent.
 */
export function isCosmeticOnly(entry: DiffEntry): boolean {
  return (
    entry.change === 'changed' &&
    entry.properties.length > 0 &&
    entry.properties.every((p) => p.severity === 'cosmetic')
  );
}

function collect(
  before: SchemaModel,
  after: SchemaModel,
  type: IrObjectType,
  options: DiffOptions,
): DiffEntry[] {
  const normalize = options.normalizeName ?? identityNormalizeName;
  const { pairs, removedIds, addedIds } = matchType(
    before,
    after,
    type,
    options.matchStrategy ?? 'id-then-logical',
    normalize,
    options.pinnedRenames ?? [],
  );

  // The loop variable is the whole `IrObjectType` union, so TS widens every payload to
  // `IrObject` and cannot see that each object was read out of `model.objects[type]`. One
  // assertion per collection restores what that read already guarantees.
  const entries: DiffEntryOf<IrObjectType>[] = [];

  for (const id of removedIds) {
    const object: IrObject | undefined = before.objects[type][id];
    if (object === undefined) continue;
    entries.push({
      objectType: type,
      ...entryBase(before, type, id, normalize),
      change: 'removed',
      before: object,
    });
  }

  for (const id of addedIds) {
    const object: IrObject | undefined = after.objects[type][id];
    if (object === undefined) continue;
    entries.push({
      objectType: type,
      ...entryBase(after, type, id, normalize),
      change: 'added',
      after: object,
    });
  }

  for (const pair of pairs) {
    const b: IrObject | undefined = before.objects[type][pair.beforeId];
    const a: IrObject | undefined = after.objects[type][pair.afterId];
    if (b === undefined || a === undefined) continue;
    const properties = propertyChanges(type, b, a);
    // An id or logical-key pair with nothing different is not a change. A PINNED pair
    // always emits, because a human asserted these two are the same object and the
    // migration generator needs the entry to hang `RENAME` on.
    if (properties.length === 0 && pair.matchedBy !== 'pinned') continue;
    entries.push({
      objectType: type,
      ...entryBase(after, type, pair.afterId, normalize),
      change: 'changed',
      before: b,
      after: a,
      properties,
      matchedBy: pair.matchedBy,
    });
  }

  return entries as DiffEntry[];
}

export function diffModels(
  before: SchemaModel,
  after: SchemaModel,
  options: DiffOptions = {},
): SchemaDiff {
  const all: DiffEntry[] = [];
  for (const type of IR_OBJECT_TYPES) {
    all.push(...collect(before, after, type, options));
  }

  const entries = options.ignoreCosmetic === true ? all.filter((e) => !isCosmeticOnly(e)) : all;

  // Plain string comparison, never `localeCompare`: a locale-sensitive collator would make
  // the output machine-dependent, which is exactly what `sortPath` exists to prevent.
  entries.sort((x, y) => (x.sortPath < y.sortPath ? -1 : x.sortPath > y.sortPath ? 1 : 0));

  const byObjectType = zeroCounts();
  const summary = { added: 0, removed: 0, changed: 0, destructive: 0, byObjectType };
  for (const entry of entries) {
    summary[entry.change] += 1;
    byObjectType[entry.objectType][entry.change] += 1;
    if (entry.change === 'changed' && entry.properties.some((p) => p.destructive === true)) {
      summary.destructive += 1;
    }
  }

  return {
    irVersion: 1,
    engineId: after.engineId,
    from: options.from ?? LIVE,
    to: options.to ?? LIVE,
    redacted: before.redacted || after.redacted,
    entries,
    summary,
  };
}
