import type { EngineStaticFacet, ResolvedType } from '@schemaloom/engine-sdk/ui';
import type { Entity, Field, Id, TypeRef } from '@schemaloom/schema-model';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import type { EngineNodeProps, EngineUiPlugin, FieldBadges } from './contract';
import { FALLBACK_ENGINE_UI } from './fallback';
import { engineFacets, engineUi } from './registry';

/**
 * Rendering lives here rather than in the engine UI package, because this is where `react-dom`
 * and its types are installed — the same reason `button-render.spec.tsx` is not in
 * `packages/ui`. It also proves the cross-package wiring: the plugin the registry lazily
 * loaded really renders.
 */
let facet: EngineStaticFacet;
let ui: EngineUiPlugin;

beforeAll(async () => {
  await import('./register');
  [facet, ui] = await Promise.all([engineFacets.load('postgresql'), engineUi.load('postgresql')]);
});

const entity = (over: Partial<Entity> = {}): Entity => ({
  id: 'e1',
  name: 'orders',
  version: 1,
  engineProps: {},
  namespaceId: 'ns1',
  kind: 'table',
  areaId: null,
  position: { x: 0, y: 0 },
  color: null,
  doc: null,
  ...over,
});

const field = (id: Id, name: string, type: TypeRef, over: Partial<Field> = {}): Field => ({
  id,
  name,
  version: 1,
  engineProps: {},
  entityId: 'e1',
  parentFieldId: null,
  ordinal: 0,
  type,
  isNullable: false,
  isRestricted: false,
  isPii: false,
  isDeprecated: false,
  doc: null,
  ...over,
});

const resolve = (ref: TypeRef): ResolvedType =>
  facet.typeCatalog.resolve(ref, { customTypes: [], namespaceName: 'public' });

const NoHandle = () => null;

function nodeProps(over: Partial<EngineNodeProps> = {}): EngineNodeProps {
  const uuid: TypeRef = { name: 'uuid' };
  const varchar: TypeRef = { name: 'varchar', args: [255] };
  return {
    entity: entity(),
    fields: [field('f1', 'id', uuid), field('f2', 'email', varchar, { ordinal: 1 })],
    badges: new Map<Id, FieldBadges>([
      ['f1', { primaryKey: true, foreignKey: false, unique: false }],
      ['f2', { primaryKey: false, foreignKey: false, unique: true }],
    ]),
    resolvedTypes: new Map<Id, ResolvedType>([
      ['f1', resolve(uuid)],
      ['f2', resolve(varchar)],
    ]),
    engine: facet,
    selected: false,
    collapsed: false,
    highlightedFieldIds: new Set<Id>(),
    areaColor: null,
    diagnostics: [],
    FieldHandle: NoHandle,
    onFieldSelect: () => undefined,
    onToggleCollapse: () => undefined,
    ...over,
  };
}

describe('the engine’s entity node', () => {
  it('renders the name, every column and its resolved type', () => {
    const Node = ui.nodeRenderers.table;
    if (Node === undefined) throw new Error('no renderer for the default entity kind');
    const html = renderToStaticMarkup(<Node {...nodeProps()} />);
    expect(html).toContain('orders');
    expect(html).toContain('email');
    expect(html).toContain('uuid');
    expect(html).toContain('varchar(255)');
  });

  it('renders the derived PK / UQ badges rather than reading a field flag', () => {
    const Node = ui.nodeRenderers.table;
    if (Node === undefined) throw new Error('no renderer');
    const html = renderToStaticMarkup(<Node {...nodeProps()} />);
    expect(html).toContain('>PK<');
    expect(html).toContain('>UQ<');
    expect(html).not.toContain('>FK<');
  });

  it('renders the engine’s own empty-list noun', () => {
    const Node = ui.nodeRenderers.table;
    if (Node === undefined) throw new Error('no renderer');
    const html = renderToStaticMarkup(<Node {...nodeProps({ fields: [] })} />);
    expect(html).toContain('No columns yet');
  });

  it('keeps a restricted field’s name and type but marks it (R-1)', () => {
    const Node = ui.nodeRenderers.table;
    if (Node === undefined) throw new Error('no renderer');
    const ssn: TypeRef = { name: 'text' };
    const html = renderToStaticMarkup(
      <Node
        {...nodeProps({
          fields: [field('f1', 'ssn', ssn, { restricted: true })],
          resolvedTypes: new Map<Id, ResolvedType>([['f1', resolve(ssn)]]),
        })}
      />,
    );
    expect(html).toContain('ssn');
    expect(html).toContain('Restricted');
  });
});

describe('the engine’s property panels', () => {
  const panelProps = {
    model: { project: null } as never,
    readOnly: false,
    diagnostics: [],
    onChange: () => undefined,
  };

  it('renders a section only for the object kind it belongs to', () => {
    const definition = ui.panels.entity?.find((section) => section.id === 'pg.view.definition');
    if (definition === undefined) throw new Error('no view definition section');
    const forView = renderToStaticMarkup(
      <definition.Component
        {...panelProps}
        engine={facet}
        object={entity({ id: 'e2', name: 'v', kind: 'view' })}
      />,
    );
    const forTable = renderToStaticMarkup(
      <definition.Component {...panelProps} engine={facet} object={entity()} />,
    );
    expect(forView).toContain('SELECT body');
    expect(forTable).toBe('');
  });

  it('says so instead of showing empty inputs when props were redacted (R-1)', () => {
    const storage = ui.panels.entity?.find((section) => section.id === 'pg.table.storage');
    if (storage === undefined) throw new Error('no storage section');
    const html = renderToStaticMarkup(
      <storage.Component
        {...panelProps}
        engine={facet}
        object={entity({ propsRedacted: true })}
      />,
    );
    expect(html).toContain('hidden from you');
    expect(html).not.toContain('Tablespace');
  });
});

describe('the engine’s type picker', () => {
  it('offers the catalog’s grouped options and pre-fills the current parameters', () => {
    const Picker = ui.TypePicker;
    if (Picker === undefined) throw new Error('no type picker');
    const value: TypeRef = { name: 'varchar', args: [255] };
    const html = renderToStaticMarkup(
      <Picker
        value={value}
        options={facet.typeCatalog.listPickerOptions({ customTypes: [], namespaceName: 'public' })}
        resolved={resolve(value)}
        disabled={false}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain('<optgroup');
    expect(html).toContain('value="builtin:varchar"');
    expect(html).toContain('value="255"');
  });
});

describe('the fallback plugin renders too', () => {
  it('draws a generic card with the entity kind’s short code', () => {
    const Node = FALLBACK_ENGINE_UI.defaultNodeRenderer;
    if (Node === undefined) throw new Error('no fallback renderer');
    const html = renderToStaticMarkup(<Node {...nodeProps()} />);
    expect(html).toContain('orders');
    expect(html).toContain('email');
    expect(html).toContain('uuid');
    // 'T' for table, from EntityKindDescriptor.shortCode — no engine-specific code involved
    expect(html).toContain('>T<');
  });

  it('gives an unpolished engine an editable props bag rather than a read-only one', () => {
    const section = FALLBACK_ENGINE_UI.panels.entity?.[0];
    if (section === undefined) throw new Error('no raw props section');
    const html = renderToStaticMarkup(
      <section.Component
        model={{ project: null } as never}
        engine={facet}
        readOnly={false}
        diagnostics={[]}
        onChange={() => undefined}
        object={entity({ engineProps: { fillfactor: 70 } })}
      />,
    );
    expect(html).toContain('<textarea');
    expect(html).toContain('fillfactor');
  });
});
