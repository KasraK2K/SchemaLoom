import type { EngineStaticFacet } from '@schemaloom/engine-sdk/ui';
import type { Index } from '@schemaloom/schema-model';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import type { EngineUiPlugin } from './contract';
import { EngineValueProvider, type EngineContextValue } from './engine-provider';
import { IndexesPanel } from './indexes-panel';
import { visibleTabs } from './inspector-tabs';
import { engineFacets, engineUi } from './registry';
import { useTerminology } from './use-terminology';

/**
 * The real wiring, end to end: `register.ts` registers loaders, the registries resolve them
 * lazily, and every noun on screen comes back out of the engine's own terminology bundle.
 */
let postgres: EngineContextValue;

beforeAll(async () => {
  await import('./register');
  const [facet, ui] = await Promise.all([
    engineFacets.load('postgresql'),
    engineUi.load('postgresql'),
  ]);
  postgres = { facet, ui };
});

const render = (value: EngineContextValue, node: ReactNode): string =>
  renderToStaticMarkup(<EngineValueProvider value={value}>{node}</EngineValueProvider>);

/** A capability-false engine. Nothing in the repo ships one, and that is exactly why the gate
 *  needs a doctored facet: the point is that no engine-specific code exists to test against. */
const withoutIndexes = (value: EngineContextValue): EngineContextValue => ({
  ...value,
  facet: {
    ...value.facet,
    capabilities: {
      ...value.facet.capabilities,
      features: { ...value.facet.capabilities.features, indexes: false },
    },
  } satisfies EngineStaticFacet,
});

function TerminologyProbe() {
  const t = useTerminology();
  return (
    <dl>
      <dd>{t.msg('action.add', 'entity')}</dd>
      <dd>{t.msg('action.delete', 'field')}</dd>
      <dd>{t.msg('list.title', 'field')}</dd>
      <dd>{t.msg('list.count', 'field', { count: 12 })}</dd>
      <dd>{t.msg('list.count', 'field', { count: 1 })}</dd>
      <dd>{t.msg('action.add', 'entityKind:materializedView')}</dd>
      <dd>{t.msg('inspector.noSelection', 'index')}</dd>
      <dd>{t.msg('list.title', 'namespace')}</dd>
      <dd>{t.term('link').one}</dd>
    </dl>
  );
}

describe('the registries resolve a real engine', () => {
  it('loads the PostgreSQL facet and its UI plugin', () => {
    expect(postgres.facet.id).toBe('postgresql');
    expect(postgres.ui.engineId).toBe('postgresql');
  });

  it('gives the plugin a node renderer for the facet’s entity kinds', () => {
    for (const kind of postgres.facet.capabilities.entityKinds) {
      expect(postgres.ui.nodeRenderers[kind.id]).toBeDefined();
    }
  });
});

describe('useTerminology', () => {
  it('returns PostgreSQL nouns in singular, plural and verb forms', () => {
    const html = render(postgres, <TerminologyProbe />);
    // the verb is core's template; only the noun is the engine's
    expect(html).toContain('<dd>Add table</dd>');
    expect(html).toContain('<dd>Delete column</dd>');
    expect(html).toContain('<dd>Columns</dd>');
    expect(html).toContain('<dd>12 columns</dd>');
    expect(html).toContain('<dd>1 column</dd>');
    expect(html).toContain('<dd>Add materialized view</dd>');
    // the indefinite article comes from the bundle, not from a first-letter guess
    expect(html).toContain('<dd>Select an index to see its details</dd>');
    // PostgreSQL calls a namespace a schema
    expect(html).toContain('<dd>Schemas</dd>');
    expect(html).toContain('<dd>Foreign key</dd>');
  });

  it('never renders "undefined" for a kind the bundle does not cover', () => {
    const html = render(postgres, <TerminologyProbe />);
    expect(html).not.toContain('undefined');
  });
});

describe('the Indexes panel (§16.5)', () => {
  const indexes: readonly Index[] = [
    {
      id: 'i1',
      name: 'orders_email_key',
      version: 1,
      engineProps: {},
      entityId: 'e1',
      kind: 'btree',
      isUnique: true,
      columns: [],
    },
  ];

  it('renders for an engine whose capabilities say it has indexes', () => {
    const html = render(postgres, <IndexesPanel indexes={indexes} />);
    expect(html).toContain('Indexes');
    expect(html).toContain('orders_email_key');
    expect(html).toContain('1 index');
    expect(html).toContain('Add index');
  });

  it('is absent for an engine whose capabilities say it has none', () => {
    const html = render(withoutIndexes(postgres), <IndexesPanel indexes={indexes} />);
    expect(html).toBe('');
  });

  it('hides the inspector tab from the same one declaration', () => {
    const on = visibleTabs(postgres.facet.capabilities).map((tab) => tab.id);
    const off = visibleTabs(withoutIndexes(postgres).facet.capabilities).map((tab) => tab.id);
    expect(on).toContain('indexes');
    expect(off).not.toContain('indexes');
    // and nothing else moved
    expect(off).toEqual(on.filter((id) => id !== 'indexes'));
  });
});

describe('the fallback plugin', () => {
  it('stands in for an unregistered engine without crashing', async () => {
    const ui: EngineUiPlugin = await engineUi.load('not-an-engine');
    expect(ui.engineId).toBe('fallback');
    expect(ui.defaultNodeRenderer).toBeDefined();
    expect(ui.TypePicker).toBeDefined();
    // usable, not an error screen: a raw props editor for every object type
    expect(ui.panels.entity?.[0]?.id).toBe('core.raw-props.entity');
  });
});
