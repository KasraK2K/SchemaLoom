import { addToSet } from './collect.js';
import type { Id } from './ids.js';
import type { Link } from './link.js';
import type { JoinPath, JoinStep, ModelIndex, TopologicalOrder } from './model-index.js';

/**
 * The link graph (§9): neighbours, join paths, export order.
 *
 * `joinPaths` and `topologicalEntityOrder` are the two lazy derivations §12.7 asks for —
 * computed on first call and cached on the index, because the AI needs the first and the
 * exporter the second, rarely in the same request.
 */

/** §9 defaults. */
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_LIMIT = 5;

/**
 * ponytail: hard ceiling on BFS expansions instead of a smarter frontier. Simple-path
 * enumeration is exponential in a dense graph; at maxDepth 4 over a real schema it never
 * comes close. If a profiler ever disagrees, switch to bidirectional search — the
 * signature does not change.
 */
const MAX_EXPANSIONS = 20_000;

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function linksOf(ix: ModelIndex, entityId: Id, dir: 'out' | 'in' | 'both' = 'both'): Link[] {
  const links = ix.linksByEntity.get(entityId) ?? [];
  if (dir === 'both') return [...links];
  return links.filter((l) =>
    dir === 'out' ? l.from.entityId === entityId : l.to.entityId === entityId,
  );
}

export function linksTouchingField(ix: ModelIndex, fieldId: Id): Link[] {
  return [...(ix.linksByField.get(fieldId) ?? [])];
}

export function neighbours(ix: ModelIndex, entityId: Id): Id[] {
  return [...(ix.adjacency.get(entityId) ?? [])];
}

/** Positional endpoint pairing (§2.7). `min` rather than a throw: a LINK_ARITY-invalid
 *  model still yields a usable path, and `validateModel` is what reports the arity. */
function pairs(from: readonly Id[], to: readonly Id[]): [Id, Id][] {
  const out: [Id, Id][] = [];
  for (let i = 0; i < Math.min(from.length, to.length); i++) {
    const a = from[i];
    const b = to[i];
    if (a !== undefined && b !== undefined) out.push([a, b]);
  }
  return out;
}

/** Every way to leave `cur` along `link` — two ways when the link is a loop. */
function transitions(link: Link, cur: Id): JoinStep[] {
  const out: JoinStep[] = [];
  if (link.from.entityId === cur) {
    out.push({
      linkId: link.id,
      fromEntityId: cur,
      toEntityId: link.to.entityId,
      direction: 'forward',
      fieldPairs: pairs(link.from.fieldIds, link.to.fieldIds),
    });
  }
  if (link.to.entityId === cur) {
    out.push({
      linkId: link.id,
      fromEntityId: cur,
      toEntityId: link.from.entityId,
      direction: 'reverse',
      fieldPairs: pairs(link.to.fieldIds, link.from.fieldIds),
    });
  }
  return out;
}

/** cost = number of steps, +1 per N:M hop — an unresolved many-to-many needs a junction. */
function stepCost(link: Link): number {
  return link.cardinality === 'N:M' ? 2 : 1;
}

interface Frontier {
  entityId: Id;
  steps: JoinStep[];
  cost: number;
  visited: ReadonlySet<Id>;
}

/**
 * Shortest-first BFS over the link graph. Defaults: maxDepth 4, limit 5.
 *
 * Deterministic: equal-cost paths sort by the concatenated logical keys of their steps,
 * so the AI's suggestion list never reshuffles between calls.
 *
 * `opts.allowed` restricts the traversal to entities the viewer may see — the AI module
 * passes the visible set and diffs a path's entities against the user's selection to
 * offer "add `order_items` to include this join".
 *
 * `from === to` yields no paths: a self-join is a Phase-2 refinement, and returning the
 * cycles back to the start table here would fill a 5-slot suggestion list with noise.
 */
export function joinPaths(
  ix: ModelIndex,
  from: Id,
  to: Id,
  opts?: { maxDepth?: number; limit?: number; allowed?: Set<Id> },
): JoinPath[] {
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const allowed = opts?.allowed;

  // Only the unrestricted query is cached: an `allowed` set would have to be serialized
  // into the key, and the AI asks with a different set per request anyway.
  const cacheKey =
    allowed === undefined ? `${from}>${to}|${String(maxDepth)}|${String(limit)}` : null;
  if (cacheKey !== null) {
    const hit = ix.joinPathCache.get(cacheKey);
    if (hit !== undefined) return hit.map((p) => ({ ...p, steps: [...p.steps] }));
  }

  const found = search(ix, from, to, maxDepth, limit, allowed);
  if (cacheKey !== null) ix.joinPathCache.set(cacheKey, found);
  return found.map((p) => ({ ...p, steps: [...p.steps] }));
}

function search(
  ix: ModelIndex,
  from: Id,
  to: Id,
  maxDepth: number,
  limit: number,
  allowed: Set<Id> | undefined,
): JoinPath[] {
  if (from === to || maxDepth < 1 || limit < 1) return [];
  if (ix.model.objects.entity[from] === undefined) return [];
  if (ix.model.objects.entity[to] === undefined) return [];
  if (allowed !== undefined && (!allowed.has(from) || !allowed.has(to))) return [];

  const results: JoinPath[] = [];
  const queue: Frontier[] = [{ entityId: from, steps: [], cost: 0, visited: new Set([from]) }];
  let head = 0;
  let expansions = 0;

  while (head < queue.length && expansions < MAX_EXPANSIONS) {
    const node = queue[head++];
    if (node === undefined) break;
    if (node.steps.length >= maxDepth) continue;
    expansions++;

    for (const link of ix.linksByEntity.get(node.entityId) ?? []) {
      for (const step of transitions(link, node.entityId)) {
        const next = step.toEntityId;
        if (allowed !== undefined && !allowed.has(next)) continue;
        const steps = [...node.steps, step];
        const cost = node.cost + stepCost(link);
        if (next === to) {
          results.push({ from, to, steps, cost });
          continue;
        }
        if (node.visited.has(next)) continue;
        if (ix.model.objects.entity[next] === undefined) continue;
        queue.push({
          entityId: next,
          steps,
          cost,
          visited: new Set([...node.visited, next]),
        });
      }
    }
  }

  const keyed = results.map((path) => ({
    path,
    tie: path.steps.map((s) => ix.logicalKeys.link.get(s.linkId) ?? s.linkId).join('|'),
  }));
  keyed.sort((a, b) => a.path.cost - b.path.cost || compareStrings(a.tie, b.tie));
  return keyed.slice(0, limit).map((k) => k.path);
}

/**
 * Kahn's algorithm over link dependencies: the child (a link's `from`) depends on the
 * parent (its `to`), so parents are emitted first. Deterministic tie-break by logical
 * key.
 *
 * Cycles are NOT an error — self-referencing and mutually-referencing foreign keys are
 * legal. Their members are appended in logical-key order and reported, so the exporter
 * knows to emit those foreign keys as trailing ALTER statements.
 *
 * §9 also names `TypeRef.customTypeId` edges. They run entity -> customType, and a
 * custom type is not an entity, so they cannot order entities among themselves and add
 * nothing here. Emitting `CREATE TYPE` before the tables that use it is the exporter's
 * own ordering over `objects.customType`, not a constraint on this list.
 */
export function topologicalEntityOrder(ix: ModelIndex): TopologicalOrder {
  const cached = ix.topoCache;
  if (cached !== null) return cached;

  const entities = ix.model.objects.entity;
  const keyOf = (id: Id): string => ix.logicalKeys.entity.get(id) ?? id;
  const byKey = (a: Id, b: Id): number => compareStrings(keyOf(a), keyOf(b));

  const successors = new Map<Id, Set<Id>>();
  const indegree = new Map<Id, number>();
  for (const id of Object.keys(entities)) indegree.set(id, 0);

  for (const link of Object.values(ix.model.objects.link)) {
    const parent = link.to.entityId;
    const child = link.from.entityId;
    if (entities[parent] === undefined || entities[child] === undefined) continue;
    const out = successors.get(parent) ?? new Set<Id>();
    if (out.has(child)) continue; // a second link between the same pair is one dependency
    out.add(child);
    successors.set(parent, out);
    indegree.set(child, (indegree.get(child) ?? 0) + 1);
  }

  const order: Id[] = [];
  const ready = [...indegree].filter(([, deg]) => deg === 0).map(([id]) => id);
  while (ready.length > 0) {
    ready.sort(byKey);
    const id = ready.shift();
    if (id === undefined) break;
    order.push(id);
    for (const child of successors.get(id) ?? []) {
      const left = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, left);
      if (left === 0) ready.push(child);
    }
  }

  const placed = new Set(order);
  const remaining = Object.keys(entities)
    .filter((id) => !placed.has(id))
    .sort(byKey);
  order.push(...remaining);

  const result: TopologicalOrder = { order, cycles: componentsOf(remaining, successors, byKey) };
  ix.topoCache = result;
  return result;
}

/** Weakly-connected groups of the leftover nodes — one group per tangle, so the exporter
 *  can emit each cycle's trailing ALTERs together. A self-referencing entity is a group
 *  of one. */
function componentsOf(
  remaining: readonly Id[],
  successors: ReadonlyMap<Id, Set<Id>>,
  byKey: (a: Id, b: Id) => number,
): Id[][] {
  const pool = new Set(remaining);
  const undirected = new Map<Id, Set<Id>>();
  for (const [parent, children] of successors) {
    if (!pool.has(parent)) continue;
    for (const child of children) {
      if (!pool.has(child) || child === parent) continue;
      addToSet(undirected, parent, child);
      addToSet(undirected, child, parent);
    }
  }

  const seen = new Set<Id>();
  const groups: Id[][] = [];
  for (const start of remaining) {
    if (seen.has(start)) continue;
    const group: Id[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined) break;
      group.push(id);
      for (const next of undirected.get(id) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    groups.push(group.sort(byKey));
  }
  return groups.sort((a, b) => byKey(a[0] ?? '', b[0] ?? ''));
}
