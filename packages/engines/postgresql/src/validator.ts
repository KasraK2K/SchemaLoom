import {
  checkLink,
  sortDiagnostics,
  type Diagnostic,
  type DiagnosticSeverity,
  type EngineContext,
  type Id,
  type IrBase,
  type IrObjectType,
  type SchemaModel,
  type TypeResolutionContext,
} from '@schemaloom/engine-sdk';
import { CAPABILITIES, INCLUDE_CAPABLE_INDEX_KINDS } from './capabilities.js';
import { CODE } from './messages.js';
import { normalizeName, utf8ByteLength } from './normalize-name.js';
import { extractReferences } from './references.js';
import { postgresFacet } from './static.js';
import { IDENTITY_TYPE_IDS, TYPE_CATALOG } from './types.js';

/**
 * The engine validator (doc 03 §8). Synchronous and pure: no I/O, no clock, no mutation.
 * Engine rules only — identifier length and reserved words, illegal type/flag
 * combinations, unresolvable types, duplicate names inside a namespace, index and
 * constraint columns that no longer exist, link endpoints that survived `checkLink`, and
 * the one core cannot see for itself: an `engineProps` expression referencing an object
 * that has since been renamed or deleted.
 *
 * Permission rules and cross-project uniqueness are core concerns and stay out.
 *
 * It ALWAYS runs on the unredacted model (§8.3). A redacted model legitimately contains
 * blanked type names and stripped expressions, every one of which is an error here —
 * validating one would manufacture errors out of redaction itself. Core filters the
 * resulting diagnostics per recipient instead.
 *
 * The interface is declared locally because the SDK types `EngineDefinition.validator` as
 * `unknown` until build-order step 8 lands `EngineValidator`; the shape is §8's verbatim.
 */
export interface ValidationInput {
  /** Always the UNREDACTED model. */
  readonly model: SchemaModel;
  /** undefined = the whole model. On a write, core passes the touched ids plus their
   *  immediate dependants. */
  readonly objectIds?: readonly string[];
  readonly context: EngineContext;
}

export interface PostgresValidator {
  validate(input: ValidationInput): readonly Diagnostic[];
}

const RESERVED = new Set(CAPABILITIES.identifiers.reservedWords);
const INDEX_KINDS = new Map(CAPABILITIES.indexTypes.map((i) => [i.id, i]));
const MAX_BYTES = CAPABILITIES.identifiers.maxLength;

/** Object types whose name is required. A constraint or a link is often unnamed. */
const MUST_BE_NAMED: ReadonlySet<IrObjectType> = new Set<IrObjectType>([
  'namespace',
  'customType',
  'entity',
  'field',
]);

function text(props: Record<string, unknown>, key: string): string | undefined {
  const value = props[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pushId(map: Map<string, Id[]>, key: string, id: Id): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [id]);
  else existing.push(id);
}

class Diagnostics {
  private readonly out: Diagnostic[] = [];

  constructor(private readonly inScope: (id: Id) => boolean) {}

  add(
    severity: DiagnosticSeverity,
    code: string,
    type: IrObjectType,
    id: Id,
    params: Readonly<Record<string, string | number>> = {},
    propPath?: readonly string[],
  ): void {
    if (!this.inScope(id)) return;
    this.out.push({
      code,
      severity,
      params,
      target: propPath === undefined ? { type, id } : { type, id, propPath },
    });
  }

  sorted(): readonly Diagnostic[] {
    return sortDiagnostics(this.out);
  }
}

function checkIdentifiers(model: SchemaModel, diagnostics: Diagnostics): void {
  const named: { type: IrObjectType; object: IrBase }[] = [];
  for (const o of Object.values(model.objects.namespace))
    named.push({ type: 'namespace', object: o });
  for (const o of Object.values(model.objects.customType))
    named.push({ type: 'customType', object: o });
  for (const o of Object.values(model.objects.entity)) named.push({ type: 'entity', object: o });
  for (const o of Object.values(model.objects.field)) named.push({ type: 'field', object: o });
  for (const o of Object.values(model.objects.index)) named.push({ type: 'index', object: o });
  for (const o of Object.values(model.objects.constraint))
    named.push({ type: 'constraint', object: o });

  for (const { type, object } of named) {
    const { name } = object;
    if (name.length === 0) {
      if (MUST_BE_NAMED.has(type)) {
        diagnostics.add('error', CODE.identifierEmpty, type, object.id);
      }
      continue;
    }
    const bytes = utf8ByteLength(name);
    if (bytes > MAX_BYTES) {
      diagnostics.add('error', CODE.identifierTooLong, type, object.id, {
        name,
        bytes,
        truncated: normalizeName(name),
      });
    }
    if (RESERVED.has(normalizeName(name))) {
      diagnostics.add('warning', CODE.identifierReserved, type, object.id, { name });
    }
  }
}

/** Duplicates are compared FOLDED: `Orders` and `orders` are the same table. */
function checkDuplicateNames(model: SchemaModel, diagnostics: Diagnostics): void {
  const groups: { type: IrObjectType; keys: Map<string, Id[]>; names: Map<Id, string> }[] = [];

  const entityKeys = new Map<string, Id[]>();
  const entityNames = new Map<Id, string>();
  for (const entity of Object.values(model.objects.entity)) {
    if (entity.name.length === 0) continue;
    pushId(entityKeys, `${entity.namespaceId}\u0000${normalizeName(entity.name)}`, entity.id);
    entityNames.set(entity.id, entity.name);
  }
  groups.push({ type: 'entity', keys: entityKeys, names: entityNames });

  const fieldKeys = new Map<string, Id[]>();
  const fieldNames = new Map<Id, string>();
  for (const field of Object.values(model.objects.field)) {
    if (field.name.length === 0) continue;
    pushId(fieldKeys, `${field.entityId}\u0000${normalizeName(field.name)}`, field.id);
    fieldNames.set(field.id, field.name);
  }
  groups.push({ type: 'field', keys: fieldKeys, names: fieldNames });

  const typeKeys = new Map<string, Id[]>();
  const typeNames = new Map<Id, string>();
  for (const customType of Object.values(model.objects.customType)) {
    if (customType.name.length === 0) continue;
    pushId(
      typeKeys,
      `${customType.namespaceId}\u0000${normalizeName(customType.name)}`,
      customType.id,
    );
    typeNames.set(customType.id, customType.name);
  }
  groups.push({ type: 'customType', keys: typeKeys, names: typeNames });

  // PostgreSQL names indexes and constraints per SCHEMA; the store only enforces per table
  // (migration 20261002120000), so the wider rule is this diagnostic.
  const namespaceOf = (entityId: Id) => model.objects.entity[entityId]?.namespaceId ?? '';
  const scoped: readonly [
    IrObjectType,
    readonly { id: Id; entityId: Id; name: string | null }[],
  ][] = [
    ['index', Object.values(model.objects.index)],
    ['constraint', Object.values(model.objects.constraint)],
  ];
  for (const [type, objects] of scoped) {
    const keys = new Map<string, Id[]>();
    const names = new Map<Id, string>();
    for (const object of objects) {
      if (object.name === null || object.name.length === 0) continue;
      pushId(keys, `${namespaceOf(object.entityId)}\u0000${normalizeName(object.name)}`, object.id);
      names.set(object.id, object.name);
    }
    groups.push({ type, keys, names });
  }

  for (const { type, keys, names } of groups) {
    for (const ids of keys.values()) {
      if (ids.length < 2) continue;
      for (const id of ids) {
        diagnostics.add('error', CODE.duplicateName, type, id, { name: names.get(id) ?? '' });
      }
    }
  }
}

function checkFields(model: SchemaModel, diagnostics: Diagnostics): void {
  const customTypes = Object.values(model.objects.customType);
  const contexts = new Map<Id, TypeResolutionContext>();
  const contextFor = (entityId: Id): TypeResolutionContext => {
    const cached = contexts.get(entityId);
    if (cached !== undefined) return cached;
    const entity = model.objects.entity[entityId];
    const namespace =
      entity === undefined ? undefined : model.objects.namespace[entity.namespaceId];
    const context: TypeResolutionContext = { customTypes, namespaceName: namespace?.name ?? null };
    contexts.set(entityId, context);
    return context;
  };

  for (const field of Object.values(model.objects.field)) {
    const resolved = TYPE_CATALOG.resolve(field.type, contextFor(field.entityId));

    if (resolved.status === 'unknown') {
      const dangling = field.type.customTypeId !== undefined && field.type.customTypeId !== null;
      diagnostics.add(
        'error',
        dangling ? CODE.customTypeDangling : CODE.typeUnknown,
        'field',
        field.id,
        { type: field.type.name },
      );
    }

    const props = field.engineProps;
    const identity = text(props, 'identity');
    const generated = text(props, 'generatedExpression');
    const hasDefault = text(props, 'default') !== undefined;

    if (identity !== undefined) {
      const isInteger =
        resolved.status === 'builtin' &&
        resolved.descriptor !== null &&
        IDENTITY_TYPE_IDS.has(resolved.descriptor.id);
      if (!isInteger && resolved.status !== 'unknown') {
        diagnostics.add(
          'error',
          CODE.identityNonInteger,
          'field',
          field.id,
          { type: resolved.display },
          ['identity'],
        );
      }
      if (hasDefault) {
        diagnostics.add('error', CODE.identityWithDefault, 'field', field.id, {}, ['identity']);
      }
    }

    if (generated !== undefined) {
      if (hasDefault) {
        diagnostics.add('error', CODE.generatedWithDefault, 'field', field.id, {}, [
          'generatedExpression',
        ]);
      }
      for (const ref of extractReferences(field, null, model)) {
        if (ref.type !== 'field' || ref.id === field.id) continue;
        const other = model.objects.field[ref.id];
        if (other !== undefined && text(other.engineProps, 'generatedExpression') !== undefined) {
          diagnostics.add('error', CODE.generatedReferencesGenerated, 'field', field.id, {}, [
            'generatedExpression',
          ]);
          break;
        }
      }
    }
  }
}

function checkConstraints(model: SchemaModel, diagnostics: Diagnostics): void {
  for (const constraint of Object.values(model.objects.constraint)) {
    const descriptor = CAPABILITIES.constraintKinds.find((k) => k.id === constraint.kind);
    if (
      descriptor?.hasExpression === true &&
      text(constraint.engineProps, 'expression') === undefined
    ) {
      diagnostics.add(
        'error',
        CODE.constraintMissingExpression,
        'constraint',
        constraint.id,
        { kind: constraint.kind },
        ['expression'],
      );
    }
    for (const fieldId of constraint.fieldIds) {
      if (model.objects.field[fieldId] === undefined) {
        diagnostics.add('error', CODE.columnMissing, 'constraint', constraint.id);
        break;
      }
    }
  }
}

function checkIndexes(model: SchemaModel, diagnostics: Diagnostics): void {
  for (const index of Object.values(model.objects.index)) {
    const descriptor = INDEX_KINDS.get(index.kind);
    if (descriptor === undefined) {
      diagnostics.add('error', CODE.indexKindUnknown, 'index', index.id, { kind: index.kind });
    } else if (index.isUnique && !descriptor.supportsUnique) {
      diagnostics.add('error', CODE.indexUniqueUnsupported, 'index', index.id, {
        kind: descriptor.displayName,
      });
    }

    if (
      index.columns.some((c) => c.role === 'include') &&
      !INCLUDE_CAPABLE_INDEX_KINDS.has(index.kind)
    ) {
      diagnostics.add('error', CODE.indexIncludeUnsupported, 'index', index.id, {
        kind: descriptor?.displayName ?? index.kind,
      });
    }

    for (const column of index.columns) {
      if (column.fieldId !== null && model.objects.field[column.fieldId] === undefined) {
        diagnostics.add('error', CODE.columnMissing, 'index', index.id);
        break;
      }
    }
  }
}

function checkCustomTypes(model: SchemaModel, diagnostics: Diagnostics): void {
  for (const customType of Object.values(model.objects.customType)) {
    if (customType.kind !== 'enum') continue;
    const labels = customType.engineProps.labels;
    if (!Array.isArray(labels) || labels.length === 0) {
      diagnostics.add('error', CODE.enumNoLabels, 'customType', customType.id, {}, ['labels']);
    }
  }
}

function checkLinks(model: SchemaModel, diagnostics: Diagnostics): void {
  for (const link of Object.values(model.objects.link)) {
    const result = checkLink({
      engine: postgresFacet,
      model,
      linkKindId: link.kind,
      source: link.from,
      target: link.to,
    });
    if (result.ok) continue;
    diagnostics.add('error', CODE.linkInvalid, 'link', link.id, {
      reason: result.reasons[0]?.code ?? 'link.kindNotAllowed',
    });
  }
}

/**
 * The staleness half of §3.1 rule 3: `refs` was computed by `extractReferences` when the
 * expression was written; anything in it that is no longer in the model means the
 * expression now names something that does not exist.
 */
function checkStaleReferences(model: SchemaModel, diagnostics: Diagnostics): void {
  const scan = (type: IrObjectType, objects: Record<Id, IrBase>): void => {
    for (const object of Object.values(objects)) {
      const refs = object.refs;
      if (refs === undefined) continue;
      let missing = 0;
      for (const entityId of refs.entityIds) {
        if (model.objects.entity[entityId] === undefined) missing += 1;
      }
      for (const fieldId of refs.fieldIds) {
        if (model.objects.field[fieldId] === undefined) missing += 1;
      }
      if (missing > 0) {
        diagnostics.add('error', CODE.expressionReferenceStale, type, object.id, {
          count: missing,
        });
      }
    }
  };
  scan('entity', model.objects.entity);
  scan('field', model.objects.field);
  scan('index', model.objects.index);
  scan('constraint', model.objects.constraint);
  scan('customType', model.objects.customType);
}

function validate(input: ValidationInput): readonly Diagnostic[] {
  const { model, objectIds } = input;
  const scope = objectIds === undefined ? null : new Set(objectIds);
  // ponytail: scoped runs still walk the whole model and filter on emit. The per-object
  // work is a map lookup; the expensive parts (type resolution, expression scanning) are
  // already bounded by the model. Push the scope down into the loops if a 20k-object
  // project makes a write feel slow.
  const diagnostics = new Diagnostics((id) => scope === null || scope.has(id));

  checkIdentifiers(model, diagnostics);
  checkDuplicateNames(model, diagnostics);
  checkFields(model, diagnostics);
  checkConstraints(model, diagnostics);
  checkIndexes(model, diagnostics);
  checkCustomTypes(model, diagnostics);
  checkLinks(model, diagnostics);
  checkStaleReferences(model, diagnostics);

  return diagnostics.sorted();
}

export const VALIDATOR: PostgresValidator = { validate };
