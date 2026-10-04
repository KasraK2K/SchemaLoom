import type { ExportInput, ExportResult, ExportStatement, Field, Id } from '@schemaloom/engine-sdk';
import type { OrmDialect } from './dialect.js';
import { Names, pascalCase, pyString, pythonName } from './names.js';
import {
  parentsFirst,
  planModels,
  type PlannedForeignKey,
  type PlannedTable,
  type PlannedView,
} from './plan.js';

/**
 * Phase 8 §3.3 — `models.py` for Django 5.2, shaped like `manage.py inspectdb`'s output:
 * `managed = False` (Q3), field names from the column names, a foreign key named without its
 * `_id` (Django adds it back), models referring to each other by string name. Like
 * `inspectdb` it writes no defaults: a database default isn't a Django one.
 */

const HEADER = [
  '# Django models for the design, written by SchemaLoom in the style of `manage.py inspectdb`.',
  '# Every model is `managed = False`, so Django never creates, alters or drops these tables.',
  '# Remove those lines if Django should manage them.',
];
const REDACTION_NOTICE = '# Some objects are not included because of your access level.';

const ACTIONS: Readonly<Record<string, string>> = {
  noAction: 'models.DO_NOTHING',
  restrict: 'models.RESTRICT',
  cascade: 'models.CASCADE',
  setNull: 'models.SET_NULL',
  setDefault: 'models.SET_DEFAULT',
};

/** The auto-incrementing field for an integer field, when a column is serial or identity. */
const AUTO: Readonly<Record<string, string>> = {
  IntegerField: 'AutoField',
  BigIntegerField: 'BigAutoField',
  SmallIntegerField: 'SmallAutoField',
  PositiveIntegerField: 'AutoField',
  PositiveBigIntegerField: 'BigAutoField',
  PositiveSmallIntegerField: 'SmallAutoField',
};

/** Django checks index names against this. */
const MAX_INDEX_NAME = 30;

export function buildDjangoExport(input: ExportInput, dialect: OrmDialect): ExportResult {
  const { model, options } = input;
  const plan = planModels(model, dialect);
  const imports = new Set<string>(['from django.db import models']);

  const fileNames = new Names(['models', 'ArrayField']);
  const modelName = new Map<Id, string>();
  for (const owner of [...plan.tables, ...plan.views]) {
    modelName.set(owner.entity.id, fileNames.take(pascalCase(owner.entity.name)));
  }
  const choicesName = new Map<string, string>();
  for (const e of plan.enums) choicesName.set(e.key, fileNames.take(pascalCase(e.name)));

  // Field names per model. A single-column foreign key takes its column's name without `_id`.
  const fkByColumn = new Map<Id, PlannedForeignKey>();
  for (const table of plan.tables) {
    for (const fk of table.outgoing) {
      const [only] = fk.fromIds;
      if (fk.fromIds.length === 1 && only !== undefined && !fkByColumn.has(only))
        fkByColumn.set(only, fk);
    }
  }
  const fieldName = new Map<Id, string>();
  for (const owner of [...plan.tables, ...plan.views]) {
    const names = new Names(['pk']);
    for (const f of owner.fields) {
      const fk = fkByColumn.get(f.id);
      let name = pythonName(f.name);
      if (fk !== undefined && name.endsWith('_id') && name !== '_id') name = name.slice(0, -3);
      fieldName.set(f.id, names.take(name));
    }
  }
  const nameOf = (id: Id): string => fieldName.get(id) ?? id;

  /**
   * The one field Django treats as the primary key. Without a real one, `inspectdb`'s fallback
   * (the first single-column unique key on a NOT NULL column), then a column named `id`:
   * Django adds an `id` of its own to a model with no primary key, which would clash.
   */
  function primaryKeyField(owner: PlannedTable | PlannedView): Id | undefined {
    if ('primaryKey' in owner) {
      if (owner.primaryKey !== null) {
        return owner.primaryKey.fieldIds.length === 1 ? owner.primaryKey.fieldIds[0] : undefined;
      }
      const unique = owner.uniques.find(
        (u) =>
          u.fieldIds.length === 1 &&
          owner.fields.find((f) => f.id === u.fieldIds[0])?.isNullable === false,
      );
      if (unique !== undefined) return unique.fieldIds[0];
    }
    return owner.fields.find((f) => pythonName(f.name) === 'id')?.id;
  }

  /** `CharField` and its type arguments; a guess carries a note, as `inspectdb` does. */
  const fieldType = (field: Field): { head: string; args: string[]; note: string | null } => {
    const type = dialect.columnType(field, model);
    if (type.enumKey !== null) {
      const e = plan.enums.find((x) => x.key === type.enumKey);
      const longest = Math.max(1, ...(e?.labels ?? []).map((l) => l.length));
      return {
        head: 'CharField',
        args: [
          `max_length=${String(longest)}`,
          `choices=${choicesName.get(type.enumKey) ?? ''}.choices`,
        ],
        note: null,
      };
    }
    const entry = dialect.types[type.id ?? '']?.django;
    if (entry === undefined)
      return { head: 'TextField', args: [], note: 'This field type is a guess.' };
    const args = (entry.params ?? []).flatMap((param, i) => {
      const arg = type.args?.[i];
      return arg === undefined
        ? []
        : [`${param}=${typeof arg === 'number' ? String(arg) : pyString(arg)}`];
    });
    let head = entry.field;
    // A CharField needs a length; without one the column is unbounded text.
    if (head === 'CharField' && args.length === 0) head = 'TextField';
    if (head === 'DecimalField' && args.length === 0)
      args.push('max_digits=65535', 'decimal_places=65535');
    if (head === 'DecimalField' && args.length === 1) args.push('decimal_places=0');
    if (entry.options !== undefined) args.push(entry.options);
    return { head, args, note: null };
  };

  const docArg = (field: Field): string[] =>
    options.includeComments && field.doc !== null && field.doc.excerpt !== ''
      ? [`db_comment=${pyString(field.doc.excerpt)}`]
      : [];

  const statements: Omit<ExportStatement, 'ordinal'>[] = [];

  for (const e of plan.enums) {
    const members = new Names();
    const lines = [`class ${choicesName.get(e.key) ?? ''}(models.TextChoices):`];
    for (const label of e.labels) {
      let member = label.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
      if (!/^[A-Z_]/.test(member)) member = `V_${member}`;
      lines.push(`    ${members.take(member)} = ${pyString(label)}`);
    }
    statements.push({
      phase: 'custom-types',
      kind: 'choices',
      text: lines.join('\n'),
      target: e.target,
    });
  }

  for (const table of parentsFirst(plan.tables)) {
    statements.push({
      phase: 'entities',
      kind: 'model',
      text: renderModel(table),
      target: { type: 'entity', id: table.entity.id },
    });
  }
  for (const view of plan.views) {
    statements.push({
      phase: 'entities',
      kind: 'model',
      text: renderModel(view),
      target: { type: 'entity', id: view.entity.id },
    });
  }

  function renderModel(owner: PlannedTable | PlannedView): string {
    const table = 'primaryKey' in owner ? owner : null;
    const lines = [`class ${modelName.get(owner.entity.id) ?? ''}(models.Model):`];
    const doc = owner.entity.doc;
    if (table === null)
      lines.push(
        `    """A view.${options.includeComments && doc !== null && doc.excerpt !== '' ? ` ${doc.excerpt.replace(/"""/g, '\\"\\"\\"')}` : ''}"""`,
        '',
      );
    else if (options.includeComments && doc !== null && doc.excerpt !== '') {
      lines.push(`    """${doc.excerpt.replace(/"""/g, '\\"\\"\\"')}"""`, '');
    }
    if (table?.primaryKey === null && primaryKeyField(owner) === undefined) {
      lines.push('    # The table has no primary key; Django adds an `id` it does not have.');
    }
    if (table !== null && table.primaryKey !== null && table.primaryKey.fieldIds.length > 1) {
      lines.push(
        `    pk = models.CompositePrimaryKey(${table.primaryKey.fieldIds.map((id) => pyString(nameOf(id))).join(', ')})`,
      );
    }
    const pk = primaryKeyField(owner);
    const single = new Set<Id>();
    for (const u of table?.uniques ?? []) {
      const [only] = u.fieldIds;
      if (u.fieldIds.length === 1 && only !== undefined) single.add(only);
    }

    for (const field of owner.fields) {
      const name = nameOf(field.id);
      const fk = table === null ? undefined : fkByColumn.get(field.id);
      let head: string;
      const args: string[] = [];
      let note: string | null = null;
      if (fk !== undefined) {
        const oneToOne = fk.oneToOne || field.id === pk;
        head = `models.${oneToOne ? 'OneToOneField' : 'ForeignKey'}`;
        const target = fk.child === fk.parent ? 'self' : (modelName.get(fk.parent.entity.id) ?? '');
        args.push(pyString(target), ACTIONS[fk.onDelete] ?? 'models.DO_NOTHING');
        const to = fk.toIds[0];
        if (to !== undefined && to !== primaryKeyField(fk.parent)) {
          args.push(`to_field=${pyString(nameOf(to))}`);
        }
        if (fk.ambiguous) {
          args.push(`related_name=${pyString(`${pythonName(fk.child.entity.name)}_${name}_set`)}`);
        }
        // Django names the column `<field>_id`; anything else is spelled out.
        if (`${name}_id` !== field.name) args.push(`db_column=${pyString(field.name)}`);
      } else {
        const t = fieldType(field);
        note = t.note;
        const auto = field.id === pk && dialect.autoIncrement(field) ? AUTO[t.head] : undefined;
        const dims = dialect.columnType(field, model).dimensions;
        if (auto !== undefined) {
          head = `models.${auto}`;
        } else if (dims > 0) {
          imports.add('from django.contrib.postgres.fields import ArrayField');
          let inner = `models.${t.head}(${t.args.join(', ')})`;
          for (let i = 1; i < dims; i++) inner = `ArrayField(${inner})`;
          head = 'ArrayField';
          args.push(inner);
        } else {
          head = `models.${t.head}`;
          args.push(...t.args);
        }
        if (name !== field.name) args.push(`db_column=${pyString(field.name)}`);
      }
      if (field.id === pk) args.push('primary_key=True');
      else if (single.has(field.id) && fk === undefined) args.push('unique=True');
      if (field.isNullable && field.id !== pk) args.push('blank=True', 'null=True');
      args.push(...docArg(field));
      lines.push(`    ${name} = ${head}(${args.join(', ')})${note === null ? '' : `  # ${note}`}`);
    }

    // Composite foreign keys keep their plain columns; Django can't express them.
    for (const fk of table?.outgoing ?? []) {
      if (fk.fromIds.length > 1) {
        lines.push(
          `    # Foreign key ${pyString(fk.link.name)} on (${fk.fromIds.map(nameOf).join(', ')}) is not modelled: Django has no composite foreign key.`,
        );
      }
    }

    const meta = ['        managed = False'];
    const qualified = owner.isDefaultNamespace
      ? owner.entity.name
      : `"${owner.namespace}"."${owner.entity.name}"`;
    meta.push(`        db_table = ${pyString(qualified)}`);
    const constraints = (table?.uniques ?? [])
      .filter((u) => u.fieldIds.length > 1)
      .map(
        (u) =>
          `            models.UniqueConstraint(fields=[${u.fieldIds.map((id) => pyString(nameOf(id))).join(', ')}], name=${pyString(u.name)}),`,
      );
    if (constraints.length > 0) meta.push('        constraints = [', ...constraints, '        ]');
    const indexes: string[] = [];
    const leftOut: string[] = [];
    for (const ix of table?.indexes ?? []) {
      const name = ix.index.name;
      if (
        ix.fieldIds === null ||
        ix.where !== undefined ||
        ix.method !== null ||
        name.length > MAX_INDEX_NAME ||
        !/^[A-Za-z]/.test(name)
      ) {
        leftOut.push(
          `        # Index ${pyString(name)} is not listed: ${ix.fieldIds === null ? 'it indexes an expression' : ix.where !== undefined ? 'it is partial' : ix.method !== null ? `it is a ${ix.method} index` : `Django allows index names of up to ${String(MAX_INDEX_NAME)} characters`}.`,
        );
        continue;
      }
      const fields = ix.fieldIds
        .map((id) => pyString(`${ix.descending.has(id) ? '-' : ''}${nameOf(id)}`))
        .join(', ');
      indexes.push(`            models.Index(fields=[${fields}], name=${pyString(name)}),`);
    }
    if (indexes.length > 0) meta.push('        indexes = [', ...indexes, '        ]');
    meta.push(...leftOut);
    for (const c of table?.checks ?? [])
      meta.push(`        # CHECK ${pyString(c.name)}: ${c.expression.replace(/\n/g, ' ')}`);
    if (lines.at(-1) !== '') lines.push('');
    lines.push('    class Meta:', ...meta);
    return lines.join('\n');
  }

  const header = [...HEADER, ...(plan.skipped ? [REDACTION_NOTICE] : []), ...[...imports].sort()];
  const all: ExportStatement[] = [
    { ordinal: 0, phase: 'header', kind: 'imports', text: header.join('\n'), target: null },
  ];
  for (const s of statements) all.push({ ...s, ordinal: all.length });
  return {
    statements: all,
    separator: '\n\n',
    incomplete: plan.skipped,
    diagnostics: plan.diagnostics,
  };
}
