import type { Id, SchemaModel } from '@schemaloom/schema-model';
import type { AccessList } from '@/features/sharing/model';

/**
 * Say it before it happens (docs/phase23/AREA-CARDS.md §2, doc 05 §7.11). A grant on an
 * area covers every table in it, so joining or leaving a card can widen or narrow who sees
 * a table. The sentences are built from the `GET /access` payload the sharing dialog
 * already uses, and only when the caller can see it (`canManage`): someone who cannot see
 * the grants gets no dialog, which is no more than the inspector let them do before.
 *
 * "People" are the principals holding a grant ON the area itself (users, groups, pending
 * invites); access inherited from the project or the org is not what a card changes.
 */
export interface AreaChange {
  /** names of the tables being moved */
  readonly tables: readonly string[];
  /** the cards they are in now */
  readonly from: ReadonlySet<Id>;
  /** the card they are going to, or `null` for none */
  readonly to: Id | null;
  /** the card is being deleted, not just left */
  readonly ungroup?: boolean;
}

const people = (n: number): string => (n === 1 ? '1 person' : `${String(n)} people`);

function tablesPhrase(names: readonly string[]): string {
  const shown = names.slice(0, 2).map((n) => `\`${n}\``);
  const more = names.length - shown.length;
  if (more > 0) shown.push(`${String(more)} more`);
  return shown.length <= 1
    ? (shown[0] ?? '')
    : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1] ?? ''}`;
}

export function sharedWith(access: AccessList, areaId: Id): number {
  return access.entries.filter((entry) =>
    entry.grants.some((g) => g.resourceType === 'area' && g.resourceId === areaId),
  ).length;
}

export function accessLines(
  access: AccessList,
  model: Pick<SchemaModel, 'objects'>,
  change: AreaChange,
): string[] {
  if (!access.canManage || change.tables.length === 0) return [];
  const nameOf = (id: Id): string => model.objects.area[id]?.name ?? 'This area';
  const tables = tablesPhrase(change.tables);
  const lines: string[] = [];

  for (const id of change.from) {
    if (id === change.to) continue;
    const n = sharedWith(access, id);
    if (n === 0) continue;
    lines.push(
      change.ungroup === true
        ? `${nameOf(id)} is shared with ${people(n)}. Ungrouping removes that sharing.`
        : `${nameOf(id)} is shared with ${people(n)}. Anyone who only has access through it will no longer see ${tables}.`,
    );
  }
  if (change.to !== null && !change.from.has(change.to)) {
    const n = sharedWith(access, change.to);
    if (n > 0)
      lines.push(`${nameOf(change.to)} is shared with ${people(n)}. They will see ${tables} too.`);
  }
  return lines;
}
