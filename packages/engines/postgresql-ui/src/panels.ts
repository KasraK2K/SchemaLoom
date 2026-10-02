import { hasConstraintKind } from '@schemaloom/engine-sdk/ui';
import type { Constraint, Entity, Field, Index, Link } from '@schemaloom/schema-model';
import type { PropertyPanelSection } from '@schemaloom/engine-sdk/ui';
import { propsSection } from './props-section.js';

/**
 * Every section below edits `engineProps` and nothing else — core owns `name`, `kind`,
 * `isNullable`, `columns` and the rest, and a section that touched them would be a second
 * writer for a core column.
 *
 * `order` starts at 100: core's own sections occupy 0, 100, 200… and the engine's sit after
 * the details block (§16.1).
 */

const REFERENTIAL_ACTIONS = ['noAction', 'restrict', 'cascade', 'setNull', 'setDefault'] as const;

export const ENTITY_SECTIONS: readonly PropertyPanelSection<Entity>[] = [
  propsSection<Entity>({
    id: 'pg.table.storage',
    title: 'Storage',
    order: 200,
    defaultCollapsed: true,
    visibleFor: (entity) => entity.kind === 'table',
    controls: [
      { kind: 'boolean', name: 'unlogged', label: 'Unlogged' },
      { kind: 'boolean', name: 'rowLevelSecurity', label: 'Row level security' },
      { kind: 'text', name: 'tablespace', label: 'Tablespace' },
      { kind: 'number', name: 'fillfactor', label: 'Fill factor', min: 10, max: 100 },
    ],
  }),
  propsSection<Entity>({
    id: 'pg.view.definition',
    title: 'Definition',
    order: 210,
    visibleFor: (entity) => entity.kind === 'view' || entity.kind === 'materializedView',
    controls: [
      {
        kind: 'text',
        name: 'viewDefinition',
        label: 'SELECT body',
        multiline: true,
        placeholder: 'select …',
      },
    ],
  }),
  propsSection<Entity>({
    id: 'pg.view.options',
    title: 'Options',
    order: 220,
    defaultCollapsed: true,
    visibleFor: (entity) => entity.kind === 'view',
    controls: [
      { kind: 'enum', name: 'checkOption', label: 'Check option', options: ['local', 'cascaded'] },
    ],
  }),
  propsSection<Entity>({
    id: 'pg.materializedView.options',
    title: 'Options',
    order: 220,
    defaultCollapsed: true,
    visibleFor: (entity) => entity.kind === 'materializedView',
    controls: [
      { kind: 'boolean', name: 'withData', label: 'Populate on create' },
      { kind: 'text', name: 'tablespace', label: 'Tablespace' },
    ],
  }),
];

export const FIELD_SECTIONS: readonly PropertyPanelSection<Field>[] = [
  propsSection<Field>({
    id: 'pg.column.value',
    title: 'Value',
    order: 100,
    controls: [
      { kind: 'text', name: 'default', label: 'Default', placeholder: 'now()' },
      { kind: 'text', name: 'generatedExpression', label: 'Generated as' },
      { kind: 'enum', name: 'identity', label: 'Identity', options: ['always', 'byDefault'] },
    ],
  }),
  propsSection<Field>({
    id: 'pg.column.storage',
    title: 'Storage',
    order: 110,
    defaultCollapsed: true,
    controls: [
      { kind: 'text', name: 'collation', label: 'Collation' },
      {
        kind: 'enum',
        name: 'storage',
        label: 'Storage',
        options: ['plain', 'external', 'extended', 'main'],
      },
      { kind: 'enum', name: 'compression', label: 'Compression', options: ['pglz', 'lz4'] },
    ],
  }),
];

export const LINK_SECTIONS: readonly PropertyPanelSection<Link>[] = [
  propsSection<Link>({
    id: 'pg.foreignKey.actions',
    title: 'Referential actions',
    order: 100,
    // Not `engineId === 'postgresql'` and not a hard-coded true: the same section is dead
    // weight for an engine that declares links but enforces nothing.
    available: (caps) => caps.features.referentialActions,
    visibleFor: (link) => link.kind === 'foreignKey',
    controls: [
      { kind: 'enum', name: 'onDelete', label: 'On delete', options: REFERENTIAL_ACTIONS },
      { kind: 'enum', name: 'onUpdate', label: 'On update', options: REFERENTIAL_ACTIONS },
    ],
  }),
  propsSection<Link>({
    id: 'pg.foreignKey.timing',
    title: 'Timing',
    order: 110,
    defaultCollapsed: true,
    visibleFor: (link) => link.kind === 'foreignKey',
    controls: [
      { kind: 'boolean', name: 'deferrable', label: 'Deferrable' },
      { kind: 'boolean', name: 'initiallyDeferred', label: 'Initially deferred' },
      { kind: 'boolean', name: 'matchFull', label: 'MATCH FULL' },
    ],
  }),
];

export const INDEX_SECTIONS: readonly PropertyPanelSection<Index>[] = [
  propsSection<Index>({
    id: 'pg.index.partial',
    title: 'Partial index',
    order: 100,
    available: (caps) => caps.features.expressionIndexes,
    controls: [{ kind: 'text', name: 'where', label: 'WHERE', placeholder: 'deleted_at is null' }],
  }),
  propsSection<Index>({
    id: 'pg.index.options',
    title: 'Options',
    order: 110,
    defaultCollapsed: true,
    controls: [
      { kind: 'boolean', name: 'concurrently', label: 'Build concurrently' },
      { kind: 'boolean', name: 'nullsNotDistinct', label: 'Nulls not distinct' },
      { kind: 'text', name: 'tablespace', label: 'Tablespace' },
      { kind: 'number', name: 'fillfactor', label: 'Fill factor', min: 10, max: 100 },
    ],
  }),
];

export const CONSTRAINT_SECTIONS: readonly PropertyPanelSection<Constraint>[] = [
  propsSection<Constraint>({
    id: 'pg.constraint.check',
    title: 'Condition',
    order: 100,
    available: (caps) => hasConstraintKind(caps, 'check'),
    visibleFor: (constraint) => constraint.kind === 'check',
    controls: [
      {
        kind: 'text',
        name: 'expression',
        label: 'CHECK',
        multiline: true,
        placeholder: 'total >= 0',
      },
      { kind: 'boolean', name: 'noInherit', label: 'No inherit' },
    ],
  }),
  propsSection<Constraint>({
    id: 'pg.constraint.exclusion',
    title: 'Exclusion',
    order: 100,
    available: (caps) => hasConstraintKind(caps, 'exclusion'),
    visibleFor: (constraint) => constraint.kind === 'exclusion',
    controls: [
      { kind: 'text', name: 'expression', label: 'EXCLUDE', multiline: true },
      { kind: 'text', name: 'using', label: 'Using', placeholder: 'gist' },
    ],
  }),
  propsSection<Constraint>({
    id: 'pg.constraint.timing',
    title: 'Timing',
    order: 110,
    defaultCollapsed: true,
    visibleFor: (constraint) =>
      constraint.kind === 'primaryKey' ||
      constraint.kind === 'unique' ||
      constraint.kind === 'exclusion',
    controls: [
      { kind: 'boolean', name: 'deferrable', label: 'Deferrable' },
      { kind: 'boolean', name: 'initiallyDeferred', label: 'Initially deferred' },
    ],
  }),
];
