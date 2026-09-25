/**
 * Doc 04 §7.2 — THE diff types. One `SchemaDiff` serves both the visual diff UI and the
 * engine's `migrationGenerator` (§7.1); they differ by selector, not by type, because two
 * types would mean two matchers and the matcher is the part most likely to be wrong.
 */
import type { Id } from '../ids.js';
import type { IrObjectMap, IrObjectType } from '../model.js';
import type { MatchStrategy, NormalizeName } from '../normalize-name.js';

export interface SnapshotRef {
  kind: 'live' | 'snapshot' | 'import';
  /** Snapshot id, when `kind === 'snapshot'`. */
  id?: Id;
  /** "v3 — before billing rework" */
  label?: string;
  /** ISO 8601 string, never a `Date` — a diff is JSON on the wire. */
  capturedAt?: string;
}

export type ChangeType = 'added' | 'removed' | 'changed';

export type PropertySeverity =
  /** Affects the generated DDL / migration. */
  | 'structural'
  /** Changes who can see the object, or asserts something compliance-relevant about it.
   *  Emits no DDL, but a reviewer must always see it: `ignoreCosmetic` never drops it and
   *  the migration generator always skips it. */
  | 'governance'
  /** Documentation only: COMMENT ON, docs site, deprecation badge. */
  | 'documentation'
  /** Canvas geometry and presentation. */
  | 'cosmetic';

export interface PropertyChange {
  /** Path inside the object: `['name']`, `['type','args','0']`,
   *  `['engineProps','identity','always']`, `['from','fieldIds','1']`. */
  path: readonly string[];
  before: unknown;
  after: unknown;
  severity: PropertySeverity;
  /** Filled by the engine's `annotateDiff`, NEVER by core. `undefined` = not yet
   *  classified; the UI renders red only on `true`. */
  destructive?: boolean;
  /** Short engine-authored explanation. */
  note?: string;
}

/**
 * Generic in the object type so `DiffEntry` distributes and
 * `Extract<DiffEntry, { objectType: 'field' }>` actually narrows — both the entry payload
 * and `entriesOfType`'s return.
 *
 * There is deliberately NO risk field here. §7.7 / Open question 12: an `added` or
 * `removed` entry has no `PropertyChange` to hang destructiveness on, so entry-level risk
 * lives on doc 03's `AnnotatedDiff.entryRisk` side map, where engine knowledge belongs.
 */
interface DiffEntryBase<T extends IrObjectType> {
  objectType: T;
  /** `after` id for added/changed, `before` id for removed. */
  id: Id;
  logicalKey: string;
  /** The entity this change belongs to, for grouping. Set for field, index, constraint,
   *  and for link (its `from` entity). Undefined for namespace, customType, area, and for
   *  the entity entry itself. */
  ownerEntityId?: Id;
  /** Precomputed, opaque, lexicographically sortable ordering key (§7.5). */
  sortPath: string;
}

export type DiffEntryOf<T extends IrObjectType> =
  | (DiffEntryBase<T> & { change: 'added'; after: IrObjectMap[T] })
  | (DiffEntryBase<T> & { change: 'removed'; before: IrObjectMap[T] })
  | (DiffEntryBase<T> & {
      change: 'changed';
      before: IrObjectMap[T];
      after: IrObjectMap[T];
      properties: PropertyChange[];
      /** How the two sides were paired. `'pinned'` means a human confirmed the pair via
       *  `DiffOptions.pinnedRenames`; it is NEVER inferred (§7.3 — the scoring rename
       *  heuristic is deleted). */
      matchedBy: 'id' | 'logicalKey' | 'pinned';
    });

export type DiffEntry = { [T in IrObjectType]: DiffEntryOf<T> }[IrObjectType];

export interface DiffCounts {
  added: number;
  removed: number;
  changed: number;
}

export interface SchemaDiff {
  irVersion: 1;
  engineId: string;
  from: SnapshotRef;
  to: SnapshotRef;
  /** True when either input model had `redacted === true`. `opsFromDiff` THROWS on such a
   *  diff (§8.8): a restore computed from a view that is missing objects the viewer cannot
   *  see would delete every one of them. */
  redacted: boolean;
  /** Sorted by `sortPath`. One flat array, discriminated by `objectType`. */
  entries: DiffEntry[];
  summary: DiffCounts & {
    /** `changed` entries carrying at least one destructive `PropertyChange`. Always 0 out
     *  of core: only an engine's `annotateDiff` sets `destructive`. */
    destructive: number;
    byObjectType: Record<IrObjectType, DiffCounts>;
  };
}

/** A pair a human confirmed in the diff UI. Never inferred. */
export interface PinnedRename {
  objectType: IrObjectType;
  removedId: Id;
  addedId: Id;
}

export interface DiffOptions {
  /** Default `'id-then-logical'`. */
  matchStrategy?: MatchStrategy;
  /** Pairs confirmed by a human. ALWAYS applied. There is no heuristic pass and therefore
   *  no mode switch — see §7.3. */
  pinnedRenames?: PinnedRename[];
  /** Drop cosmetic-only entries entirely. The migration generator passes true.
   *  NEVER drops a `governance` change. */
  ignoreCosmetic?: boolean;
  /** Engine identifier folding (§6.3). Applied to both sides. Default: identity. */
  normalizeName?: NormalizeName;
  /** Provenance for the two sides. The CALLER supplies it because `diffModels` is pure:
   *  it has no clock and must never mint a `capturedAt`. Default `{ kind: 'live' }`. */
  from?: SnapshotRef;
  to?: SnapshotRef;
}
