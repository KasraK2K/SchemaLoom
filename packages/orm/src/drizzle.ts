import type {
  ExportInput,
  ExportResult,
  ExportStatement,
  Field,
  Id,
  IrObjectRef,
} from '@schemaloom/engine-sdk';
import type { OrmDialect, OrmEnum } from './dialect.js';
import { camelCase, jsDoc, Names, pascalCase, tsString, tsTemplate } from './names.js';
import {
  classifyDefault,
  parentsFirst,
  planModels,
  type PlannedForeignKey,
  type PlannedTable,
  type PlannedView,
} from './plan.js';
import { propString } from './util.js';

/**
 * Phase 8 §3.1 — `schema.ts` for Drizzle ORM 0.36+, shaped like `drizzle-kit pull`'s output,
 * with the relations at the end of the same file (Q1).
 *
 * Foreign keys go in the table callback as `foreignKey({ …, name })`, so their names survive.
 * The one exception is a reference to a table declared further down that refers back (a
 * cycle): TypeScript can't infer two consts from each other, so that column uses
 * `.references((): AnyPgColumn => …)`, which Drizzle names itself.
 */

const REDACTION_NOTICE = '// Some objects are not included because of your access level.';

const ACTIONS: Readonly<Record<string, string>> = {
  restrict: 'restrict',
  cascade: 'cascade',
  setNull: 'set null',
  setDefault: 'set default',
};

export function buildDrizzleExport(input: ExportInput, dialect: OrmDialect): ExportResult {
  const { model, options } = input;
  const plan = planModels(model, dialect);
  const { prefix, core } = dialect.drizzle;
  const comments = options.includeComments;

  const coreImports = new Set<string>();
  const ormImports = new Set<string>();
  const useCore = (name: string): string => {
    coreImports.add(name);
    return name;
  };
  const sqlText = (text: string): string => {
    ormImports.add('sql');
    return `sql\`${tsTemplate(text)}\``;
  };

  // File-scope names: every builder this file could import is taken first, then schemas,
  // tables, views and enums, in that order of precedence.
  const builders = [
    'sql',
    'relations',
    'index',
    'uniqueIndex',
    'unique',
    'primaryKey',
    'foreignKey',
    'check',
    'customType',
    `${prefix}Table`,
    `${prefix}Schema`,
    `${prefix}Enum`,
    `${prefix}View`,
    `${prefix}MaterializedView`,
    `Any${prefix === 'pg' ? 'Pg' : prefix === 'mysql' ? 'MySql' : 'SQLite'}Column`,
    ...Object.values(dialect.types).flatMap((t) => (t.drizzle === undefined ? [] : [t.drizzle.fn])),
  ];
  const fileNames = new Names(builders);
  const schemaVar = new Map<string, string>();
  for (const owner of [...plan.tables, ...plan.views]) {
    if (owner.isDefaultNamespace || schemaVar.has(owner.namespace)) continue;
    schemaVar.set(owner.namespace, fileNames.take(camelCase(owner.namespace)));
  }
  const tableVar = new Map<Id, string>();
  for (const t of plan.tables) tableVar.set(t.entity.id, fileNames.take(camelCase(t.entity.name)));
  for (const v of plan.views) tableVar.set(v.entity.id, fileNames.take(camelCase(v.entity.name)));
  const enumVar = new Map<string, string>();
  for (const e of dialect.namedEnums ? plan.enums : []) {
    enumVar.set(e.key, fileNames.take(`${camelCase(e.name)}Enum`));
  }
  const enumByKey = new Map<string, OrmEnum>(plan.enums.map((e) => [e.key, e]));

  // A table's column keys, and its relation names after them.
  const columnKeys = new Map<Id, Map<Id, string>>();
  const relationNames = new Map<Id, Names>();
  for (const owner of [...plan.tables, ...plan.views]) {
    const names = new Names();
    columnKeys.set(
      owner.entity.id,
      new Map(owner.fields.map((f) => [f.id, names.take(camelCase(f.name))])),
    );
    relationNames.set(owner.entity.id, names);
  }
  const key = (field: Field): string =>
    columnKeys.get(field.entityId)?.get(field.id) ?? camelCase(field.name);

  /** `integer('id')`, with the type's options; no modifiers. */
  const builder = (field: Field): string => {
    const type = dialect.columnType(field, model);
    const name = tsString(field.name);
    if (type.enumKey !== null) {
      const variable = enumVar.get(type.enumKey);
      const labels = enumByKey.get(type.enumKey)?.labels ?? [];
      if (variable !== undefined) return `${variable}(${name})`;
      if (prefix === 'mysql')
        return `${useCore('mysqlEnum')}(${name}, [${labels.map(tsString).join(', ')}])`;
      return `${useCore('text')}(${name}, { enum: [${labels.map(tsString).join(', ')}] })`;
    }
    const entry = dialect.types[type.id ?? '']?.drizzle;
    const arrays = prefix === 'pg' ? type.dimensions : 0;
    if (entry === undefined || type.dimensions > 2 || (prefix !== 'pg' && type.dimensions > 0)) {
      return `${useCore('customType')}<{ data: unknown }>({ dataType: () => ${tsString(type.display)} })(${name})`;
    }
    const opts = [
      ...(entry.params ?? []).flatMap((param, i) => {
        const arg = type.args?.[i];
        return arg === undefined
          ? []
          : [`${param}: ${typeof arg === 'number' ? String(arg) : tsString(arg)}`];
      }),
      ...(entry.options === undefined ? [] : [entry.options]),
    ];
    const call = `${useCore(entry.fn)}(${name}${opts.length > 0 ? `, { ${opts.join(', ')} }` : ''})`;
    return call + '.array()'.repeat(arrays);
  };

  const defaultCall = (field: Field): string | null => {
    const props = field.propsRedacted === true ? {} : field.engineProps;
    const expression = propString(props, 'default');
    if (expression === undefined) return null;
    const type = dialect.columnType(field, model);
    const ts = type.enumKey !== null ? 'string' : dialect.types[type.id ?? '']?.ts;
    const value = classifyDefault(expression);
    if (type.dimensions === 0) {
      if (value.kind === 'number' && ts === 'number') return `.default(${value.text})`;
      if (value.kind === 'boolean' && ts === 'boolean') return `.default(${String(value.value)})`;
      if (value.kind === 'string' && ts === 'string') return `.default(${tsString(value.value)})`;
    }
    return `.default(${sqlText(expression)})`;
  };

  // A reference to a table declared later that refers back can't be a `foreignKey` (§ above).
  const order = parentsFirst(plan.tables);
  const position = new Map(order.map((t, i) => [t.entity.id, i]));
  const isBackEdge = (fk: PlannedForeignKey): boolean =>
    fk.child !== fk.parent &&
    (position.get(fk.parent.entity.id) ?? 0) > (position.get(fk.child.entity.id) ?? 0);
  const anyColumn = `Any${prefix === 'pg' ? 'Pg' : prefix === 'mysql' ? 'MySql' : 'SQLite'}Column`;

  const statements: Omit<ExportStatement, 'ordinal'>[] = [];
  const push = (
    phase: ExportStatement['phase'],
    kind: string,
    text: string,
    target: IrObjectRef | null,
  ) => statements.push({ phase, kind, text, target });

  for (const [ns, variable] of schemaVar) {
    push(
      'namespaces',
      'schema',
      `export const ${variable} = ${useCore(`${prefix}Schema`)}(${tsString(ns)});`,
      null,
    );
  }

  for (const e of plan.enums) {
    const variable = enumVar.get(e.key);
    if (variable === undefined) continue;
    const ns = e.namespaceId === null ? undefined : model.objects.namespace[e.namespaceId];
    const owner = ns === undefined || ns.isDefault ? undefined : schemaVar.get(ns.name);
    const call = owner === undefined ? useCore(`${prefix}Enum`) : `${owner}.enum`;
    push(
      'custom-types',
      'enum',
      `export const ${variable} = ${call}(${tsString(e.name)}, [${e.labels.map(tsString).join(', ')}]);`,
      e.target,
    );
  }

  for (const table of order) {
    push('entities', 'table', renderTable(table), { type: 'entity', id: table.entity.id });
  }
  for (const view of plan.views) {
    push('entities', 'view', renderView(view), { type: 'entity', id: view.entity.id });
  }

  const relationBlocks = plan.tables.flatMap((t) => {
    const text = renderRelations(t);
    return text === null ? [] : [{ t, text }];
  });
  for (const { t, text } of relationBlocks) {
    push('footer', 'relations', text, { type: 'entity', id: t.entity.id });
  }

  function renderTable(table: PlannedTable): string {
    const variable = tableVar.get(table.entity.id) ?? '';
    const pk = table.primaryKey;
    const singlePk = pk !== null && pk.fieldIds.length === 1 ? pk.fieldIds[0] : undefined;
    const singleUnique = new Map<Id, string>();
    for (const u of table.uniques) {
      const [only] = u.fieldIds;
      if (u.fieldIds.length === 1 && only !== undefined && !singleUnique.has(only))
        singleUnique.set(only, u.name);
    }
    const backRefs = new Map<Id, PlannedForeignKey>();
    for (const fk of table.outgoing) {
      const [only] = fk.fromIds;
      if (isBackEdge(fk) && fk.fromIds.length === 1 && only !== undefined) backRefs.set(only, fk);
    }

    const lines: string[] = [];
    for (const field of table.fields) {
      if (comments) lines.push(...jsDoc(field.doc, '    '));
      let chain = builder(field);
      const props = field.propsRedacted === true ? {} : field.engineProps;
      if (dialect.autoIncrement(field)) {
        if (props.identity === 'always') chain += '.generatedAlwaysAsIdentity()';
        else if (props.identity === 'byDefault') chain += '.generatedByDefaultAsIdentity()';
        else if (prefix === 'mysql') chain += '.autoincrement()';
      }
      if (field.id === singlePk) {
        chain +=
          prefix === 'sqlite' && dialect.autoIncrement(field)
            ? '.primaryKey({ autoIncrement: true })'
            : '.primaryKey()';
      } else if (!field.isNullable) {
        chain += '.notNull()';
      }
      const unique = singleUnique.get(field.id);
      if (unique !== undefined) chain += `.unique(${tsString(unique)})`;
      const generated = propString(props, 'generatedExpression');
      if (generated !== undefined) chain += `.generatedAlwaysAs(${sqlText(generated)})`;
      else {
        const d = defaultCall(field);
        if (d !== null) chain += d;
      }
      const back = backRefs.get(field.id);
      if (back !== undefined) {
        const target = back.parent.fields.find((f) => f.id === back.toIds[0]);
        const actions = [
          ACTIONS[back.onDelete] === undefined
            ? null
            : `onDelete: ${tsString(ACTIONS[back.onDelete] ?? '')}`,
          ACTIONS[back.onUpdate] === undefined
            ? null
            : `onUpdate: ${tsString(ACTIONS[back.onUpdate] ?? '')}`,
        ].filter((a) => a !== null);
        coreImports.add(anyColumn);
        chain += `.references((): ${anyColumn} => ${tableVar.get(back.parent.entity.id) ?? ''}.${target === undefined ? 'id' : key(target)}${actions.length > 0 ? `, { ${actions.join(', ')} }` : ''})`;
      }
      lines.push(`    ${key(field)}: ${chain},`);
    }

    const col = (id: Id): string => {
      const field = plan.fieldById.get(id);
      return `table.${field === undefined ? id : key(field)}`;
    };
    const extra: string[] = [];
    if (pk !== null && pk.fieldIds.length > 1) {
      extra.push(
        `${useCore('primaryKey')}({ columns: [${pk.fieldIds.map(col).join(', ')}], name: ${tsString(pk.name)} })`,
      );
    }
    for (const u of table.uniques) {
      if (u.fieldIds.length > 1)
        extra.push(
          `${useCore('unique')}(${tsString(u.name)}).on(${u.fieldIds.map(col).join(', ')})`,
        );
    }
    for (const ix of table.indexes) {
      const leftOut =
        ix.fieldIds === null
          ? 'its columns include an expression'
          : prefix === 'mysql' && ix.method !== null
            ? `${ix.method.toUpperCase()} indexes are not supported by Drizzle`
            : null;
      if (leftOut !== null || ix.fieldIds === null) {
        extra.push(`// Left out: index ${tsString(ix.index.name)} (${leftOut ?? ''})`);
        continue;
      }
      const columns = ix.fieldIds
        .map((id) => `${col(id)}${ix.descending.has(id) && prefix === 'pg' ? '.desc()' : ''}`)
        .join(', ');
      const kind = useCore(ix.index.isUnique ? 'uniqueIndex' : 'index');
      const on =
        prefix === 'pg' && ix.method !== null
          ? `.using(${tsString(ix.method)}, ${columns})`
          : `.on(${columns})`;
      extra.push(
        `${kind}(${tsString(ix.index.name)})${on}${ix.where === undefined ? '' : `.where(${sqlText(ix.where)})`}`,
      );
    }
    for (const fk of table.outgoing) {
      if (isBackEdge(fk)) {
        if (fk.fromIds.length > 1) {
          extra.push(
            `// Left out: foreign key ${tsString(fk.link.name)} (it closes a cycle of references)`,
          );
        }
        continue;
      }
      const parent = fk.child === fk.parent ? 'table' : (tableVar.get(fk.parent.entity.id) ?? '');
      const target = (id: Id): string => {
        const field = plan.fieldById.get(id);
        return `${parent}.${field === undefined ? id : key(field)}`;
      };
      let text = `${useCore('foreignKey')}({ columns: [${fk.fromIds.map(col).join(', ')}], foreignColumns: [${fk.toIds.map(target).join(', ')}], name: ${tsString(fk.link.name)} })`;
      const del = ACTIONS[fk.onDelete];
      const upd = ACTIONS[fk.onUpdate];
      if (del !== undefined) text += `.onDelete(${tsString(del)})`;
      if (upd !== undefined) text += `.onUpdate(${tsString(upd)})`;
      extra.push(text);
    }
    for (const c of table.checks)
      extra.push(`${useCore('check')}(${tsString(c.name)}, ${sqlText(c.expression)})`);

    const owner = table.isDefaultNamespace ? undefined : schemaVar.get(table.namespace);
    const call = owner === undefined ? useCore(`${prefix}Table`) : `${owner}.table`;
    const head = [
      ...(comments ? jsDoc(table.entity.doc, '') : []),
      `export const ${variable} = ${call}(`,
    ];
    const body = [`  ${tsString(table.entity.name)},`, '  {', ...lines, '  },'];
    if (extra.length > 0) {
      body.push(
        '  (table) => [',
        ...extra.map((e) => (e.startsWith('//') ? `    ${e}` : `    ${e},`)),
        '  ],',
      );
    }
    return [...head, ...body, ');'].join('\n');
  }

  function renderView(view: PlannedView): string {
    const variable = tableVar.get(view.entity.id) ?? '';
    const owner = view.isDefaultNamespace ? undefined : schemaVar.get(view.namespace);
    const kind = view.materialized ? 'MaterializedView' : 'View';
    const call =
      owner === undefined
        ? useCore(`${prefix}${kind}`)
        : `${owner}.${view.materialized ? 'materializedView' : 'view'}`;
    const columns = view.fields.map((f) => `  ${key(f)}: ${builder(f)},`);
    const tail = view.definition === undefined ? '.existing()' : `.as(${sqlText(view.definition)})`;
    const head = `export const ${variable} = ${call}(${tsString(view.entity.name)}, {`;
    return [
      ...(comments ? jsDoc(view.entity.doc, '') : []),
      ...(columns.length === 0 ? [`${head}})${tail};`] : [head, ...columns, `})${tail};`]),
    ].join('\n');
  }

  function renderRelations(table: PlannedTable): string | null {
    const names = relationNames.get(table.entity.id) ?? new Names();
    const variable = tableVar.get(table.entity.id) ?? '';
    const entries: string[] = [];
    const used = new Set<'one' | 'many'>();
    const relationName = (fk: PlannedForeignKey) =>
      fk.ambiguous ? `, relationName: ${tsString(fk.link.name)}` : '';
    const suffix = (fk: PlannedForeignKey) =>
      fk.ambiguous
        ? pascalCase(fk.fromIds.map((id) => plan.fieldById.get(id)?.name ?? '').join('_'))
        : '';
    const fieldKey = (id: Id) => {
      const field = plan.fieldById.get(id);
      return field === undefined ? id : key(field);
    };
    for (const fk of table.outgoing) {
      const parent = tableVar.get(fk.parent.entity.id) ?? '';
      const name = names.take(`${camelCase(fk.parent.entity.name)}${suffix(fk)}`);
      used.add('one');
      entries.push(
        `  ${name}: one(${parent}, { fields: [${fk.fromIds.map((id) => `${variable}.${fieldKey(id)}`).join(', ')}], references: [${fk.toIds.map((id) => `${parent}.${fieldKey(id)}`).join(', ')}]${relationName(fk)} }),`,
      );
    }
    for (const fk of table.incoming) {
      const child = tableVar.get(fk.child.entity.id) ?? '';
      const name = names.take(
        `${camelCase(fk.child.entity.name)}${fk.child === fk.parent ? 'Children' : ''}${suffix(fk)}`,
      );
      const kind = fk.oneToOne ? 'one' : 'many';
      used.add(kind);
      const named = fk.ambiguous ? `, { relationName: ${tsString(fk.link.name)} }` : '';
      entries.push(`  ${name}: ${kind}(${child}${named}),`);
    }
    if (entries.length === 0) return null;
    ormImports.add('relations');
    const args = [...used].sort().join(', ');
    return [
      `export const ${variable}Relations = relations(${variable}, ({ ${args} }) => ({`,
      ...entries,
      '}));',
    ].join('\n');
  }

  // --- imports, then everything in order ------------------------------------------------
  const header: string[] = [];
  if (plan.skipped) header.push(REDACTION_NOTICE);
  if (ormImports.size > 0)
    header.push(`import { ${[...ormImports].sort().join(', ')} } from 'drizzle-orm';`);
  const typeOnly = coreImports.has(anyColumn);
  coreImports.delete(anyColumn);
  const coreList = [...[...coreImports].sort(), ...(typeOnly ? [`type ${anyColumn}`] : [])];
  if (coreList.length > 0)
    header.push(`import { ${coreList.join(', ')} } from 'drizzle-orm/${core}';`);

  const all: ExportStatement[] = [];
  if (header.length > 0)
    all.push({
      ordinal: 0,
      phase: 'header',
      kind: 'imports',
      text: header.join('\n'),
      target: null,
    });
  for (const s of statements) all.push({ ...s, ordinal: all.length });
  return {
    statements: all,
    separator: '\n',
    incomplete: plan.skipped,
    diagnostics: plan.diagnostics,
  };
}
