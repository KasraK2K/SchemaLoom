import { FALLBACK_TERMINOLOGY, type TerminologyBundle } from '@schemaloom/engine-sdk';

/**
 * The nouns, and only the nouns (doc 03 §16.2). The verbs are core's:
 * `formatMessage(TERMINOLOGY, 'action.add', 'entityKind:table')` renders "Add table" from
 * `CORE_MESSAGE_TEMPLATES`, so nothing in the UI hard-codes "table", "column" or "Add".
 *
 * Spread over `FALLBACK_TERMINOLOGY` so a core term added later degrades to the generic
 * word instead of rendering `undefined`.
 */
export const TERMINOLOGY: TerminologyBundle = {
  ...FALLBACK_TERMINOLOGY,
  terms: {
    ...FALLBACK_TERMINOLOGY.terms,
    namespace: { one: 'Schema', other: 'Schemas' },
    entity: { one: 'Table', other: 'Tables' },
    field: { one: 'Column', other: 'Columns' },
    link: { one: 'Foreign key', other: 'Foreign keys' },
    index: { one: 'Index', other: 'Indexes', indefinite: 'an' },
    constraint: { one: 'Constraint', other: 'Constraints' },
    customType: { one: 'Type', other: 'Types' },
    query: { one: 'Query', other: 'Queries' },
  },
  entityKindTerms: {
    table: { one: 'Table', other: 'Tables' },
    view: { one: 'View', other: 'Views' },
    materializedView: { one: 'Materialized view', other: 'Materialized views' },
  },
  linkKindTerms: {
    foreignKey: { one: 'Foreign key', other: 'Foreign keys' },
  },
  constraintKindTerms: {
    primaryKey: { one: 'Primary key', other: 'Primary keys' },
    unique: { one: 'Unique constraint', other: 'Unique constraints' },
    check: { one: 'Check constraint', other: 'Check constraints' },
    exclusion: { one: 'Exclusion constraint', other: 'Exclusion constraints', indefinite: 'an' },
  },
  customTypeKindTerms: {
    enum: { one: 'Enum', other: 'Enums', indefinite: 'an' },
    domain: { one: 'Domain', other: 'Domains' },
    composite: { one: 'Composite type', other: 'Composite types' },
  },
};
