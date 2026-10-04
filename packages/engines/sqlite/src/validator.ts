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
import { CAPABILITIES } from './capabilities.js';
import { CODE } from './messages.js';
import { normalizeName } from './normalize-name.js';
import { STRICT_TYPES, TYPE_CATALOG } from './types.js';

/**
 * SQLite's rules (Phase 13 §4), as diagnostics on the UNREDACTED model. Advisory like every
 * validator: core shows them, nothing blocks a write on them. SQLite accepts any type name, so
 * an unknown one is not an error here — only a STRICT table restricts types.
 */

export interface ValidationInput {
  readonly model: SchemaModel;
  /** undefined = the whole model */
  readonly objectIds?: readonly string[];
  readonly context: EngineContext;
}

export interface SqliteValidator {
  validate(input: ValidationInput): readonly Diagnostic[];
}

const RESERVED = new Set(CAPABILITIES.identifiers.reservedWords);
const INDEX_KINDS = new Set(CAPABILITIES.indexTypes.map((i) => i.id));

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

const display = (field: Field): string =>
  TYPE_CATALOG.format(TYPE_CATALOG.resolve(field.type, { customTypes: [], namespaceName: null }));

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
      true,
    ]),
  ];
  for (const [type, object, required] of named) {
    if (object.name === '') {
      if (required) d.add('error', CODE.identifierEmpty, type, object.id);
      continue;
    }
    if (RESERVED.has(normalizeName(object.name))) {
      d.add('warning', CODE.identifierReserved, type, object.id, { name: object.name });
    }
  }
}

/** Tables, views and indexes share one name space per database; columns are per table. */
function checkDuplicateNames(model: SchemaModel, d: Diagnostics): void {
  const report = (members: readonly [IrObjectType, Id, string][]) => {
    const byKey = new Map<string, [IrObjectType, Id, string][]>();
    for (const m of members) {
      if (m[2] === '') continue;
      const key = normalizeName(m[2]);
      byKey.set(key, [...(byKey.get(key) ?? []), m]);
    }
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      for (const [type, id, name] of group) d.add('error', CODE.duplicateName, type, id, { name });
    }
  };
  report([
    ...Object.values(model.objects.entity).map((e): [IrObjectType, Id, string] => [
      'entity',
      e.id,
      e.name,
    ]),
    ...Object.values(model.objects.index).map((i): [IrObjectType, Id, string] => [
      'index',
      i.id,
      i.name,
    ]),
  ]);
  const byTable = new Map<Id, [IrObjectType, Id, string][]>();
  for (const f of Object.values(model.objects.field)) {
    byTable.set(f.entityId, [...(byTable.get(f.entityId) ?? []), ['field', f.id, f.name]]);
  }
  for (const members of byTable.values()) report(members);
}

function checkFields(model: SchemaModel, d: Diagnostics): void {
  const primaryKeys = Object.values(model.objects.constraint).filter(
    (c) => c.kind === 'primaryKey',
  );
  for (const field of Object.values(model.objects.field)) {
    const table = model.objects.entity[field.entityId];
    const props = field.engineProps;
    if (table?.engineProps.strict === true && !STRICT_TYPES.has(display(field).toLowerCase())) {
      d.add('error', CODE.typeNotStrict, 'field', field.id, { type: display(field) });
    }
    if (props.autoIncrement === true) {
      const pk = primaryKeys.find((c) => c.entityId === field.entityId);
      const isRowid =
        pk?.fieldIds.length === 1 &&
        pk.fieldIds[0] === field.id &&
        display(field).toLowerCase() === 'integer';
      if (!isRowid) d.add('error', CODE.autoIncrementNotKey, 'field', field.id);
    }
    if (typeof props.generatedExpression === 'string' && typeof props.default === 'string') {
      d.add('error', CODE.generatedWithDefault, 'field', field.id);
    }
  }
}

function checkConstraints(model: SchemaModel, d: Diagnostics): void {
  for (const c of Object.values(model.objects.constraint)) {
    if (c.kind === 'check' && typeof c.engineProps.expression !== 'string') {
      d.add('error', CODE.constraintMissingExpression, 'constraint', c.id);
    }
    if (c.fieldIds.some((id) => model.objects.field[id] === undefined)) {
      d.add('error', CODE.columnMissing, 'constraint', c.id);
    }
  }
}

function checkIndexes(model: SchemaModel, d: Diagnostics): void {
  for (const index of Object.values(model.objects.index)) {
    if (!INDEX_KINDS.has(index.kind)) {
      d.add('error', CODE.indexKindUnknown, 'index', index.id, { kind: index.kind });
    }
    if (
      index.columns.some((c) => c.fieldId !== null && model.objects.field[c.fieldId] === undefined)
    ) {
      d.add('error', CODE.columnMissing, 'index', index.id);
    }
  }
}

function checkLinks(model: SchemaModel, d: Diagnostics): void {
  for (const link of Object.values(model.objects.link)) {
    if (
      model.objects.entity[link.from.entityId] === undefined ||
      model.objects.entity[link.to.entityId] === undefined
    ) {
      d.add('error', CODE.linkInvalid, 'link', link.id, {
        reason: 'a table it joins no longer exists',
      });
      continue;
    }
    if (
      [...link.from.fieldIds, ...link.to.fieldIds].some(
        (id) => model.objects.field[id] === undefined,
      )
    ) {
      d.add('error', CODE.columnMissing, 'link', link.id);
      continue;
    }
    if (link.from.fieldIds.length !== link.to.fieldIds.length || link.from.fieldIds.length === 0) {
      d.add('error', CODE.linkInvalid, 'link', link.id, {
        reason: 'both sides need the same number of columns',
      });
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
  checkIdentifiers(input.model, d);
  checkDuplicateNames(input.model, d);
  checkFields(input.model, d);
  checkConstraints(input.model, d);
  checkIndexes(input.model, d);
  checkLinks(input.model, d);
  checkStaleReferences(input.model, d);
  return d.sorted();
}

export const VALIDATOR: SqliteValidator = { validate };
