import { FALLBACK_TERMINOLOGY, type TerminologyBundle } from '@schemaloom/engine-sdk';

/** The nouns (doc 03 §16.2). A project is one database file. */
export const TERMINOLOGY: TerminologyBundle = {
  ...FALLBACK_TERMINOLOGY,
  terms: {
    ...FALLBACK_TERMINOLOGY.terms,
    namespace: { one: 'Database', other: 'Databases' },
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
  },
  linkKindTerms: {
    foreignKey: { one: 'Foreign key', other: 'Foreign keys' },
  },
  constraintKindTerms: {
    primaryKey: { one: 'Primary key', other: 'Primary keys' },
    unique: { one: 'Unique key', other: 'Unique keys' },
    check: { one: 'Check constraint', other: 'Check constraints' },
  },
  customTypeKindTerms: {},
};
