import { hasConstraintKind } from '@schemaloom/engine-sdk/ui';
import type { Constraint, Entity, Field, Index, Link } from '@schemaloom/schema-model';
import type { PropertyPanelSection } from '@schemaloom/engine-sdk/ui';
import { propsSection } from './props-section.js';

/**
 * MySQL's `engineProps` editors (design §3). Every section edits `engineProps` and nothing
 * else: core owns `name`, `kind`, `isNullable`, `columns`. `order` starts at 100, after core's.
 */

const REFERENTIAL_ACTIONS = ['noAction', 'restrict', 'cascade', 'setNull', 'setDefault'] as const;

export const ENTITY_SECTIONS: readonly PropertyPanelSection<Entity>[] = [
  propsSection<Entity>({
    id: 'mysql.table.storage',
    title: 'Storage',
    order: 200,
    defaultCollapsed: true,
    visibleFor: (entity) => entity.kind === 'table',
    controls: [
      { kind: 'text', name: 'engine', label: 'Engine', placeholder: 'InnoDB' },
      { kind: 'text', name: 'charset', label: 'Character set', placeholder: 'utf8mb4' },
      { kind: 'text', name: 'collation', label: 'Collation', placeholder: 'utf8mb4_0900_ai_ci' },
      {
        kind: 'enum',
        name: 'rowFormat',
        label: 'Row format',
        options: ['DEFAULT', 'DYNAMIC', 'FIXED', 'COMPRESSED', 'REDUNDANT', 'COMPACT'],
      },
    ],
  }),
  propsSection<Entity>({
    id: 'mysql.view.definition',
    title: 'Definition',
    order: 210,
    visibleFor: (entity) => entity.kind === 'view',
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
    id: 'mysql.view.options',
    title: 'Options',
    order: 220,
    defaultCollapsed: true,
    visibleFor: (entity) => entity.kind === 'view',
    controls: [
      {
        kind: 'enum',
        name: 'algorithm',
        label: 'Algorithm',
        options: ['UNDEFINED', 'MERGE', 'TEMPTABLE'],
      },
      { kind: 'enum', name: 'sqlSecurity', label: 'SQL security', options: ['DEFINER', 'INVOKER'] },
      { kind: 'enum', name: 'checkOption', label: 'Check option', options: ['LOCAL', 'CASCADED'] },
    ],
  }),
];

export const FIELD_SECTIONS: readonly PropertyPanelSection<Field>[] = [
  propsSection<Field>({
    id: 'mysql.column.value',
    title: 'Value',
    order: 100,
    controls: [
      { kind: 'boolean', name: 'unsigned', label: 'Unsigned' },
      { kind: 'boolean', name: 'autoIncrement', label: 'Auto increment' },
      {
        kind: 'text',
        name: 'default',
        label: 'Default',
        placeholder: "'active' or CURRENT_TIMESTAMP",
      },
      { kind: 'text', name: 'onUpdate', label: 'On update', placeholder: 'CURRENT_TIMESTAMP' },
    ],
  }),
  propsSection<Field>({
    id: 'mysql.column.generated',
    title: 'Generated',
    order: 105,
    defaultCollapsed: true,
    controls: [
      { kind: 'text', name: 'generatedExpression', label: 'Generated as' },
      { kind: 'enum', name: 'generatedKind', label: 'Stored as', options: ['VIRTUAL', 'STORED'] },
    ],
  }),
  propsSection<Field>({
    id: 'mysql.column.text',
    title: 'Text',
    order: 110,
    defaultCollapsed: true,
    controls: [
      { kind: 'text', name: 'charset', label: 'Character set' },
      { kind: 'text', name: 'collation', label: 'Collation' },
      { kind: 'boolean', name: 'invisible', label: 'Invisible (left out of SELECT *)' },
    ],
  }),
];

export const LINK_SECTIONS: readonly PropertyPanelSection<Link>[] = [
  propsSection<Link>({
    id: 'mysql.foreignKey.actions',
    title: 'Referential actions',
    order: 100,
    available: (caps) => caps.features.referentialActions,
    visibleFor: (link) => link.kind === 'foreignKey',
    controls: [
      { kind: 'enum', name: 'onDelete', label: 'On delete', options: REFERENTIAL_ACTIONS },
      { kind: 'enum', name: 'onUpdate', label: 'On update', options: REFERENTIAL_ACTIONS },
    ],
  }),
];

export const INDEX_SECTIONS: readonly PropertyPanelSection<Index>[] = [
  propsSection<Index>({
    id: 'mysql.index.options',
    title: 'Options',
    order: 110,
    defaultCollapsed: true,
    controls: [{ kind: 'boolean', name: 'invisible', label: 'Invisible to the optimizer' }],
  }),
];

export const CONSTRAINT_SECTIONS: readonly PropertyPanelSection<Constraint>[] = [
  propsSection<Constraint>({
    id: 'mysql.constraint.check',
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
      { kind: 'boolean', name: 'notEnforced', label: 'Not enforced' },
    ],
  }),
];
