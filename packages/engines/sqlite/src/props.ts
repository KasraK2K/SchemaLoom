import {
  constantProps,
  type EnginePropsResolver,
  type EnginePropsSchemas,
} from '@schemaloom/engine-sdk';
import { z } from 'zod';

/**
 * `engineProps` for every SQLite object (Phase 13 §3). Strict, so a typo'd key is a 422
 * rather than a silently dropped setting. Expressions are SQL text, capped like the other
 * engines'.
 */

const expression = () => z.string().max(4000).optional();
const name = () => z.string().min(1).max(255).optional();

const REFERENTIAL_ACTION = z.enum(['noAction', 'restrict', 'cascade', 'setNull', 'setDefault']);
export type ReferentialAction = z.infer<typeof REFERENTIAL_ACTION>;

const NO_PROPS = z.object({}).strict();

const TABLE_PROPS = z
  .object({
    /** `WITHOUT ROWID` */
    withoutRowid: z.boolean().optional(),
    /** `STRICT`: only INT, INTEGER, REAL, TEXT, BLOB and ANY columns */
    strict: z.boolean().optional(),
  })
  .strict();

const VIEW_PROPS = z
  .object({
    /** the SELECT, as text */
    viewDefinition: expression(),
  })
  .strict();

const FIELD_PROPS = z
  .object({
    /** DEFAULT, as SQL text: `0`, `'active'`, `CURRENT_TIMESTAMP`, `(random())` */
    default: expression(),
    /** `AUTOINCREMENT` on an `INTEGER PRIMARY KEY` */
    autoIncrement: z.boolean().optional(),
    collation: name(),
    generatedExpression: expression(),
    generatedKind: z.enum(['VIRTUAL', 'STORED']).optional(),
  })
  .strict();

const INDEX_PROPS = z
  .object({
    /** a partial index's predicate */
    where: expression(),
  })
  .strict();

const INDEX_COLUMN_PROPS = z
  .object({
    collation: name(),
  })
  .strict();

const CHECK_PROPS = z
  .object({
    expression: expression(),
  })
  .strict();

const FOREIGN_KEY_PROPS = z
  .object({
    onDelete: REFERENTIAL_ACTION.optional(),
    onUpdate: REFERENTIAL_ACTION.optional(),
    /** `DEFERRABLE INITIALLY DEFERRED` */
    deferred: z.boolean().optional(),
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
