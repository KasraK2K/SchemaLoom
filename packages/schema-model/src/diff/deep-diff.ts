/**
 * Doc 04 §7.4 — a generic structural diff over JSON values, one `PropertyChange` per leaf
 * difference, with a path. This is how core diffs `engineProps` WITHOUT understanding it.
 *
 * Every rule is deliberately dumb. Everything emitted here is `structural`: callers that
 * know the object type re-label through `severityFor` (§7.4's core table), and
 * `engineProps` needs no relabelling because §7.4 rule 4 says structural is already right.
 */
import type { PropertyChange } from './types.js';

/** §7.4 rule 5. Cycle-safe by construction: the input is JSON. */
const MAX_DEPTH = 12;

type Keyed = Record<string, unknown> & { id: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** §7.4 rule 3's escape hatch: an array whose every element is an object with an `id`. */
function allKeyed(values: readonly unknown[]): values is readonly Keyed[] {
  return (
    values.length > 0 &&
    values.every((v): v is Keyed => isPlainObject(v) && typeof v.id === 'string')
  );
}

function sortedUnion(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

function change(path: readonly string[], before: unknown, after: unknown): PropertyChange {
  return { path, before, after, severity: 'structural' };
}

function diffKeyed(
  before: readonly Keyed[],
  after: readonly Keyed[],
  path: readonly string[],
  depth: number,
  out: PropertyChange[],
): void {
  const beforePos = new Map(before.map((e, i) => [e.id, i]));
  const afterPos = new Map(after.map((e, i) => [e.id, i]));

  for (const id of sortedUnion([...beforePos.keys()], [...afterPos.keys()])) {
    const bi = beforePos.get(id);
    const ai = afterPos.get(id);
    const b = bi === undefined ? undefined : before[bi];
    const a = ai === undefined ? undefined : after[ai];
    if (b === undefined || a === undefined) {
      out.push(change([...path, id], b, a));
      continue;
    }
    // A move is reported separately from the element's own contents, so a reorder never
    // masquerades as a content change.
    if (bi !== ai) out.push(change([...path, id, '@index'], bi, ai));
    walk(b, a, [...path, id], depth + 1, out);
  }
}

function walk(
  before: unknown,
  after: unknown,
  path: readonly string[],
  depth: number,
  out: PropertyChange[],
): void {
  // §7.4 rule 2: `undefined` and a missing key are the same thing, so `{}` versus
  // `{ x: undefined }` produces nothing. `null` is a value distinct from both, and falls
  // through to the scalar compare.
  if (before === undefined && after === undefined) return;

  if (depth >= MAX_DEPTH) {
    if (JSON.stringify(before) !== JSON.stringify(after)) out.push(change(path, before, after));
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    const b: readonly unknown[] = before;
    const a: readonly unknown[] = after;
    if (allKeyed(b) && allKeyed(a)) {
      diffKeyed(b, a, path, depth, out);
      return;
    }
    // ponytail: index-based array diff. Noisy for mid-array inserts of scalars. The engine
    // can post-process its own arrays in annotateDiff, which is where that knowledge lives.
    for (let i = 0; i < Math.max(b.length, a.length); i++) {
      walk(b[i], a[i], [...path, String(i)], depth + 1, out);
    }
    return;
  }

  if (isPlainObject(before) && isPlainObject(after)) {
    // §7.4 rule 1: union of keys, SORTED, so output order is deterministic.
    for (const key of sortedUnion(Object.keys(before), Object.keys(after))) {
      walk(before[key], after[key], [...path, key], depth + 1, out);
    }
    return;
  }

  if (before !== after) out.push(change(path, before, after));
}

export function deepDiff(
  before: unknown,
  after: unknown,
  basePath: readonly string[],
): PropertyChange[] {
  const out: PropertyChange[] = [];
  walk(before, after, basePath, 0, out);
  return out;
}
