import {
  sortDiagnostics,
  type Diagnostic,
  type DiagnosticSeverity,
  type EngineContext,
  type Field,
  type Id,
  type IrBase,
  type IrObjectType,
  type SchemaModel,
} from '@schemaloom/engine-sdk';
import { CAPABILITIES, isMariaDb } from './capabilities.js';
import { CODE } from './messages.js';
import { MAX_IDENTIFIER_LENGTH, normalizeName } from './normalize-name.js';
import { INTEGER_TYPE_IDS, PREFIX_ONLY_TYPE_IDS, TYPE_CATALOG } from './types.js';

/**
 * MySQL's rules (design §4), as diagnostics on the UNREDACTED model. Advisory like every
 * validator: core shows them, nothing blocks a write on them.
 */

export interface ValidationInput {
  readonly model: SchemaModel;
  /** undefined = the whole model */
  readonly objectIds?: readonly string[];
  readonly context: EngineContext;
}

export interface MySqlValidator {
  validate(input: ValidationInput): readonly Diagnostic[];
}

const RESERVED = new Set(CAPABILITIES.identifiers.reservedWords);
const INDEX_KINDS = new Map(CAPABILITIES.indexTypes.map((i) => [i.id, i]));
const MARIADB_ONLY_TYPES = new Set(['uuid', 'inet4', 'inet6']);
const NUMERIC_CATEGORIES = new Set(['numeric']);
/** InnoDB's key length limit with DYNAMIC rows, in bytes. */
const MAX_KEY_BYTES = 3072;

class Diagnostics {
  private readonly out: Diagnostic[] = [];
  constructor(private readonly inScope: (id: Id) => boolean) {}
  add(
    severity: DiagnosticSeverity,
    code: string,
    type: IrObjectType,
    id: Id,
    params: Readonly<Record<string, string | number>> = {},
  ): void {
    if (this.inScope(id)) this.out.push({ code, severity, params, target: { type, id } });
  }
  sorted(): readonly Diagnostic[] {
    return sortDiagnostics(this.out);
  }
}

const resolve = (field: Field) =>
  TYPE_CATALOG.resolve(field.type, { customTypes: [], namespaceName: null });
const typeId = (field: Field) => resolve(field).descriptor?.id ?? field.type.name.toLowerCase();

function checkIdentifiers(model: SchemaModel, d: Diagnostics): void {
  const named: [IrObjectType, IrBase, boolean][] = [
    ...Object.values(model.objects.entity).map((o): [IrObjectType, IrBase, boolean] => [
      'entity',
      o,
      true,
    ]),
    ...Object.values(model.objects.field).map((o): [IrObjectType, IrBase, boolean] => [
      'field',
      o,
      true,
    ]),
    ...Object.values(model.objects.index).map((o): [IrObjectType, IrBase, boolean] => [
      'index',
      o,
      false,
    ]),
    // A primary key is always named `PRIMARY` by MySQL itself: no name rules apply to it.
    ...Object.values(model.objects.constraint)
      .filter((o) => o.kind !== 'primaryKey')
      .map((o): [IrObjectType, IrBase, boolean] => ['constraint', o, false]),
    ...Object.values(model.objects.link).map((o): [IrObjectType, IrBase, boolean] => [
      'link',
      o,
      false,
    ]),
  ];
  for (const [type, object, required] of named) {
    const { name } = object;
    if (name.length === 0) {
      if (required) d.add('error', CODE.identifierEmpty, type, object.id);
      continue;
    }
    const length = Array.from(name).length;
    if (length > MAX_IDENTIFIER_LENGTH) {
      d.add('error', CODE.identifierTooLong, type, object.id, { name, length });
    }
    if (RESERVED.has(normalizeName(name)))
      d.add('warning', CODE.identifierReserved, type, object.id, { name });
  }
}

function pushId(map: Map<string, Id[]>, key: string, id: Id): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [id]);
  else existing.push(id);
}

/** Tables per database; columns, indexes and unique keys per table; CHECK and FK names per
 *  database (MySQL's own scopes). `PRIMARY` is the primary key's name and no one else's. */
function checkDuplicateNames(model: SchemaModel, d: Diagnostics): void {
  const groups: [IrObjectType, Map<string, Id[]>, Map<Id, string>][] = [];
  const group = (type: IrObjectType, entries: readonly [string, Id, string][]) => {
    const keys = new Map<string, Id[]>();
    const names = new Map<Id, string>();
    for (const [key, id, name] of entries) {
      if (name === '') continue;
      pushId(keys, key, id);
      names.set(id, name);
    }
    groups.push([type, keys, names]);
  };
  const n = normalizeName;
  group(
    'entity',
    Object.values(model.objects.entity).map((e) => [n(e.name), e.id, e.name]),
  );
  group(
    'field',
    Object.values(model.objects.field).map((f) => [
      `${f.entityId}\u0000${n(f.name)}`,
      f.id,
      f.name,
    ]),
  );
  const keys = [
    ...Object.values(model.objects.index).map((i): [string, Id, string, IrObjectType] => [
      `${i.entityId}\u0000${n(i.name)}`,
      i.id,
      i.name,
      'index',
    ]),
    ...Object.values(model.objects.constraint)
      .filter((c) => c.kind === 'unique')
      .map((c): [string, Id, string, IrObjectType] => [
        `${c.entityId}\u0000${n(c.name)}`,
        c.id,
        c.name,
        'constraint',
      ]),
  ];
  group(
    'index',
    keys.filter((k) => k[3] === 'index').map(([a, b, c]) => [a, b, c]),
  );
  // Index and unique-key names share one namespace per table: check them together.
  const shared = new Map<string, [Id, IrObjectType, string][]>();
  for (const [key, id, name, type] of keys) {
    if (name === '') continue;
    shared.set(key, [...(shared.get(key) ?? []), [id, type, name]]);
  }
  for (const members of shared.values()) {
    if (members.length < 2 || members.every(([, t]) => t === 'index')) continue;
    for (const [id, type, name] of members) d.add('error', CODE.duplicateName, type, id, { name });
  }
  group(
    'constraint',
    Object.values(model.objects.constraint)
      .filter((c) => c.kind === 'check')
      .map((c) => [n(c.name), c.id, c.name]),
  );
  group(
    'link',
    Object.values(model.objects.link).map((l) => [n(l.name), l.id, l.name]),
  );

  for (const [type, map, names] of groups) {
    for (const ids of map.values()) {
      if (ids.length < 2) continue;
      for (const id of ids)
        d.add('error', CODE.duplicateName, type, id, { name: names.get(id) ?? '' });
    }
  }
  for (const index of Object.values(model.objects.index)) {
    if (n(index.name) === 'primary') d.add('error', CODE.reservedIndexName, 'index', index.id);
  }
  for (const c of Object.values(model.objects.constraint)) {
    if (c.kind !== 'primaryKey' && n(c.name) === 'primary')
      d.add('error', CODE.reservedIndexName, 'constraint', c.id);
  }
}

function checkFields(model: SchemaModel, target: string, d: Diagnostics): void {
  const autoIncrement = new Map<Id, Field[]>();
  for (const field of Object.values(model.objects.field)) {
    const resolved = resolve(field);
    const id = typeId(field);
    const props = field.engineProps;
    if (resolved.status === 'unknown')
      d.add('error', CODE.typeUnknown, 'field', field.id, { type: field.type.name });
    if ((id === 'enum' || id === 'set') && (field.type.args ?? []).length === 0) {
      d.add('error', CODE.typeNeedsValues, 'field', field.id, { type: id.toUpperCase() });
    }
    if (MARIADB_ONLY_TYPES.has(id) && !isMariaDb(target)) {
      d.add('error', CODE.typeNotOnTarget, 'field', field.id, {
        type: id,
        target: target || 'MySQL',
      });
    }
    if (props.unsigned === true && !NUMERIC_CATEGORIES.has(resolved.category)) {
      d.add('error', CODE.unsignedNotNumeric, 'field', field.id, { type: id });
    }
    if (typeof props.generatedExpression === 'string' && typeof props.default === 'string') {
      d.add('error', CODE.generatedWithDefault, 'field', field.id);
    }
    if (props.autoIncrement === true) {
      if (!INTEGER_TYPE_IDS.has(id))
        d.add('error', CODE.autoIncrementNotInteger, 'field', field.id, { type: id });
      autoIncrement.set(field.entityId, [...(autoIncrement.get(field.entityId) ?? []), field]);
    }
  }
  for (const [entityId, fields] of autoIncrement) {
    if (fields.length > 1)
      for (const f of fields) d.add('error', CODE.autoIncrementCount, 'field', f.id);
    for (const field of fields) {
      const leadsKey =
        Object.values(model.objects.constraint).some(
          (c) =>
            c.entityId === entityId &&
            (c.kind === 'primaryKey' || c.kind === 'unique') &&
            c.fieldIds[0] === field.id,
        ) ||
        Object.values(model.objects.index).some(
          (i) => i.entityId === entityId && i.columns[0]?.fieldId === field.id,
        );
      if (!leadsKey) d.add('error', CODE.autoIncrementNotIndexed, 'field', field.id);
    }
  }
}

function checkConstraints(model: SchemaModel, d: Diagnostics): void {
  for (const c of Object.values(model.objects.constraint)) {
    if (c.fieldIds.some((id) => model.objects.field[id] === undefined))
      d.add('error', CODE.columnMissing, 'constraint', c.id);
    if (c.kind === 'check' && typeof c.engineProps.expression !== 'string') {
      d.add('error', CODE.constraintMissingExpression, 'constraint', c.id);
    }
  }
}

/** Rough key length: utf8mb4 is up to 4 bytes per character. */
function keyBytes(field: Field, length: number | undefined): number {
  const id = typeId(field);
  const chars = length ?? (typeof field.type.args?.[0] === 'number' ? field.type.args[0] : 0);
  if (id === 'varchar' || id === 'char') return chars * 4;
  if (id === 'binary' || id === 'varbinary') return chars;
  return 8;
}

function checkIndexes(model: SchemaModel, target: string, d: Diagnostics): void {
  for (const index of Object.values(model.objects.index)) {
    // MySQL 8.0.13+ only; MariaDB refuses the CREATE TABLE.
    if (isMariaDb(target) && index.columns.some((c) => c.expression !== null)) {
      d.add('error', CODE.expressionIndexNotOnTarget, 'index', index.id, { target });
    }
    const kind = INDEX_KINDS.get(index.kind);
    if (kind === undefined) {
      d.add('error', CODE.indexKindUnknown, 'index', index.id, { kind: index.kind });
      continue;
    }
    if (index.isUnique && !kind.supportsUnique)
      d.add('error', CODE.indexUniqueUnsupported, 'index', index.id, { kind: kind.displayName });
    let bytes = 0;
    for (const column of index.columns) {
      if (column.fieldId === null) continue;
      const field = model.objects.field[column.fieldId];
      if (field === undefined) {
        d.add('error', CODE.columnMissing, 'index', index.id);
        continue;
      }
      const length =
        typeof column.engineProps.length === 'number' ? column.engineProps.length : undefined;
      if (
        index.kind === 'btree' &&
        PREFIX_ONLY_TYPE_IDS.has(typeId(field)) &&
        length === undefined
      ) {
        d.add('error', CODE.indexNeedsPrefix, 'index', index.id, {
          type: typeId(field).toUpperCase(),
          column: field.name,
        });
      }
      bytes += keyBytes(field, length);
    }
    if (index.kind === 'btree' && bytes > MAX_KEY_BYTES)
      d.add('warning', CODE.indexKeyTooLong, 'index', index.id, { bytes });
  }
}

const signature = (field: Field): string => {
  const id = typeId(field);
  const family = id === 'char' ? 'varchar' : id;
  const args = family === 'varchar' ? '' : JSON.stringify(field.type.args ?? []);
  return `${family}${args}${field.engineProps.unsigned === true ? ' unsigned' : ''}`;
};

function checkLinks(model: SchemaModel, d: Diagnostics): void {
  for (const link of Object.values(model.objects.link)) {
    const from = link.from.fieldIds.map((id) => model.objects.field[id]);
    const to = link.to.fieldIds.map((id) => model.objects.field[id]);
    if (
      model.objects.entity[link.from.entityId] === undefined ||
      model.objects.entity[link.to.entityId] === undefined
    ) {
      d.add('error', CODE.linkInvalid, 'link', link.id, {
        reason: 'a table it joins no longer exists',
      });
      continue;
    }
    if (from.some((f) => f === undefined) || to.some((f) => f === undefined)) {
      d.add('error', CODE.columnMissing, 'link', link.id);
      continue;
    }
    if (from.length !== to.length || from.length === 0) {
      d.add('error', CODE.linkInvalid, 'link', link.id, {
        reason: 'both sides need the same number of columns',
      });
      continue;
    }
    for (const [i, source] of from.entries()) {
      const target = to[i];
      if (source !== undefined && target !== undefined && signature(source) !== signature(target)) {
        d.add('error', CODE.linkTypeMismatch, 'link', link.id, {
          from: signature(source),
          to: signature(target),
        });
        break;
      }
    }
  }
}

function checkStaleReferences(model: SchemaModel, d: Diagnostics): void {
  const scan = (type: IrObjectType, objects: Record<Id, IrBase>) => {
    for (const object of Object.values(objects)) {
      const refs = object.refs;
      if (refs === undefined) continue;
      const missing =
        refs.entityIds.filter((id) => model.objects.entity[id] === undefined).length +
        refs.fieldIds.filter((id) => model.objects.field[id] === undefined).length;
      if (missing > 0)
        d.add('error', CODE.expressionReferenceStale, type, object.id, { count: missing });
    }
  };
  scan('entity', model.objects.entity);
  scan('field', model.objects.field);
  scan('index', model.objects.index);
  scan('constraint', model.objects.constraint);
}

function validate(input: ValidationInput): readonly Diagnostic[] {
  const scope = input.objectIds === undefined ? null : new Set(input.objectIds);
  const d = new Diagnostics((id) => scope === null || scope.has(id));
  const target = input.context.serverVersion ?? input.model.engineVersion;
  checkIdentifiers(input.model, d);
  checkDuplicateNames(input.model, d);
  checkFields(input.model, target, d);
  checkConstraints(input.model, d);
  checkIndexes(input.model, target, d);
  checkLinks(input.model, d);
  checkStaleReferences(input.model, d);
  return d.sorted();
}

export const VALIDATOR: MySqlValidator = { validate };
