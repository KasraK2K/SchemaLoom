import { postgresFacet } from '@schemaloom/engine-postgresql/static';
import { describe, expect, it } from 'vitest';
import postgresEngineUi from './index.js';

/**
 * Shape, not markup. The render tests live in `apps/web`, because that is where `react-dom`
 * and its types are installed — the same reason `button-render.spec.tsx` is not in
 * `packages/ui`. What is asserted here is the half that must hold without a DOM: that every
 * kind-keyed map is DERIVED from the facet's descriptors, so adding an entity kind or a link
 * kind to `capabilities.ts` needs no edit in the plugin.
 */
describe('postgresEngineUi', () => {
  it('is the PostgreSQL plugin, named from the facet rather than a literal', () => {
    expect(postgresEngineUi.engineId).toBe(postgresFacet.id);
  });

  it('has a node renderer for every entity kind the engine declares', () => {
    const kinds = postgresFacet.capabilities.entityKinds.map((kind) => kind.id);
    expect(kinds.length).toBeGreaterThan(1);
    expect(Object.keys(postgresEngineUi.nodeRenderers).sort()).toEqual([...kinds].sort());
    expect(postgresEngineUi.defaultNodeRenderer).toBeDefined();
  });

  it('derives a link style from every link kind the engine declares', () => {
    for (const kind of postgresFacet.capabilities.linkKinds) {
      expect(postgresEngineUi.linkStyles?.[kind.id]).toEqual({
        sourceMarker: kind.directed ? 'many' : 'none',
        targetMarker: kind.directed ? 'one' : 'none',
        dashed: !kind.enforced,
      });
    }
  });

  it('supplies a type picker, a type badge and the icons the facet names', () => {
    expect(postgresEngineUi.TypePicker).toBeDefined();
    expect(postgresEngineUi.TypeBadge).toBeDefined();
    for (const kind of postgresFacet.capabilities.entityKinds) {
      expect(postgresEngineUi.icons?.[kind.icon]).toBeDefined();
    }
    expect(postgresEngineUi.icons?.[postgresFacet.icon]).toBeDefined();
  });

  it('ships no editor language, leaving core to load one from the declared mode', () => {
    expect(postgresEngineUi.loadEditorLanguage).toBeUndefined();
    expect(postgresFacet.capabilities.queryLanguage.codeMirrorMode).toBe('sql');
  });
});

describe('connectionHint', () => {
  const hint = postgresEngineUi.connectionHint;
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
    expect(hint({ ...check, reasons: [{ code: 'link.typeMismatch' }] })).toContain('types');
  });

  it('says nothing when there is nothing to add', () => {
    expect(hint({ ...check, reasons: [{ code: 'link.selfNotAllowed' }] })).toBeNull();
  });
});

describe('panel sections', () => {
  it('gates referential actions on the capability, never on the engine id', () => {
    const actions = postgresEngineUi.panels.link?.find(
      (section) => section.id === 'pg.foreignKey.actions',
    );
    expect(actions?.available?.(postgresFacet.capabilities)).toBe(true);
    expect(
      actions?.available?.({
        ...postgresFacet.capabilities,
        features: { ...postgresFacet.capabilities.features, referentialActions: false },
      }),
    ).toBe(false);
  });

  it('gates the partial-index section on expression indexes', () => {
    const partial = postgresEngineUi.panels.index?.find(
      (section) => section.id === 'pg.index.partial',
    );
    expect(partial?.available?.(postgresFacet.capabilities)).toBe(true);
    expect(
      partial?.available?.({
        ...postgresFacet.capabilities,
        features: { ...postgresFacet.capabilities.features, expressionIndexes: false },
      }),
    ).toBe(false);
  });

  it('gates the CHECK section on the constraint kind existing', () => {
    const check = postgresEngineUi.panels.constraint?.find(
      (section) => section.id === 'pg.constraint.check',
    );
    expect(check?.available?.(postgresFacet.capabilities)).toBe(true);
    expect(check?.available?.({ ...postgresFacet.capabilities, constraintKinds: [] })).toBe(false);
  });

  it('orders engine sections after core’s (0, 100, 200…)', () => {
    const sections = [
      ...(postgresEngineUi.panels.entity ?? []),
      ...(postgresEngineUi.panels.field ?? []),
      ...(postgresEngineUi.panels.link ?? []),
      ...(postgresEngineUi.panels.index ?? []),
      ...(postgresEngineUi.panels.constraint ?? []),
    ];
    expect(sections.length).toBeGreaterThan(5);
    for (const section of sections) {
      expect(section.order).toBeGreaterThanOrEqual(100);
      expect(section.id.startsWith('pg.')).toBe(true);
    }
  });
});
