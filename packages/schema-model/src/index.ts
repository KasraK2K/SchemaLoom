/**
 * @schemaloom/schema-model — the engine-neutral IR.
 *
 * C10: this package depends on NOTHING but zod. No HTTP shapes, no React, no Prisma,
 * no engine imports. Everything here is domain.
 *
 * Every IR type is written ONCE, as a zod schema, and the TypeScript type is inferred
 * from it (§5). Nothing here declares an IR type twice. Naming: schema is `FooSchema`,
 * type is `Foo`.
 *
 * Where parsing happens: at trust boundaries only — API request bodies, snapshot load,
 * import results, engine conformance tests. Assembly from our own rows and internal
 * transforms do NOT re-parse.
 *
 * Phase 1 build order: step 5 added the object types and their zod schemas, step 6
 * (here) adds assembly, traversal and structural validation, step 12 adds redaction,
 * step 18 adds the diff.
 */
export { MAX_FIELD_DEPTH, MAX_FIELD_DEPTH_CTE_GUARD } from './constants.js';

export { IdSchema, type Id } from './ids.js';

export {
  EnginePropsSchema,
  IrBaseSchema,
  IrBaseShape,
  ObjectRefsSchema,
  type EngineProps,
  type IrBase,
  type ObjectRefs,
} from './base.js';

export { DOC_EXCERPT_CHARS, DocRefSchema, type DocRef } from './doc-ref.js';
export { TypeRefSchema, type TypeRef } from './type-ref.js';

export { AreaSchema, type Area } from './area.js';
export { NamespaceSchema, type Namespace } from './namespace.js';
export { CustomTypeSchema, type CustomType } from './custom-type.js';
export { EntitySchema, PointSchema, type Entity, type Point } from './entity.js';
export { FieldSchema, type Field, type FieldNamePath, type FieldPath } from './field.js';
export { ConstraintSchema, type Constraint } from './constraint.js';
export { IndexColumnSchema, IndexSchema, type Index, type IndexColumn } from './ir-index.js';
export {
  LinkEndpointSchema,
  LinkSchema,
  type Cardinality,
  type Link,
  type LinkEndpoint,
} from './link.js';

export {
  IR_OBJECT_SCHEMAS,
  IR_OBJECT_TYPES,
  SchemaModelSchema,
  emptyCollections,
  type IrCollections,
  type IrObject,
  type IrObjectMap,
  type IrObjectType,
  type SchemaModel,
} from './model.js';

export { identityNormalizeName, type MatchStrategy, type NormalizeName } from './normalize-name.js';

export { byLogicalKey, logicalKey } from './logical-key.js';

export type {
  AreaRow,
  AssemblyInput,
  AssemblyRows,
  ConstraintColumnRow,
  ConstraintRow,
  CustomTypeRow,
  DocRow,
  EntityRow,
  FieldRow,
  IndexColumnRow,
  IndexRow,
  LinkEndpointRow,
  LinkRow,
  NamespaceRow,
  Props,
} from './rows.js';
export { assembleModel } from './assemble.js';

export {
  createIndex,
  indexOf,
  type IndexOptions,
  type JoinPath,
  type JoinPathCacheEntry,
  type JoinStep,
  type ModelIndex,
  type TopologicalOrder,
} from './model-index.js';

export {
  CONSTRAINT_KIND_PRIMARY_KEY,
  CONSTRAINT_KIND_UNIQUE,
  constraintsOf,
  entitiesOf,
  entitiesOfArea,
  fieldDepth,
  fieldNamePath,
  fieldPath,
  fieldsOf,
  findEntityByName,
  get,
  getEntity,
  indexesOf,
  isForeignKeyField,
  isPrimaryKey,
  isUniqueField,
  primaryKeyFields,
  resolveNamePath,
} from './traverse.js';

export {
  joinPaths,
  linksOf,
  linksTouchingField,
  neighbours,
  topologicalEntityOrder,
} from './graph.js';

export { validateModel, type ValidateOptions, type ValidationIssue } from './validate.js';

export {
  RedactedDiffError,
  deepDiff,
  destructiveEntries,
  diffModels,
  entriesByEntity,
  entriesOfType,
  isCosmeticOnly,
  isEmptyDiff,
  nameSimilarity,
  opsFromDiff,
  renameCandidates,
  type EntityRenameCandidate,
  type FieldRenameCandidate,
  type RenameCandidate,
  type RenameCandidateOptions,
  type ChangeType,
  type DiffCounts,
  type DiffEntry,
  type DiffEntryOf,
  type DiffOptions,
  type PinnedRename,
  type PropertyChange,
  type PropertySeverity,
  type RestoreOp,
  type SchemaDiff,
  type SnapshotRef,
} from './diff/index.js';

export {
  RawSchemaModel,
  fieldVisibility,
  fieldVisibilityIndex,
  redact,
  redactPatch,
  type ModelPatch,
  type FieldVisibility,
  type FieldVisibilityIndex,
  type RedactedModel,
  type RestrictedFieldMode,
  type VisibilityContext,
} from './redact/index.js';
