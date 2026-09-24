import { z } from 'zod';
import { AreaSchema, type Area } from './area.js';
import { ConstraintSchema, type Constraint } from './constraint.js';
import { CustomTypeSchema, type CustomType } from './custom-type.js';
import { EntitySchema, type Entity } from './entity.js';
import { FieldSchema, type Field } from './field.js';
import { IdSchema, type Id } from './ids.js';
import { IndexSchema, type Index } from './ir-index.js';
import { LinkSchema, type Link } from './link.js';
import { NamespaceSchema, type Namespace } from './namespace.js';

/**
 * Collections are keyed by the SINGULAR object-type name (§1.3):
 * `model.objects.entity[id]`, not `model.objects.entities[id]`. Not a typo — it lets
 * every generic routine (diff, validation, redaction, index build) be written once over
 * `IrObjectType` with full type safety and no plural-mapping table. `index` has no
 * regular plural, which would otherwise force a hand-maintained `PLURAL` const and a
 * cast in every generic function.
 */
export interface IrObjectMap {
  namespace: Namespace;
  entity: Entity;
  field: Field;
  link: Link;
  index: Index;
  constraint: Constraint;
  customType: CustomType;
  area: Area;
}

export type IrObjectType = keyof IrObjectMap;
export type IrObject = IrObjectMap[IrObjectType];

/**
 * Stable iteration, diff, apply and export ordering rank. Do not reorder: this is the
 * dependency order (a field needs its entity, a link needs both entities). Used by
 * `sortPath` (§7.5) and by the server's op sort (§8.6 rule 7).
 */
export const IR_OBJECT_TYPES = [
  'area',
  'namespace',
  'customType',
  'entity',
  'field',
  'constraint',
  'index',
  'link',
] as const satisfies readonly IrObjectType[];

export type IrCollections = {
  [K in IrObjectType]: Record<Id, IrObjectMap[K]>;
};

/**
 * The root (§1.1): normalized maps keyed by id, one map per object type, with parent
 * links expressed as id references and ordering expressed as an explicit `ordinal`
 * (C11). No nesting anywhere in the persisted or transported shape.
 *
 * JSON-safe values only — no `Date` objects — so a snapshot blob and a websocket frame
 * are the same bytes.
 *
 * There is no `createdAt` / `updatedAt` on IR objects: row metadata is not schema, and
 * carrying it would make every diff report noise. `version` IS carried, because the
 * client needs it to send `expectedVersion` on the next write (C7).
 */
export const SchemaModelSchema = z.object({
  /** Bumped only when the *shape* of these types changes. Snapshots live forever, so a
   *  loader must be able to say "this blob is irVersion 1, upgrade it". */
  irVersion: z.literal(1),
  projectId: IdSchema,
  /** "postgresql" — resolved through the EngineRegistry, never imported (C10). */
  engineId: z.string().min(1),
  /** "16" — the target database version, not the plugin version. */
  engineVersion: z.string(),
  /** True when this model came out of `VisibilityFilter` (§10). Clients must not offer
   *  edit, export or snapshot affordances when it is set; the server re-checks anyway.
   *  `opsFromDiff` refuses to run on a diff involving one (§8.8). */
  redacted: z.boolean(),
  objects: z.object({
    area: z.record(IdSchema, AreaSchema),
    namespace: z.record(IdSchema, NamespaceSchema),
    customType: z.record(IdSchema, CustomTypeSchema),
    entity: z.record(IdSchema, EntitySchema),
    field: z.record(IdSchema, FieldSchema),
    constraint: z.record(IdSchema, ConstraintSchema),
    index: z.record(IdSchema, IndexSchema),
    link: z.record(IdSchema, LinkSchema),
  }),
});

export type SchemaModel = z.infer<typeof SchemaModelSchema>;

/** Every IR object schema, keyed the same way as `IrCollections`. Lets generic routines
 *  parse one object of a statically-unknown type without an eight-arm switch. */
export const IR_OBJECT_SCHEMAS = {
  area: AreaSchema,
  namespace: NamespaceSchema,
  customType: CustomTypeSchema,
  entity: EntitySchema,
  field: FieldSchema,
  constraint: ConstraintSchema,
  index: IndexSchema,
  link: LinkSchema,
} as const satisfies { [K in IrObjectType]: z.ZodType<IrObjectMap[K]> };

/** An empty model. Every consumer that builds one incrementally starts here rather than
 *  spelling out eight empty records. */
export function emptyCollections(): IrCollections {
  return {
    area: {},
    namespace: {},
    customType: {},
    entity: {},
    field: {},
    constraint: {},
    index: {},
    link: {},
  };
}
