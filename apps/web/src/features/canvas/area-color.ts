import type { Area, Id } from '@schemaloom/schema-model';

/**
 * Area colours (§6.1 "coloured header by Area", docs/phase23/AREA-CARDS.md §3).
 *
 * `theme.css` ships sixteen area tokens, `--color-area-1..16`. `Area.color` stores the token NAME (`area-3`),
 * so a card keeps its colour when it is renamed or reordered and each appearance theme
 * paints it its own way. Two older shapes are still read:
 *
 * - a Radix palette name ("indigo", "amber", ...) from before cards existed, mapped to the
 *   token whose hue it is;
 * - anything else, which falls back to the round-robin by `ordinal` (C11) with the id as
 *   the tie-break, so the mapping stays a pure function of the list the user sees.
 *
 * Deterministic by INDEX, not by id hash: a hash re-colours every area the day an id
 * changes shape, and two areas can collide onto one token while a third goes unused.
 */
export const AREA_COLOR_COUNT = 16;

/** The hue each token carries in `theme.css`, by Radix name. */
const LEGACY_SLOT: Readonly<Record<string, number>> = {
  jade: 0,
  green: 0,
  grass: 0,
  teal: 0,
  mint: 0,
  blue: 1,
  sky: 1,
  cyan: 1,
  amber: 2,
  yellow: 2,
  gold: 2,
  red: 3,
  tomato: 3,
  crimson: 3,
  purple: 4,
  violet: 4,
  plum: 4,
  indigo: 5,
  iris: 5,
  orange: 6,
  bronze: 6,
  brown: 6,
  pink: 7,
  ruby: 7,
};

const wrap = (index: number): number =>
  ((Math.trunc(index) % AREA_COLOR_COUNT) + AREA_COLOR_COUNT) % AREA_COLOR_COUNT;

/** The stored value for a slot: `area-1` ... `area-16`. */
export const areaToken = (slot: number): string => `area-${String(wrap(slot) + 1)}`;

/** The slot a stored value names, or `null` when it names none. */
export function slotOf(color: string): number | null {
  const token = /^area-([1-9]|1[0-6])$/.exec(color);
  if (token?.[1] !== undefined) return Number(token[1]) - 1;
  return LEGACY_SLOT[color.toLowerCase()] ?? null;
}

/** 0 -> `var(--color-area-1)`, 16 -> `var(--color-area-1)` again. Total for any integer. */
export function areaColorVar(index: number): string {
  return `var(--color-area-${String(wrap(index) + 1)})`;
}

/** The thin outline of a card, painted per theme (`--color-area-N-border`). */
export function areaBorderVar(index: number): string {
  return `var(--color-area-${String(wrap(index) + 1)}-border)`;
}

/** Id -> slot (0..7) for every area. */
export function areaSlots(areas: readonly Area[]): ReadonlyMap<Id, number> {
  const ordered = [...areas].sort((a, b) => a.ordinal - b.ordinal || (a.id < b.id ? -1 : 1));
  return new Map(ordered.map((area, index) => [area.id, slotOf(area.color) ?? wrap(index)]));
}

export function areaColors(areas: readonly Area[]): ReadonlyMap<Id, string> {
  return new Map([...areaSlots(areas)].map(([id, slot]) => [id, areaColorVar(slot)]));
}

/** The token a new area should take: the least used one, lowest slot first. */
export function nextAreaToken(areas: readonly Area[]): string {
  const uses = new Array<number>(AREA_COLOR_COUNT).fill(0);
  for (const slot of areaSlots(areas).values()) uses[slot] = (uses[slot] ?? 0) + 1;
  const least = Math.min(...uses);
  return areaToken(uses.indexOf(least));
}
