import type { Id, IrObject, IrObjectRef, SchemaModel } from '@schemaloom/engine-sdk';
import { normalizeName } from './normalize-name.js';

/**
 * `extractReferences` (doc 03 §3.1): the ids an object's expressions name, which is how
 * `VisibilityFilter` blanks a CHECK body or a view naming a column the viewer may not see.
 *
 * A TOKEN scanner over the SUPERSET rule, as in the PostgreSQL engine: it reads inside string
 * literals and comments, accepts backtick- and double-quoted names (MySQL's `ANSI_QUOTES`),
 * and counts any token that matches a column of the object's table, or a table anywhere, as
 * a reference. An id too many costs one viewer an expression; one too few is a leak. It is
 * pure, synchronous and never throws, because core calls it on every write.
 */

/** `engineProps` keys whose value is SQL text. */
const EXPRESSION_KEYS = [
  'default',
  'onUpdate',
  'generatedExpression',
  'expression',
  'viewDefinition',
] as const;

const IDENTIFIER =
  '(?:`(?:[^`]|``)*`|"(?:[^"]|"")*"|[A-Za-z_$\\u0080-\\uffff][A-Za-z0-9_$\\u0080-\\uffff]*)';
const CHAIN_RE = new RegExp(`${IDENTIFIER}(?:\\s*\\.\\s*${IDENTIFIER})*`, 'g');
const PART_RE = /`((?:[^`]|``)*)`|"((?:[^"]|"")*)"|([A-Za-z_$\u0080-￿][A-Za-z0-9_$\u0080-￿]*)/g;

/** Every expression string the object carries, including an expression index's columns. */
export function expressionsOf(object: IrObject): readonly string[] {
  const out: string[] = [];
  for (const key of EXPRESSION_KEYS) {
    const value = object.engineProps[key];
    if (typeof value === 'string' && value.length > 0) out.push(value);
  }
  if ('columns' in object) {
    for (const column of object.columns) {
      if (column.expression !== null && column.expression.length > 0) out.push(column.expression);
    }
  }
  return out;
}

interface NameIndex {
  readonly entitiesByName: ReadonlyMap<string, readonly Id[]>;
  readonly fieldsByEntity: ReadonlyMap<Id, ReadonlyMap<string, readonly Id[]>>;
}

function push(map: Map<string, Id[]>, key: string, id: Id): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [id]);
  else existing.push(id);
}

/** Memoised per model: an import calls this once per object over the same model. */
const INDEX_CACHE = new WeakMap<SchemaModel, NameIndex>();

function nameIndex(model: SchemaModel): NameIndex {
  const cached = INDEX_CACHE.get(model);
  if (cached !== undefined) return cached;
  const entitiesByName = new Map<string, Id[]>();
  const fieldsByEntity = new Map<Id, Map<string, Id[]>>();
  for (const entity of Object.values(model.objects.entity)) {
    push(entitiesByName, normalizeName(entity.name), entity.id);
  }
  for (const field of Object.values(model.objects.field)) {
    let fields = fieldsByEntity.get(field.entityId);
    if (fields === undefined) {
      fields = new Map<string, Id[]>();
      fieldsByEntity.set(field.entityId, fields);
    }
    push(fields, normalizeName(field.name), field.id);
  }
  const built: NameIndex = { entitiesByName, fieldsByEntity };
  INDEX_CACHE.set(model, built);
  return built;
}

function partsOf(chain: string): readonly string[] {
  const parts: string[] = [];
  for (const match of chain.matchAll(PART_RE)) {
    const raw = match[1]?.replace(/``/g, '`') ?? match[2]?.replace(/""/g, '"') ?? match[3] ?? '';
    if (raw.length > 0) parts.push(normalizeName(raw));
  }
  return parts;
}

class RefSet {
  private readonly seen = new Set<string>();
  private readonly refs: IrObjectRef[] = [];

  add(type: IrObjectRef['type'], id: Id): void {
    const key = `${type}:${id}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.refs.push({ type, id });
  }

  addAll(type: IrObjectRef['type'], ids: readonly Id[] | undefined): void {
    for (const id of ids ?? []) this.add(type, id);
  }

  /** Byte-ordered, so a persisted `refs` column is diff-stable. */
  sorted(): readonly IrObjectRef[] {
    return [...this.refs].sort((a, b) =>
      a.type < b.type ? -1 : a.type > b.type ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
  }
}

function resolveChain(
  index: NameIndex,
  owner: Id | null,
  parts: readonly string[],
  out: RefSet,
): void {
  const fieldsOf = (entityId: Id | null, name: string) =>
    entityId === null ? [] : (index.fieldsByEntity.get(entityId)?.get(name) ?? []);
  // `db.table.column` names the same table as `table.column`: there is one database.
  const [first, second] = parts.slice(-2);
  if (first === undefined) return;
  if (second === undefined) {
    out.addAll('field', fieldsOf(owner, first));
    out.addAll('entity', index.entitiesByName.get(first));
    return;
  }
  for (const entityId of index.entitiesByName.get(first) ?? []) {
    out.add('entity', entityId);
    out.addAll('field', fieldsOf(entityId, second));
  }
  // `orders.total` where `orders` is an alias: still a column of the owner if it has one.
  out.addAll('field', fieldsOf(owner, second));
  out.addAll('entity', index.entitiesByName.get(second));
}

function owningEntityId(object: IrObject): Id | null {
  if ('entityId' in object) return object.entityId;
  if ('position' in object) return object.id;
  return null;
}

export function extractReferences(
  object: IrObject,
  _subKind: string | null,
  model: SchemaModel,
): readonly IrObjectRef[] {
  const expressions = expressionsOf(object);
  if (expressions.length === 0) return [];
  const index = nameIndex(model);
  const owner = owningEntityId(object);
  const refs = new RefSet();
  for (const expression of expressions) {
    const chains = (expression.match(CHAIN_RE) ?? []).map(partsOf);
    // A view's `SELECT salary FROM emp` names `emp.salary` without saying so: an unqualified
    // name is also a column of every table the same expression names (superset rule). Missing
    // it let a viewer barred from `emp.salary` read a view body that names it.
    const named = chains.flatMap((parts) =>
      parts.flatMap((p) => index.entitiesByName.get(p) ?? []),
    );
    for (const parts of chains) {
      resolveChain(index, owner, parts, refs);
      const [only] = parts;
      if (parts.length !== 1 || only === undefined) continue;
      for (const entityId of named) {
        refs.addAll('field', index.fieldsByEntity.get(entityId)?.get(only));
      }
    }
  }
  return refs.sorted();
}

/** Seat `refs` on every expression-bearing object an import produced (doc 03 §3.1). */
export function seatReferences(model: SchemaModel): void {
  for (const type of ['entity', 'field', 'constraint', 'index', 'link'] as const) {
    const bag: Record<Id, IrObject> = model.objects[type];
    for (const [id, object] of Object.entries(bag)) {
      const subKind = 'kind' in object && type !== 'index' ? object.kind : null;
      const found = extractReferences(object, subKind, model);
      const entityIds = found.filter((r) => r.type === 'entity').map((r) => r.id);
      const fieldIds = found.filter((r) => r.type === 'field').map((r) => r.id);
      if (entityIds.length === 0 && fieldIds.length === 0) continue;
      bag[id] = { ...object, refs: { entityIds, fieldIds } };
    }
  }
}
