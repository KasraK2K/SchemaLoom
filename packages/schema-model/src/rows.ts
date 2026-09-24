import type { ObjectRefs } from './base.js';
import type { Id } from './ids.js';

/**
 * The row shapes `assembleModel` consumes (§8.1).
 *
 * Plain structural types OWNED BY schema-model. The API layer maps Prisma rows onto them
 * — a field rename in most cases; schema-model never imports Prisma (C10).
 *
 * Timestamps are deliberately absent: row metadata is not schema (§1.3).
 */

/** The engine-owned bag as it comes off a JSON column, before assembly copies it. */
export type Props = Record<string, unknown>;

export interface AreaRow {
  id: Id;
  name: string;
  color: string;
  /** C11 legend order; becomes `Area.ordinal`. */
  position: number;
  version: number;
}

export interface NamespaceRow {
  id: Id;
  name: string;
  isDefault: boolean;
  engineProps: Props;
  refs: ObjectRefs;
  version: number;
}

export interface CustomTypeRow {
  id: Id;
  /** Nullable in the store; assembly resolves null to the default namespace (§8.1). */
  namespaceId: Id | null;
  name: string;
  kind: string;
  engineProps: Props;
  refs: ObjectRefs;
  version: number;
}

export interface EntityRow {
  id: Id;
  namespaceId: Id | null;
  areaId: Id | null;
  name: string;
  kind: string;
  positionX: number;
  positionY: number;
  width: number | null;
  height: number | null;
  color: string | null;
  engineProps: Props;
  refs: ObjectRefs;
  version: number;
}

export interface FieldRow {
  id: Id;
  entityId: Id;
  parentFieldId: Id | null;
  name: string;
  dataType: string;
  customTypeId: Id | null;
  /** `fields.type_args` — doc 02 delta D1. */
  typeArgs: readonly (string | number)[];
  /** `fields.type_dimensions` — doc 02 delta D1. */
  typeDimensions: number;
  /** C11 sibling order; becomes `Field.ordinal`. */
  position: number;
  isNullable: boolean;
  isRestricted: boolean;
  isPii: boolean;
  isDeprecated: boolean;
  engineProps: Props;
  /** `fields.refs` — doc 02 delta D4. */
  refs: ObjectRefs;
  version: number;
}

export interface ConstraintRow {
  id: Id;
  entityId: Id;
  /** Nullable: constraints are legitimately unnamed. Assembly maps null to "". */
  name: string | null;
  kind: string;
  /** A real column, copied into `engineProps.expression` by assembly (§2.9). */
  expression: string | null;
  engineProps: Props;
  refs: ObjectRefs;
  version: number;
}

export interface ConstraintColumnRow {
  constraintId: Id;
  ordinal: number;
  fieldId: Id;
}

export interface IndexRow {
  id: Id;
  entityId: Id;
  name: string;
  /** Access method; becomes `Index.kind`. */
  method: string;
  isUnique: boolean;
  engineProps: Props;
  refs: ObjectRefs;
  version: number;
}

export interface IndexColumnRow {
  indexId: Id;
  ordinal: number;
  fieldId: Id | null;
  expression: string | null;
  /** Free text in the store; anything but 'asc' / 'desc' assembles to no direction. */
  direction: string;
  /** `index_columns.is_include` — doc 02 delta D2. */
  isInclude: boolean;
  /** Per-column engine vocabulary: opclass, collation, NULLS order. */
  engineProps: Props;
}

export interface LinkRow {
  id: Id;
  name: string | null;
  kind: string;
  cardinality: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
  sourceEntityId: Id;
  targetEntityId: Id;
  engineProps: Props;
  refs: ObjectRefs;
  version: number;
}

/** ONE row carries BOTH field ids, which is what structurally guarantees
 *  `from.fieldIds.length === to.fieldIds.length` (§8.1). */
export interface LinkEndpointRow {
  linkId: Id;
  ordinal: number;
  sourceFieldId: Id;
  targetFieldId: Id;
}

export interface DocRow {
  id: Id;
  targetType: 'area' | 'entity' | 'field';
  targetId: Id;
  plainText: string | null;
}

export interface AssemblyRows {
  area: readonly AreaRow[];
  namespace: readonly NamespaceRow[];
  customType: readonly CustomTypeRow[];
  entity: readonly EntityRow[];
  field: readonly FieldRow[];
  constraint: readonly ConstraintRow[];
  constraintColumn: readonly ConstraintColumnRow[];
  index: readonly IndexRow[];
  indexColumn: readonly IndexColumnRow[];
  link: readonly LinkRow[];
  linkEndpoint: readonly LinkEndpointRow[];
  doc: readonly DocRow[];
}

export interface AssemblyInput {
  projectId: Id;
  /** Copied onto the model verbatim. An OPAQUE STRING here: nothing in this package
   *  resolves it, so assembly cannot branch on an engine even by accident (§8.1). */
  engineId: string;
  engineVersion: string;
  /** Plain rows, already scoped by projectId (C6) — one indexed query per table. */
  rows: AssemblyRows;
}
