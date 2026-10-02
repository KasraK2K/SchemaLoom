import { describe, expect, it } from 'vitest';
import { defineCapabilities } from './define-capabilities.js';
import { CapabilitiesContradictionError } from './errors.js';
import type { CapabilitiesInput } from './capabilities.js';
import { FOREIGN_KEY_KIND, TABLE_KIND, VIEW_KIND, relationalInput } from './fixture-engine.js';

/** Assert that one specific invariant id is the one that fired. */
function expectRule(rule: string, overrides: Partial<CapabilitiesInput>): void {
  let thrown: unknown;
  try {
    defineCapabilities(relationalInput(overrides));
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CapabilitiesContradictionError);
  expect((thrown as CapabilitiesContradictionError).rule).toBe(rule);
  expect((thrown as CapabilitiesContradictionError).engineId).toBe('fixturesql');
  expect((thrown as CapabilitiesContradictionError).code).toBe('engine.capabilities-contradiction');
}

describe('defineCapabilities', () => {
  it('accepts a valid relational config, fills the feature record and derives the flags', () => {
    const caps = defineCapabilities(relationalInput());

    // Every atom present; unlisted ones default to false.
    expect(caps.features.links).toBe(true);
    expect(caps.features.indexes).toBe(true);
    expect(caps.features.nestedFields).toBe(false);
    expect(caps.features.migrations).toBe(false);
    expect(caps.features.queryValidation).toBe(false);

    expect(caps.typeCatalogSupportsArrays).toBe(true);
    expect(Object.isFrozen(caps)).toBe(true);
    // Constructor arguments must not leak into the GET /engines payload.
    expect(caps).not.toHaveProperty('engineId');
    expect(caps).not.toHaveProperty('typeDescriptors');
  });

  it('links-imply-kinds', () => {
    expectRule('links-imply-kinds', { linkKinds: [] });
  });

  it('indexes-imply-types', () => {
    expectRule('indexes-imply-types', { indexTypes: [] });
  });

  it('one-default-index', () => {
    const btree = relationalInput().indexTypes[0];
    if (btree === undefined) throw new Error('fixture has no index type');
    expectRule('one-default-index', {
      indexTypes: [btree, { ...btree, id: 'hash', isDefault: true }],
    });
  });

  it('entity-kinds-present rejects an empty list', () => {
    expectRule('entity-kinds-present', {
      entityKinds: [],
      linkKinds: [],
      features: { indexes: true },
    });
  });

  it('entity-kinds-present rejects a duplicate shortCode', () => {
    expectRule('entity-kinds-present', {
      entityKinds: [TABLE_KIND, { ...VIEW_KIND, shortCode: 'T' }],
    });
  });

  it('entity-kinds-present rejects a shortCode outside /^[A-Z]{1,2}$/', () => {
    expectRule('entity-kinds-present', { entityKinds: [{ ...TABLE_KIND, shortCode: 'tbl' }] });
  });

  it('unique-kind-ids', () => {
    expectRule('unique-kind-ids', {
      constraintKinds: [
        { id: 'unique', scope: 'entity', maxPerEntity: null, hasExpression: false },
        { id: 'unique', scope: 'field', maxPerEntity: null, hasExpression: false },
      ],
    });
  });

  it('default-cardinality-allowed', () => {
    expectRule('default-cardinality-allowed', {
      linkKinds: [{ ...FOREIGN_KEY_KIND, defaultCardinality: 'N:M' }],
    });
  });

  it('referential-actions-need-enforcement', () => {
    expectRule('referential-actions-need-enforcement', {
      linkKinds: [{ ...FOREIGN_KEY_KIND, enforced: false }],
    });
  });

  it('link-endpoint-kinds-exist', () => {
    // 'view' exists but is canBeLinkEndpoint: false.
    expectRule('link-endpoint-kinds-exist', {
      linkKinds: [{ ...FOREIGN_KEY_KIND, allowedTargetEntityKinds: ['view'] }],
    });
  });

  it('namespaces-none', () => {
    expectRule('namespaces-none', { namespaces: 'none', defaultNamespaceName: 'public' });
  });

  it('namespaces-some', () => {
    expectRule('namespaces-some', { namespaces: 'optional', defaultNamespaceName: '' });
  });

  it('depth-sane rejects depth < 1', () => {
    expectRule('depth-sane', { maxFieldDepth: 0 });
  });

  it('depth-sane rejects nesting depth without features.nestedFields', () => {
    expectRule('depth-sane', { maxFieldDepth: 8, features: { links: true, indexes: true } });
  });

  it('index-features-need-indexes', () => {
    expectRule('index-features-need-indexes', {
      features: { links: true, expressionIndexes: true },
      indexTypes: [],
    });
  });

  it('format-ids-unique', () => {
    expectRule('format-ids-unique', {
      exportFormats: [
        {
          id: 'ddl',
          displayName: 'a',
          fileExtension: 'sql',
          supportsComments: true,
          supportsDrops: true,
        },
        {
          id: 'ddl',
          displayName: 'b',
          fileExtension: 'sql',
          supportsComments: false,
          supportsDrops: false,
        },
      ],
    });
  });

  it('query-language-present', () => {
    expectRule('query-language-present', {
      queryLanguage: {
        id: 'sql',
        displayName: 'SQL',
        fileExtension: 'sql',
        codeMirrorMode: '',
        lineComment: '--',
        statementSeparator: ';',
      },
    });
  });

  it('target-versions-sane: the default is one of the list, and no list means no default', () => {
    const caps = defineCapabilities(relationalInput());
    expect(caps.targetVersions).toEqual([]);
    expect(caps.defaultTargetVersion).toBeNull();
    expect(
      defineCapabilities(relationalInput({ targetVersions: ['2', '1'], defaultTargetVersion: '1' }))
        .defaultTargetVersion,
    ).toBe('1');
    expectRule('target-versions-sane', { targetVersions: ['2', '1'], defaultTargetVersion: '3' });
    expectRule('target-versions-sane', { targetVersions: ['2', '1'] });
    expectRule('target-versions-sane', { defaultTargetVersion: '1' });
    expectRule('target-versions-sane', { targetVersions: ['1', '1'], defaultTargetVersion: '1' });
  });

  it('identifiers-sane rejects an uncompilable validUnquoted regex', () => {
    expectRule('identifiers-sane', {
      identifiers: { ...relationalInput().identifiers, validUnquoted: '^[a-z' },
    });
  });
});
