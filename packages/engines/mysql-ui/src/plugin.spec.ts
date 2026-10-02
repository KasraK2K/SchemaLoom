import { mysqlFacet } from '@schemaloom/engine-mysql/static';
import { describe, expect, it } from 'vitest';
import mysqlEngineUi from './index.js';

/**
 * Shape, not markup. The render tests live in `apps/web`, because that is where `react-dom`
 * and its types are installed — the same reason `button-render.spec.tsx` is not in
 * `packages/ui`. What is asserted here is the half that must hold without a DOM: that every
 * kind-keyed map is DERIVED from the facet's descriptors, so adding an entity kind or a link
 * kind to `capabilities.ts` needs no edit in the plugin.
 */
describe('mysqlEngineUi', () => {
  it('is the MySQL plugin, named from the facet rather than a literal', () => {
    expect(mysqlEngineUi.engineId).toBe(mysqlFacet.id);
  });

  it('has a node renderer for every entity kind the engine declares', () => {
    const kinds = mysqlFacet.capabilities.entityKinds.map((kind) => kind.id);
    expect(kinds.length).toBeGreaterThan(1);
    expect(Object.keys(mysqlEngineUi.nodeRenderers).sort()).toEqual([...kinds].sort());
    expect(mysqlEngineUi.defaultNodeRenderer).toBeDefined();
  });

  it('derives a link style from every link kind the engine declares', () => {
    for (const kind of mysqlFacet.capabilities.linkKinds) {
      expect(mysqlEngineUi.linkStyles?.[kind.id]).toEqual({
        sourceMarker: kind.directed ? 'many' : 'none',
        targetMarker: kind.directed ? 'one' : 'none',
        dashed: !kind.enforced,
      });
    }
  });

  it('supplies a type picker, a type badge and the icons the facet names', () => {
    expect(mysqlEngineUi.TypePicker).toBeDefined();
    expect(mysqlEngineUi.TypeBadge).toBeDefined();
    for (const kind of mysqlFacet.capabilities.entityKinds) {
      expect(mysqlEngineUi.icons?.[kind.icon]).toBeDefined();
    }
    expect(mysqlEngineUi.icons?.[mysqlFacet.icon]).toBeDefined();
  });

  it('ships no editor language, leaving core to load one from the declared mode', () => {
    expect(mysqlEngineUi.loadEditorLanguage).toBeUndefined();
    expect(mysqlFacet.capabilities.queryLanguage.codeMirrorMode).toBe('sql');
  });
});

describe('connectionHint', () => {
  const hint = mysqlEngineUi.connectionHint;
  if (hint === undefined) throw new Error('no connection hint');
  const check = {
    ok: false,
    linkKindId: 'foreignKey',
    allowedCardinalities: [],
    suggestedCardinality: null,
    reasons: [],
    needsJunction: false,
  };

  it('suggests a junction table for N:M', () => {
    expect(hint({ ...check, needsJunction: true })).toContain('junction');
  });

  it('explains a type mismatch', () => {
    expect(hint({ ...check, reasons: [{ code: 'link.typeMismatch' }] })).toContain('signedness');
  });

  it('says nothing when there is nothing to add', () => {
    expect(hint({ ...check, reasons: [{ code: 'link.selfNotAllowed' }] })).toBeNull();
  });
});

describe('panel sections', () => {
  it('gates referential actions on the capability, never on the engine id', () => {
    const actions = mysqlEngineUi.panels.link?.find(
      (section) => section.id === 'mysql.foreignKey.actions',
    );
    expect(actions?.available?.(mysqlFacet.capabilities)).toBe(true);
    expect(
      actions?.available?.({
        ...mysqlFacet.capabilities,
        features: { ...mysqlFacet.capabilities.features, referentialActions: false },
      }),
    ).toBe(false);
  });

  it('gates the CHECK section on the constraint kind existing', () => {
    const check = mysqlEngineUi.panels.constraint?.find(
      (section) => section.id === 'mysql.constraint.check',
    );
    expect(check?.available?.(mysqlFacet.capabilities)).toBe(true);
    expect(check?.available?.({ ...mysqlFacet.capabilities, constraintKinds: [] })).toBe(false);
  });

  it('orders engine sections after core’s (0, 100, 200…)', () => {
    const sections = [
      ...(mysqlEngineUi.panels.entity ?? []),
      ...(mysqlEngineUi.panels.field ?? []),
      ...(mysqlEngineUi.panels.link ?? []),
      ...(mysqlEngineUi.panels.index ?? []),
      ...(mysqlEngineUi.panels.constraint ?? []),
    ];
    expect(sections.length).toBeGreaterThan(5);
    for (const section of sections) {
      expect(section.order).toBeGreaterThanOrEqual(100);
      expect(section.id.startsWith('mysql.')).toBe(true);
    }
  });
});
