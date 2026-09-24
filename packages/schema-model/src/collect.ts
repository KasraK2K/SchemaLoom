import type { Id } from './ids.js';

/** Append to a bucket, creating it on first use. The one grouping primitive assembly and
 *  `createIndex` share; without it both spell out the same three lines a dozen times. */
export function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [value]);
  else bucket.push(value);
}

/** Group rows by a key, preserving input order within each bucket. */
export function groupBy<T>(rows: readonly T[], keyOf: (row: T) => Id): Map<Id, T[]> {
  const out = new Map<Id, T[]>();
  for (const row of rows) pushTo(out, keyOf(row), row);
  return out;
}

/** Sort every bucket in place and hand the map back, so a grouped map can be built and
 *  ordered in one expression. */
export function sortBuckets<K, V>(map: Map<K, V[]>, compare: (a: V, b: V) => number): Map<K, V[]> {
  for (const bucket of map.values()) bucket.sort(compare);
  return map;
}

/** Set-valued sibling of `pushTo`, for adjacency and other dedup-as-you-go buckets. */
export function addToSet<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, new Set([value]));
  else bucket.add(value);
}
