import type { Id, IrObject, IrObjectRef, SchemaModel } from '@schemaloom/engine-sdk';
import { normalizeName } from './normalize-name.js';

/**
 * `extractReferences` (doc 03 §3.1) — the engine's only obligation to the permission
 * system, and the reason `VisibilityFilter` can drop a whole `engineProps` bag rather
 * than ship a string naming a Restricted column.
 *
 * Three rules from §3.1 shape everything below:
 *
 *  1. SUPERSET, NOT EXACT SET. An id we return that the expression does not really touch
 *     costs one viewer a dropped expression. One we miss is a leak. So the scanner is
 *     deliberately generous: it reads inside string literals and comments, it folds
 *     quoted identifiers the way unquoted ones fold, and a bare token that happens to
 *     match a table name anywhere in the project counts as a reference to that table.
 *  2. IT FAILS CLOSED. Nothing here throws and nothing here is best-effort-silent: a
 *     string we cannot make sense of simply yields no ids, and core then treats the whole
 *     object as unanalysed.
 *  3. IT IS THE STALENESS DETECTOR. The ids are persisted to `refs`, and the validator
 *     compares them against the live model to catch a CHECK body left pointing at a
 *     renamed column.
 *
 * This is a TOKEN scanner, not a SQL parser, and that is a deliberate ceiling rather than
 * a shortcut: the real parser is `libpg-query`, a multi-megabyte WASM build that must
 * stay behind a dynamic `import()` (see `parser.ts`), while `extractReferences` is
 * declared pure and SYNCHRONOUS by the SDK and runs on every write. A token scanner over
 * a superset contract is the correct shape for that signature.
 */

/** `engineProps` keys whose value is an expression in PostgreSQL syntax. */
const EXPRESSION_KEYS = [
  'default',
  'generatedExpression',
  'where',
  'expression',
  'viewDefinition',
] as const;

/** A dotted chain: `salary`, `orders.total`, `public.orders.total`, `"Orders"."Total"`. */
const IDENTIFIER = '(?:"(?:[^"]|"")*"|[A-Za-z_\\u0080-\\uffff][A-Za-z0-9_$\\u0080-\\uffff]*)';
const CHAIN_RE = new RegExp(`${IDENTIFIER}(?:\\s*\\.\\s*${IDENTIFIER})*`, 'g');
const PART_RE = new RegExp(
  `"((?:[^"]|"")*)"|([A-Za-z_\\u0080-\\uffff][A-Za-z0-9_$\\u0080-\\uffff]*)`,
  'g',
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every expression string this object carries, without discriminating the object's type:
 * the key names are distinct per type, so reading them generically is both shorter and
 * safe against a new type being added.
 */
export function expressionsOf(object: IrObject): readonly string[] {
  const out: string[] = [];
  const props = object.engineProps;

  for (const key of EXPRESSION_KEYS) {
    const value = props[key];
    if (typeof value === 'string' && value.length > 0) out.push(value);
  }

  // domain CHECK bodies
  const checks = props.checks;
  if (Array.isArray(checks)) {
    for (const check of checks) if (typeof check === 'string' && check.length > 0) out.push(check);
  }

  // table partition key
  const partitionBy = props.partitionBy;
  if (isRecord(partitionBy)) {
    const key = partitionBy.expression;
    if (typeof key === 'string' && key.length > 0) out.push(key);
  }

  // An expression index's body lives on a CORE structure rather than in `engineProps`
  // (`IndexColumn.expression`), and `CREATE INDEX ON employees ((salary * 12))` is the
  // exact case §3.1 cites as the reason a per-column id array was not enough.
  if ('columns' in object) {
    for (const column of object.columns) {
      if (column.expression !== null && column.expression.length > 0) out.push(column.expression);
    }
  }

  return out;
}

interface NameIndex {
  /** normalized entity name -> entity ids (a name may repeat across schemas) */
  readonly entitiesByName: ReadonlyMap<string, readonly Id[]>;
  /** `schema.entity` -> entity ids */
  readonly entitiesByQualifiedName: ReadonlyMap<string, readonly Id[]>;
  /** entity id -> (normalized field name -> field ids) */
  readonly fieldsByEntity: ReadonlyMap<Id, ReadonlyMap<string, readonly Id[]>>;
}

function push(map: Map<string, Id[]>, key: string, id: Id): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [id]);
  else existing.push(id);
}

function buildNameIndex(model: SchemaModel): NameIndex {
  const entitiesByName = new Map<string, Id[]>();
  const entitiesByQualifiedName = new Map<string, Id[]>();
  const fieldsByEntity = new Map<Id, Map<string, Id[]>>();

  for (const entity of Object.values(model.objects.entity)) {
    const name = normalizeName(entity.name);
    push(entitiesByName, name, entity.id);
    const namespace = model.objects.namespace[entity.namespaceId];
    if (namespace !== undefined) {
      push(entitiesByQualifiedName, `${normalizeName(namespace.name)}.${name}`, entity.id);
    }
  }

  for (const field of Object.values(model.objects.field)) {
    let fields = fieldsByEntity.get(field.entityId);
    if (fields === undefined) {
      fields = new Map<string, Id[]>();
      fieldsByEntity.set(field.entityId, fields);
    }
    push(fields, normalizeName(field.name), field.id);
  }

  return { entitiesByName, entitiesByQualifiedName, fieldsByEntity };
}

/**
 * The index is a pure function of the model and a model is immutable per request, so it
 * is memoised on the model itself. Without this, importing 5,000 objects rebuilds the
 * name maps 5,000 times.
 */
const INDEX_CACHE = new WeakMap<SchemaModel, NameIndex>();

function nameIndex(model: SchemaModel): NameIndex {
  const cached = INDEX_CACHE.get(model);
  if (cached !== undefined) return cached;
  const built = buildNameIndex(model);
  INDEX_CACHE.set(model, built);
  return built;
}

/** Split one dotted chain into its normalized parts. A quoted part is folded like an
 *  unquoted one — wrong in PostgreSQL, right under the superset rule. */
function partsOf(chain: string): readonly string[] {
  const parts: string[] = [];
  for (const match of chain.matchAll(PART_RE)) {
    const quoted = match[1];
    const bare = match[2];
    const raw = quoted === undefined ? (bare ?? '') : quoted.replace(/""/g, '"');
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

function fieldsNamed(index: NameIndex, entityId: Id | null, name: string): readonly Id[] {
  if (entityId === null) return [];
  return index.fieldsByEntity.get(entityId)?.get(name) ?? [];
}

function resolveChain(
  index: NameIndex,
  owningEntity: Id | null,
  parts: readonly string[],
  out: RefSet,
): void {
  const [first, second, third] = parts.slice(-3);
  if (first === undefined) return;

  if (second === undefined) {
    // `salary` — a column of the object's own table, or a bare table name.
    out.addAll('field', fieldsNamed(index, owningEntity, first));
    out.addAll('entity', index.entitiesByName.get(first));
    return;
  }

  if (third === undefined) {
    // `orders.total` — or `public.orders`.
    for (const entityId of index.entitiesByName.get(first) ?? []) {
      out.add('entity', entityId);
      out.addAll('field', fieldsNamed(index, entityId, second));
    }
    out.addAll('entity', index.entitiesByQualifiedName.get(`${first}.${second}`));
    return;
  }

  // `public.orders.total`
  for (const entityId of index.entitiesByQualifiedName.get(`${first}.${second}`) ?? []) {
    out.add('entity', entityId);
    out.addAll('field', fieldsNamed(index, entityId, third));
  }
  for (const entityId of index.entitiesByName.get(second) ?? []) {
    out.addAll('field', fieldsNamed(index, entityId, third));
  }
}

/** The owning table, for resolving an unqualified column name. */
function owningEntityId(object: IrObject): Id | null {
  if ('entityId' in object) return object.entityId;
  // Only `Entity` carries `position` — `Area` derives its rectangle from its members.
  if ('position' in object) return object.id;
  return null;
}

/**
 * Pure, synchronous, total. Never throws: an expression it cannot make sense of yields
 * the ids it did recognise, which for an unparseable string is none at all.
 *
 * `subKind` is unused — the expression-bearing keys are distinct per object type, so the
 * sub-kind adds nothing this function does not already have.
 */
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
