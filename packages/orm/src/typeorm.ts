import type { ExportInput, ExportResult, ExportStatement, Field, Id } from '@schemaloom/engine-sdk';
import type { OrmDialect } from './dialect.js';
import { camelCase, Names, pascalCase, tsString } from './names.js';
import { classifyDefault, parentsFirst, planModels, type PlannedForeignKey } from './plan.js';
import { propString } from './util.js';

/**
 * Phase 8 §3.2 — `entities.ts` for TypeORM 0.3, shaped like `typeorm-model-generator`'s
 * output in one file: PascalCase classes, camelCase properties, a `@Column` per column and a
 * relation property on both sides of every foreign key. Classes refer to each other through
 * functions (`() => Customers`), so cycles work in any order.
 */

const REDACTION_NOTICE = '// Some objects are not included because of your access level.';

const ACTIONS: Readonly<Record<string, string>> = {
  restrict: 'RESTRICT',
  cascade: 'CASCADE',
  setNull: 'SET NULL',
  setDefault: 'SET DEFAULT',
};

const DECORATORS = [
  'Check',
  'Column',
  'ColumnType',
  'Entity',
  'Index',
  'JoinColumn',
  'ManyToOne',
  'OneToMany',
  'OneToOne',
  'PrimaryColumn',
  'PrimaryGeneratedColumn',
  'ViewColumn',
  'ViewEntity',
];

export function buildTypeormExport(input: ExportInput, dialect: OrmDialect): ExportResult {
  const { model, options } = input;
  const plan = planModels(model, dialect);
  const imports = new Set<string>();
  const use = (name: string): string => {
    imports.add(name);
    return name;
  };

  const fileNames = new Names(DECORATORS);
  const className = new Map<Id, string>();
  for (const owner of [...plan.tables, ...plan.views]) {
    className.set(owner.entity.id, fileNames.take(pascalCase(owner.entity.name)));
  }

  // Property names per class: columns first, then relations.
  const classNames = new Map<Id, Names>();
  const propName = new Map<Id, string>();
  for (const owner of [...plan.tables, ...plan.views]) {
    const names = new Names();
    for (const f of owner.fields) propName.set(f.id, names.take(camelCase(f.name)));
    classNames.set(owner.entity.id, names);
  }
  const prop = (id: Id): string => propName.get(id) ?? id;
  const suffix = (fk: PlannedForeignKey): string =>
    fk.ambiguous
      ? pascalCase(fk.fromIds.map((id) => plan.fieldById.get(id)?.name ?? '').join('_'))
      : '';
  const forwardName = new Map<PlannedForeignKey, string>();
  const backName = new Map<PlannedForeignKey, string>();
  for (const table of plan.tables) {
    for (const fk of table.outgoing) {
      forwardName.set(
        fk,
        classNames.get(table.entity.id)?.take(`${camelCase(fk.parent.entity.name)}${suffix(fk)}`) ??
          '',
      );
    }
  }
  for (const table of plan.tables) {
    for (const fk of table.incoming) {
      const base = `${camelCase(fk.child.entity.name)}${fk.child === fk.parent ? 'Children' : ''}${suffix(fk)}`;
      backName.set(fk, classNames.get(table.entity.id)?.take(base) ?? '');
    }
  }

  const tsType = (field: Field): string => {
    const type = dialect.columnType(field, model);
    let base: string;
    if (type.enumKey !== null) {
      const labels = plan.enums.find((e) => e.key === type.enumKey)?.labels ?? [];
      base = labels.length === 0 ? 'string' : labels.map(tsString).join(' | ');
    } else {
      base = dialect.types[type.id ?? '']?.ts ?? 'unknown';
    }
    if (type.dimensions > 0)
      base = `${base.includes(' ') ? `(${base})` : base}${'[]'.repeat(type.dimensions)}`;
    return field.isNullable ? `${base} | null` : base;
  };

  const columnOptions = (field: Field, extra: readonly string[]): string[] => {
    const type = dialect.columnType(field, model);
    const opts: string[] = [`name: ${tsString(field.name)}`];
    const entry = dialect.types[type.id ?? '']?.typeorm;
    if (type.enumKey !== null) {
      const e = plan.enums.find((x) => x.key === type.enumKey);
      opts.unshift(`type: 'enum'`);
      opts.push(`enum: [${(e?.labels ?? []).map(tsString).join(', ')}]`);
      if (dialect.namedEnums && e !== undefined) opts.push(`enumName: ${tsString(e.name)}`);
    } else if (entry !== undefined) {
      opts.unshift(`type: ${tsString(entry.type)}`);
      (entry.params ?? []).forEach((param, i) => {
        const arg = type.args?.[i];
        if (arg !== undefined)
          opts.push(`${param}: ${typeof arg === 'number' ? String(arg) : tsString(arg)}`);
      });
      if (entry.options !== undefined) opts.push(entry.options);
    } else {
      opts.unshift(`type: ${tsString(type.display)} as ${use('ColumnType')}`);
    }
    if (type.dimensions > 0) opts.push('array: true');
    if (field.isNullable) opts.push('nullable: true');
    const props = field.propsRedacted === true ? {} : field.engineProps;
    const generated = propString(props, 'generatedExpression');
    const expression = propString(props, 'default');
    if (generated !== undefined) {
      opts.push(`generatedType: 'STORED'`, `asExpression: ${tsString(generated)}`);
    } else if (expression !== undefined && !dialect.autoIncrement(field)) {
      const value = classifyDefault(expression);
      opts.push(
        `default: ${
          value.kind === 'number'
            ? value.text
            : value.kind === 'boolean'
              ? String(value.value)
              : value.kind === 'string'
                ? tsString(value.value)
                : `() => ${tsString(expression)}`
        }`,
      );
    }
    if (options.includeComments && field.doc !== null && field.doc.excerpt !== '') {
      opts.push(`comment: ${tsString(field.doc.excerpt)}`);
    }
    opts.push(...extra);
    return opts;
  };

  const statements: Omit<ExportStatement, 'ordinal'>[] = [];

  for (const table of parentsFirst(plan.tables)) {
    const cls = className.get(table.entity.id) ?? '';
    const lines: string[] = [];
    const quoteList = (ids: readonly Id[]) => `[${ids.map((id) => tsString(prop(id))).join(', ')}]`;
    for (const ix of table.indexes) {
      const method = ix.method;
      const spatial = method === 'fulltext' || method === 'spatial';
      if (ix.fieldIds === null || (method !== null && !spatial)) {
        lines.push(
          `// Left out: index ${tsString(ix.index.name)} (${ix.fieldIds === null ? 'its columns include an expression' : `TypeORM has no ${method ?? ''} index`})`,
        );
        continue;
      }
      const opts = [
        ix.index.isUnique ? 'unique: true' : null,
        spatial ? `${method}: true` : null,
        ix.where === undefined ? null : `where: ${tsString(ix.where)}`,
      ].filter((o) => o !== null);
      lines.push(
        `@${use('Index')}(${tsString(ix.index.name)}, ${quoteList(ix.fieldIds)}${opts.length > 0 ? `, { ${opts.join(', ')} }` : ''})`,
      );
    }
    for (const u of table.uniques) {
      lines.push(
        `@${use('Index')}(${tsString(u.name)}, ${quoteList(u.fieldIds)}, { unique: true })`,
      );
    }
    for (const c of table.checks)
      lines.push(`@${use('Check')}(${tsString(c.name)}, ${tsString(c.expression)})`);
    const entityOpts = [
      table.isDefaultNamespace ? null : `schema: ${tsString(table.namespace)}`,
      options.includeComments && table.entity.doc !== null && table.entity.doc.excerpt !== ''
        ? `comment: ${tsString(table.entity.doc.excerpt)}`
        : null,
    ].filter((o) => o !== null);
    lines.push(
      `@${use('Entity')}(${tsString(table.entity.name)}${entityOpts.length > 0 ? `, { ${entityOpts.join(', ')} }` : ''})`,
    );
    lines.push(`export class ${cls} {`);

    const pk = new Set(table.primaryKey?.fieldIds ?? []);
    const members: string[][] = [];
    for (const field of table.fields) {
      let decorator: string;
      if (pk.has(field.id) && pk.size === 1 && dialect.autoIncrement(field)) {
        const identity = field.propsRedacted !== true ? field.engineProps.identity : undefined;
        const opts = columnOptions(field, []).filter((o) => !o.startsWith('nullable'));
        decorator =
          identity === 'always' || identity === 'byDefault'
            ? `@${use('PrimaryGeneratedColumn')}('identity', { ${[...opts, `generatedIdentity: ${identity === 'always' ? "'ALWAYS'" : "'BY DEFAULT'"}`].join(', ')} })`
            : `@${use('PrimaryGeneratedColumn')}({ ${opts.join(', ')} })`;
      } else if (pk.has(field.id)) {
        decorator = `@${use('PrimaryColumn')}({ ${columnOptions(field, [])
          .filter((o) => !o.startsWith('nullable'))
          .join(', ')} })`;
      } else {
        decorator = `@${use('Column')}({ ${columnOptions(field, []).join(', ')} })`;
      }
      members.push([`  ${decorator}`, `  ${prop(field.id)}!: ${tsType(field)};`]);
    }

    for (const fk of table.outgoing) {
      const parent = className.get(fk.parent.entity.id) ?? '';
      const back = backName.get(fk) ?? '';
      const kind = use(fk.oneToOne ? 'OneToOne' : 'ManyToOne');
      const opts = [
        ACTIONS[fk.onDelete] === undefined
          ? null
          : `onDelete: ${tsString(ACTIONS[fk.onDelete] ?? '')}`,
        ACTIONS[fk.onUpdate] === undefined
          ? null
          : `onUpdate: ${tsString(ACTIONS[fk.onUpdate] ?? '')}`,
      ].filter((o) => o !== null);
      const join = fk.fromIds
        .map((id, i) => {
          const target = fk.toIds[i];
          return `{ name: ${tsString(plan.fieldById.get(id)?.name ?? '')}, referencedColumnName: ${tsString(target === undefined ? '' : prop(target))} }`;
        })
        .join(', ');
      members.push([
        `  @${kind}(() => ${parent}, (x) => x.${back}${opts.length > 0 ? `, { ${opts.join(', ')} }` : ''})`,
        `  @${use('JoinColumn')}([${join}])`,
        `  ${forwardName.get(fk) ?? ''}!: ${parent}${fk.optional ? ' | null' : ''};`,
      ]);
    }
    for (const fk of table.incoming) {
      const child = className.get(fk.child.entity.id) ?? '';
      const forward = forwardName.get(fk) ?? '';
      members.push(
        fk.oneToOne
          ? [
              `  @${use('OneToOne')}(() => ${child}, (x) => x.${forward})`,
              `  ${backName.get(fk) ?? ''}!: ${child} | null;`,
            ]
          : [
              `  @${use('OneToMany')}(() => ${child}, (x) => x.${forward})`,
              `  ${backName.get(fk) ?? ''}!: ${child}[];`,
            ],
      );
    }
    lines.push(members.map((m) => m.join('\n')).join('\n\n'), '}');
    statements.push({
      phase: 'entities',
      kind: 'entity',
      text: lines.join('\n'),
      target: { type: 'entity', id: table.entity.id },
    });
  }

  for (const view of plan.views) {
    const opts = [
      `name: ${tsString(view.entity.name)}`,
      view.isDefaultNamespace ? null : `schema: ${tsString(view.namespace)}`,
      view.materialized ? 'materialized: true' : null,
      view.definition === undefined ? null : `expression: ${tsString(view.definition)}`,
    ].filter((o) => o !== null);
    const members = view.fields.map((f) =>
      [
        `  @${use('ViewColumn')}({ name: ${tsString(f.name)} })`,
        `  ${prop(f.id)}!: ${tsType(f)};`,
      ].join('\n'),
    );
    statements.push({
      phase: 'entities',
      kind: 'view',
      text: [
        `@${use('ViewEntity')}({ ${opts.join(', ')} })`,
        ...(members.length === 0
          ? [`export class ${className.get(view.entity.id) ?? ''} {}`]
          : [`export class ${className.get(view.entity.id) ?? ''} {`, members.join('\n\n'), '}']),
      ].join('\n'),
      target: { type: 'entity', id: view.entity.id },
    });
  }

  const typeOnly = imports.delete('ColumnType');
  const header = [
    ...(plan.skipped ? [REDACTION_NOTICE] : []),
    `import { ${[...[...imports].sort(), ...(typeOnly ? ['type ColumnType'] : [])].join(', ')} } from 'typeorm';`,
  ];
  const all: ExportStatement[] = [
    { ordinal: 0, phase: 'header', kind: 'imports', text: header.join('\n'), target: null },
  ];
  for (const s of statements) all.push({ ...s, ordinal: all.length });
  return {
    statements: all,
    separator: '\n',
    incomplete: plan.skipped,
    diagnostics: plan.diagnostics,
  };
}
