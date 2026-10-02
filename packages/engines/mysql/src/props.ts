import {
  constantProps,
  type EnginePropsResolver,
  type EnginePropsSchemas,
} from '@schemaloom/engine-sdk';
import { z } from 'zod';
import { MAX_IDENTIFIER_LENGTH } from './normalize-name.js';

/**
 * `engineProps` for every MySQL object (design §3). Strict, so a typo'd key is a 422 rather
 * than a silently dropped setting. Expressions are SQL text, capped like PostgreSQL's.
 */

const expression = () => z.string().max(4000).optional();
const name = () => z.string().min(1).max(MAX_IDENTIFIER_LENGTH).optional();

const REFERENTIAL_ACTION = z.enum(['noAction', 'restrict', 'cascade', 'setNull', 'setDefault']);
export type ReferentialAction = z.infer<typeof REFERENTIAL_ACTION>;

const NO_PROPS = z.object({}).strict();

const TABLE_PROPS = z
  .object({
    /** `ENGINE=InnoDB` — kept and exported; only InnoDB is validated (design §9) */
    engine: name(),
    charset: name(),
    collation: name(),
    rowFormat: z
      .enum(['DEFAULT', 'DYNAMIC', 'FIXED', 'COMPRESSED', 'REDUNDANT', 'COMPACT'])
      .optional(),
  })
  .strict();

const VIEW_PROPS = z
  .object({
    /** the SELECT, as text */
    viewDefinition: expression(),
    algorithm: z.enum(['UNDEFINED', 'MERGE', 'TEMPTABLE']).optional(),
    sqlSecurity: z.enum(['DEFINER', 'INVOKER']).optional(),
    checkOption: z.enum(['LOCAL', 'CASCADED']).optional(),
  })
  .strict();

const FIELD_PROPS = z
  .object({
    unsigned: z.boolean().optional(),
    zerofill: z.boolean().optional(),
    autoIncrement: z.boolean().optional(),
    /** DEFAULT, as SQL text: `'active'`, `CURRENT_TIMESTAMP`, `(uuid())` */
    default: expression(),
    /** `ON UPDATE CURRENT_TIMESTAMP` */
    onUpdate: expression(),
    charset: name(),
    collation: name(),
    generatedExpression: expression(),
    generatedKind: z.enum(['VIRTUAL', 'STORED']).optional(),
    invisible: z.boolean().optional(),
    srid: z.number().int().nonnegative().optional(),
  })
  .strict();

const INDEX_PROPS = z
  .object({
    invisible: z.boolean().optional(),
  })
  .strict();

const INDEX_COLUMN_PROPS = z
  .object({
    /** a prefix length: `KEY (name(20))` */
    length: z.number().int().positive().max(3072).optional(),
  })
  .strict();

const CHECK_PROPS = z
  .object({
    expression: expression(),
    /** `NOT ENFORCED` (MySQL 8.0.16+) */
    notEnforced: z.boolean().optional(),
  })
  .strict();

const FOREIGN_KEY_PROPS = z
  .object({
    onDelete: REFERENTIAL_ACTION.optional(),
    onUpdate: REFERENTIAL_ACTION.optional(),
  })
  .strict();

const entityProps: EnginePropsResolver = (subKind) => {
  if (subKind === 'table') return TABLE_PROPS;
  if (subKind === 'view') return VIEW_PROPS;
  return NO_PROPS;
};

export const PROPS_SCHEMAS: EnginePropsSchemas = {
  namespace: constantProps(NO_PROPS),
  entity: entityProps,
  field: constantProps(FIELD_PROPS),
  link: (subKind) => (subKind === 'foreignKey' ? FOREIGN_KEY_PROPS : NO_PROPS),
  index: constantProps(INDEX_PROPS),
  indexColumn: constantProps(INDEX_COLUMN_PROPS),
  constraint: (subKind) => (subKind === 'check' ? CHECK_PROPS : NO_PROPS),
  customType: constantProps(NO_PROPS),
};
