import { anyTypeSupportsArray, formatMessage, resolveTerm } from '@schemaloom/engine-sdk';
import { describe, expect, it } from 'vitest';
import { postgresEngine } from './index.js';
import { postgresFacet } from './static.js';
import { TERMINOLOGY } from './terminology.js';

const caps = postgresFacet.capabilities;

describe('the static facet', () => {
  it('identifies the engine', () => {
    expect(postgresFacet.id).toBe('postgresql');
    expect(postgresFacet.displayName).toBe('PostgreSQL');
    expect(postgresFacet.paradigm).toBe('relational');
    expect(postgresFacet.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('carries the folding function core needs for identity', () => {
    expect(postgresFacet.normalizeName('Orders')).toBe('orders');
    expect(postgresFacet.normalizeName('X'.repeat(80))).toHaveLength(63);
  });

  it('is frozen by defineCapabilities', () => {
    expect(Object.isFrozen(caps)).toBe(true);
  });
});

describe('capabilities', () => {
  it('declares what spec §3.4 asks for', () => {
    expect(caps.namespaces).toBe('required');
    expect(caps.defaultNamespaceName).toBe('public');
    expect(caps.entityKinds.map((k) => k.id)).toEqual(['table', 'view', 'materializedView']);
    expect(caps.indexTypes.map((i) => i.id)).toEqual(['btree', 'hash', 'gin', 'gist', 'brin']);
    expect(caps.constraintKinds.map((c) => c.id)).toEqual([
      'primaryKey',
      'unique',
      'check',
      'exclusion',
    ]);
    expect(caps.customTypeKinds.map((c) => c.id)).toEqual(['enum', 'domain', 'composite']);
  });

  it('never nests — a jsonb column is one column, not a field tree', () => {
    expect(caps.features.nestedFields).toBe(false);
    expect(caps.maxFieldDepth).toBe(1);
  });

  it('turns on the feature atoms this engine implements', () => {
    expect(caps.features.notNull).toBe(true);
    expect(caps.features.links).toBe(true);
    expect(caps.features.referentialActions).toBe(true);
    expect(caps.features.indexes).toBe(true);
    expect(caps.features.expressionIndexes).toBe(true);
    expect(caps.features.includeColumns).toBe(true);
    expect(caps.features.comments).toBe(true);
  });

  it('derives array support from the type catalog', () => {
    expect(anyTypeSupportsArray(caps)).toBe(true);
  });

  it('states the identifier rules the exporter and the matcher both read', () => {
    expect(caps.identifiers.maxLength).toBe(63);
    expect(caps.identifiers.foldsTo).toBe('lower');
    expect(caps.identifiers.caseSensitive).toBe(false);
    expect(caps.identifiers.quoteOpen).toBe('"');
    expect(new RegExp(caps.identifiers.validUnquoted).test('order_items')).toBe(true);
    expect(new RegExp(caps.identifiers.validUnquoted).test('Order Items')).toBe(false);
    expect(caps.identifiers.reservedWords).toContain('select');
  });

  it('names SQL as its query language once, where everything reads it', () => {
    expect(caps.queryLanguage.id).toBe('sql');
    expect(caps.queryLanguage.lineComment).toBe('--');
    expect(caps.queryLanguage.statementSeparator).toBe(';');
  });
});

describe('terminology: the UI hard-codes no noun', () => {
  it('renders the core nouns', () => {
    expect(resolveTerm(TERMINOLOGY, 'entity').one).toBe('Table');
    expect(resolveTerm(TERMINOLOGY, 'field').other).toBe('Columns');
    expect(resolveTerm(TERMINOLOGY, 'namespace').one).toBe('Schema');
    expect(resolveTerm(TERMINOLOGY, 'link').one).toBe('Foreign key');
  });

  it('renders the verbs from core templates plus the engine nouns', () => {
    expect(formatMessage(TERMINOLOGY, 'action.add', 'entity')).toBe('Add table');
    expect(formatMessage(TERMINOLOGY, 'action.add', 'entityKind:materializedView')).toBe(
      'Add materialized view',
    );
    expect(formatMessage(TERMINOLOGY, 'action.rename', 'field')).toBe('Rename column');
    expect(formatMessage(TERMINOLOGY, 'action.delete', 'link')).toBe('Delete foreign key');
    expect(formatMessage(TERMINOLOGY, 'list.empty', 'index')).toBe('No indexes yet');
  });

  it('gets the article right', () => {
    expect(formatMessage(TERMINOLOGY, 'inspector.noSelection', 'index')).toBe(
      'Select an index to see its details',
    );
    expect(formatMessage(TERMINOLOGY, 'confirm.delete', 'namespace')).toBe(
      'Delete a schema? This cannot be undone.',
    );
    expect(formatMessage(TERMINOLOGY, 'palette.create', 'customTypeKind:enum')).toBe(
      'Create an enum',
    );
  });

  it('pluralises by count', () => {
    expect(formatMessage(TERMINOLOGY, 'list.count', 'entity', { count: 1 })).toBe('1 table');
    expect(formatMessage(TERMINOLOGY, 'list.count', 'entity', { count: 4 })).toBe('4 tables');
  });

  it('has a term for every kind the capabilities declare', () => {
    for (const kind of caps.entityKinds) expect(TERMINOLOGY.entityKindTerms[kind.id]).toBeDefined();
    for (const kind of caps.linkKinds) expect(TERMINOLOGY.linkKindTerms[kind.id]).toBeDefined();
    for (const kind of caps.constraintKinds) {
      expect(TERMINOLOGY.constraintKindTerms[kind.id]).toBeDefined();
    }
    for (const kind of caps.customTypeKinds) {
      expect(TERMINOLOGY.customTypeKindTerms[kind.id]).toBeDefined();
    }
  });
});

describe('the server definition', () => {
  it('extends the facet rather than rebuilding it', () => {
    expect(postgresEngine.id).toBe(postgresFacet.id);
    expect(postgresEngine.capabilities).toBe(postgresFacet.capabilities);
    expect(postgresEngine.typeCatalog).toBe(postgresFacet.typeCatalog);
    expect(postgresEngine.terminology).toBe(postgresFacet.terminology);
  });

  it('ships the two required members', () => {
    expect(postgresEngine.validator).toBeDefined();
    expect(typeof postgresEngine.extractReferences).toBe('function');
  });

  it('ships the importer and the exporter (steps 20 and 21)', () => {
    expect(typeof postgresEngine.importer?.import).toBe('function');
    expect(typeof postgresEngine.exporter?.export).toBe('function');
  });

  it('declares the later-phase services absent, and says so in the atoms', () => {
    expect(postgresEngine.annotateDiff).toBeUndefined();
    expect(postgresEngine.aiProfile).toBeUndefined();
    // capabilities/services-match-features
    expect(caps.features.migrations).toBe(postgresEngine.migrationGenerator !== undefined);
    expect(caps.features.queryValidation).toBe(postgresEngine.queryValidator !== undefined);
  });

  it('describes the formats the importer and exporter implement', () => {
    expect(caps.importFormats.map((f) => f.id)).toEqual(['ddl']);
    expect(caps.exportFormats.map((f) => f.id)).toEqual(['ddl']);
    expect(caps.exportFormats[0]?.supportsComments).toBe(true);
  });
});
