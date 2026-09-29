import { z } from 'zod';
import {
  constantProps,
  type EnginePropsResolver,
  type EnginePropsSchemas,
} from '@schemaloom/engine-sdk';

/**
 * `engineProps` schemas (doc 03 §6). Everything PostgreSQL knows and core does not lives
 * here, and every schema is `.strict()` — an unknown key is a 422, not a pass-through,
 * because JSONB with silently accepted junk is unrecoverable a year later.
 *
 * Zod and nothing else, so this module loads in the browser and react-hook-form validates
 * a property panel without a round trip.
 *
 * NOT here, deliberately: rules that span two properties or need the model — identity on
 * a non-integer column, a generated column referencing another generated column, a CHECK
 * with an empty body. A props failure BLOCKS the write; a validator error does not, and a
 * half-filled constraint mid-edit is a normal state. Those rules live in `validator.ts`.
 */

const NO_PROPS = z.object({}).strict();

/** Expression bodies are capped at the same 4000 characters as `IndexColumn.expression`. */
const expression = (): z.ZodOptional<z.ZodString> => z.string().max(4000).optional();

/** An identifier PostgreSQL will hold: 63 bytes, which is at most 63 characters. */
const identifier = (): z.ZodOptional<z.ZodString> => z.string().max(63).optional();

const REFERENTIAL_ACTION = z.enum(['noAction', 'restrict', 'cascade', 'setNull', 'setDefault']);

export type ReferentialAction = z.infer<typeof REFERENTIAL_ACTION>;

// --- namespace ---

const NAMESPACE_PROPS = z.object({ owner: identifier() }).strict();

// --- entity ---

const TABLE_PROPS = z
  .object({
    unlogged: z.boolean().optional(),
    tablespace: identifier(),
    partitionBy: z
      .object({
        strategy: z.enum(['range', 'list', 'hash']),
        /** the partition key: a column list or an expression, engine syntax */
        expression: z.string().min(1).max(4000),
      })
      .strict()
      .optional(),
    fillfactor: z.number().int().min(10).max(100).optional(),
    rowLevelSecurity: z.boolean().optional(),
  })
  .strict();

const VIEW_PROPS = z
  .object({
    /** the SELECT body; names other tables and columns, so `extractReferences` reads it */
    viewDefinition: expression(),
    checkOption: z.enum(['local', 'cascaded']).optional(),
  })
  .strict();

const MATERIALIZED_VIEW_PROPS = z
  .object({
    viewDefinition: expression(),
    tablespace: identifier(),
    withData: z.boolean().optional(),
  })
  .strict();

// --- field ---

const FIELD_PROPS = z
  .object({
    /** DEFAULT expression, engine syntax — core never parses it (doc 04 §2.6) */
    default: expression(),
    identity: z.enum(['always', 'byDefault']).optional(),
    generatedExpression: expression(),
    collation: identifier(),
    storage: z.enum(['plain', 'external', 'extended', 'main']).optional(),
    compression: z.enum(['pglz', 'lz4']).optional(),
  })
  .strict();

// --- link ---

const FOREIGN_KEY_PROPS = z
  .object({
    onDelete: REFERENTIAL_ACTION.optional(),
    onUpdate: REFERENTIAL_ACTION.optional(),
    deferrable: z.boolean().optional(),
    initiallyDeferred: z.boolean().optional(),
    matchFull: z.boolean().optional(),
  })
  .strict();

// --- index ---

const INDEX_PROPS = z
  .object({
    /** partial-index predicate */
    where: expression(),
    tablespace: identifier(),
    fillfactor: z.number().int().min(10).max(100).optional(),
    concurrently: z.boolean().optional(),
    nullsNotDistinct: z.boolean().optional(),
  })
  .strict();

/** `opclass` is per COLUMN in PostgreSQL (`CREATE INDEX … (a jsonb_path_ops, b)`), so it
 *  lives on the index column and not on the index. Same for the collation and the null
 *  ordering. Putting them on the index would be one truth in two places. */
const INDEX_COLUMN_PROPS = z
  .object({
    opclass: identifier(),
    collation: identifier(),
    nullsOrder: z.enum(['first', 'last']).optional(),
  })
  .strict();

// --- constraint ---

const KEY_CONSTRAINT_PROPS = z
  .object({
    deferrable: z.boolean().optional(),
    initiallyDeferred: z.boolean().optional(),
    usingIndex: identifier(),
  })
  .strict();

const UNIQUE_CONSTRAINT_PROPS = KEY_CONSTRAINT_PROPS.extend({
  nullsNotDistinct: z.boolean().optional(),
}).strict();

const CHECK_CONSTRAINT_PROPS = z
  .object({
    expression: expression(),
    noInherit: z.boolean().optional(),
  })
  .strict();

const EXCLUSION_CONSTRAINT_PROPS = z
  .object({
    expression: expression(),
    /** the index access method backing the constraint, normally `gist` */
    using: identifier(),
    deferrable: z.boolean().optional(),
    initiallyDeferred: z.boolean().optional(),
  })
  .strict();

// --- customType: the payload varies entirely by kind ---

const ENUM_PROPS = z
  .object({
    /** ordered — PostgreSQL compares enum values by declaration order */
    labels: z.array(z.string().min(1).max(63)).max(1000).optional(),
  })
  .strict();

const DOMAIN_PROPS = z
  .object({
    baseType: z.string().min(1).max(255).optional(),
    notNull: z.boolean().optional(),
    default: expression(),
    /** CHECK bodies, engine syntax */
    checks: z.array(z.string().max(4000)).max(100).optional(),
  })
  .strict();

const COMPOSITE_PROPS = z
  .object({
    attributes: z
      .array(
        z
          .object({
            name: z.string().min(1).max(63),
            type: z.string().min(1).max(255),
            collation: identifier(),
          })
          .strict(),
      )
      .max(1600)
      .optional(),
  })
  .strict();

const entityProps: EnginePropsResolver = (subKind) => {
  if (subKind === 'table') return TABLE_PROPS;
  if (subKind === 'view') return VIEW_PROPS;
  if (subKind === 'materializedView') return MATERIALIZED_VIEW_PROPS;
  return NO_PROPS;
};

const constraintProps: EnginePropsResolver = (subKind) => {
  if (subKind === 'primaryKey') return KEY_CONSTRAINT_PROPS;
  if (subKind === 'unique') return UNIQUE_CONSTRAINT_PROPS;
  if (subKind === 'check') return CHECK_CONSTRAINT_PROPS;
  if (subKind === 'exclusion') return EXCLUSION_CONSTRAINT_PROPS;
  return NO_PROPS;
};

const customTypeProps: EnginePropsResolver = (subKind) => {
  if (subKind === 'enum') return ENUM_PROPS;
  if (subKind === 'domain') return DOMAIN_PROPS;
  if (subKind === 'composite') return COMPOSITE_PROPS;
  return NO_PROPS;
};

export const PROPS_SCHEMAS: EnginePropsSchemas = {
  namespace: constantProps(NAMESPACE_PROPS),
  entity: entityProps,
  field: constantProps(FIELD_PROPS),
  link: (subKind) => (subKind === 'foreignKey' ? FOREIGN_KEY_PROPS : NO_PROPS),
  index: constantProps(INDEX_PROPS),
  indexColumn: constantProps(INDEX_COLUMN_PROPS),
  constraint: constraintProps,
  customType: customTypeProps,
};
