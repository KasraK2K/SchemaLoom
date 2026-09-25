/**
 * The ONLY file in engine-sdk that names a `@schemaloom/schema-model` export (doc 03 §2.1).
 * Everything else in this package imports IR types from here, so the coupling point is one
 * file and C10 is checkable by reading it.
 *
 * Doc 03 §2.1 also lists `RestrictionMark`, the diff types (`SchemaDiff`, `DiffEntry`,
 * `PropertyChange`, `PropertySeverity`, `IrPatch`) and the single-path types
 * (`RedactedModel`, `RawSchemaModel`, `VisibilityContext`). They are NOT re-exported here:
 *   - `RestrictionMark` was deleted by RECONCILIATION R-1 — `IrBase` carries `restricted?: true`
 *     and `propsRedacted?: true` as two independent flags and there is no `level`.
 *   - the diff types land in schema-model at build-order step 18. This file grows one line
 *     then; nothing here depends on them.
 *
 * `RedactedModel` IS re-exported (step 12 landed it): §17's `ConformanceFixtures.redactedModel`
 * is typed with it, and the phantom brand is the point — a fixture typed `RedactedModel` cannot
 * be a hand-written imitation of a redacted model, only the real output of `redact`.
 * `RawSchemaModel` and `VisibilityContext` stay out: nothing in this package produces one.
 */
export type {
  Area,
  Cardinality,
  Constraint,
  CustomType,
  DocRef,
  EngineProps,
  Entity,
  Field,
  Id,
  Index,
  IndexColumn,
  IrBase,
  IrObject,
  IrObjectType,
  Link,
  LinkEndpoint,
  Namespace,
  ObjectRefs,
  RedactedModel,
  SchemaModel,
  TypeRef,
} from '@schemaloom/schema-model';

export { IR_OBJECT_TYPES, MAX_FIELD_DEPTH } from '@schemaloom/schema-model';

import type { Id, IrObjectType } from '@schemaloom/schema-model';

/** A pointer to any IR object. schema-model has no such type; it is tiny and appears in half
 *  the engine-sdk signatures, so it is defined here. */
export interface IrObjectRef {
  readonly type: IrObjectType;
  /** cuid, identical to the database row id (C1) */
  readonly id: Id;
}

/**
 * Kind values are engine-defined OPEN sets. Core types them `string` — the moment core writes
 * `kind === 'table'` the engine boundary is gone — and an engine narrows its own with a type
 * guard. The intersection keeps editor autocomplete for the known members without closing the
 * set. (`Record<never, never>` rather than `{}`: same type, and it does not trip
 * `@typescript-eslint/no-empty-object-type`.)
 */
export type OpenKind<Known extends string = never> = Known | (string & Record<never, never>);

export type EntityKind = OpenKind;
export type LinkKind = OpenKind;
export type IndexKind = OpenKind;
export type ConstraintKind = OpenKind;
export type CustomTypeKind = OpenKind;
