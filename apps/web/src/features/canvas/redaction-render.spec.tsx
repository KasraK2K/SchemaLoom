import type { EngineStaticFacet } from '@schemaloom/engine-sdk/ui';
import { createIndex, type SchemaModel } from '@schemaloom/schema-model';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { engineFacets, engineUi, type EngineUiPlugin } from '@/engines';
import { areaColors } from './area-color';
import { EntityBody } from './entity-body';
import { buildNodes, type EntityNodeData } from './graph';
import { ORDERS, ORDER_ID, SECRET, fixtureModel } from './model-fixture';

/**
 * The visible half of the redaction work.
 *
 * Rendering lives in `apps/web` because this is where `react-dom` is installed — the same
 * reason `button-render.spec.tsx` is not in `packages/ui`. It renders `EntityBody`, which
 * is the hook-free dispatcher, so the assertion is about what a viewer SEES and not about
 * what a store happens to hold.
 */
let facet: EngineStaticFacet;
let ui: EngineUiPlugin;
let model: SchemaModel;
let data: Map<string, EntityNodeData>;

beforeAll(async () => {
  await import('@/engines/register');
  [facet, ui] = await Promise.all([engineFacets.load('postgresql'), engineUi.load('postgresql')]);
  model = fixtureModel();
  data = new Map(
    buildNodes(createIndex(model), facet, areaColors(Object.values(model.objects.area))).map(
      (node) => [node.id, node.data],
    ),
  );
});

/** Links off, so `FieldHandle` becomes the component that renders `null` (§16.1) and the
 *  card can be rendered without a React Flow context. */
function linklessFacet(): EngineStaticFacet {
  return {
    ...facet,
    capabilities: {
      ...facet.capabilities,
      features: { ...facet.capabilities.features, links: false },
    },
  };
}

function render(entityId: string, engine: EngineStaticFacet = facet): string {
  const nodeData = data.get(entityId);
  if (nodeData === undefined) throw new Error(`no node for ${entityId}`);
  return renderToStaticMarkup(
    <EntityBody
      data={nodeData}
      facet={engine}
      ui={ui}
      selected={false}
      collapsed={false}
      highlightedFieldIds={new Set()}
      onFieldSelect={() => undefined}
      onToggleCollapse={() => undefined}
    />,
  );
}

describe('a restricted entity on the canvas', () => {
  it('renders as a stub labelled "restricted"', () => {
    const html = render(SECRET);
    expect(html).toContain('restricted');
    expect(html).toContain('data-restricted="true"');
  });

  it('renders no name — and does NOT fall back to the id', () => {
    // A cuid is not a name, but it is a stable handle an outsider can correlate across
    // projects and screenshots. `entity.name || entity.id` is the tempting bug.
    const html = render(SECRET);
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain('secret');
  });

  it('is faded and dashed rather than drawn as a normal card', () => {
    const html = render(SECRET);
    expect(html).toContain('border-dashed');
    expect(html).toMatch(/opacity-\d/);
  });

  it('never reaches the engine renderer, which would draw an empty name', () => {
    // The engine card always renders a header with `entity.name`. A stub routed through it
    // would look like a broken table rather than a hidden one.
    expect(render(SECRET)).not.toContain('<header');
  });

  it('shows no field rows, because it was given none', () => {
    expect(render(SECRET)).not.toContain('<li');
  });
});

describe('a visible entity on the canvas', () => {
  it('goes through the engine UI registry and keeps its name and columns', () => {
    const html = render(ORDERS, linklessFacet());
    expect(html).toContain('orders');
    expect(html).toContain(model.objects.field[ORDER_ID]?.name ?? '');
    expect(html).toContain('<header');
  });

  it('draws the badges core derived, not flags off the field', () => {
    expect(render(ORDERS, linklessFacet())).toContain('PK');
  });
});
