import type { Area, Id } from '@schemaloom/schema-model';

/**
 * Area colours (§6.1 "coloured header by Area").
 *
 * `theme.css` ships eight area tokens and says why: past eight they stop being
 * distinguishable at canvas zoom, and they are "assigned round-robin by area index, so
 * the same area keeps its colour across sessions without storing one". That is this
 * file, and it is the reason `Area.color` — a Radix palette token like "indigo" — is
 * deliberately NOT read here: a raw scale step is exactly what the token layer exists to
 * keep out of component code.
 *
 * Deterministic by INDEX, not by id hash: a hash re-colours every area the day an id
 * changes shape, and two areas can collide onto one token while a third token goes
 * unused. Sorting by `ordinal` (C11) with the id as the tie-break makes the mapping a
 * pure function of the legend the user already sees.
 */
export const AREA_COLOR_COUNT = 8;

/** 0 -> `var(--color-area-1)`, 8 -> `var(--color-area-1)` again. Total for any integer. */
export function areaColorVar(index: number): string {
  const slot = ((Math.trunc(index) % AREA_COLOR_COUNT) + AREA_COLOR_COUNT) % AREA_COLOR_COUNT;
  return `var(--color-area-${String(slot + 1)})`;
}

export function areaColors(areas: readonly Area[]): ReadonlyMap<Id, string> {
  const ordered = [...areas].sort((a, b) => a.ordinal - b.ordinal || (a.id < b.id ? -1 : 1));
  return new Map(ordered.map((area, index) => [area.id, areaColorVar(index)]));
}
