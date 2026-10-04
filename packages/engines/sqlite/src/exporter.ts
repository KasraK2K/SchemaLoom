import {
  EXPORT_PHASE_RANK,
  type Constraint,
  type Diagnostic,
  type Entity,
  type ExportInput,
  type ExportResult,
  type ExportStatement,
  type Exporter,
  type Field,
  type Id,
  type Index,
  type IrObjectType,
  type SchemaModel,
} from '@schemaloom/engine-sdk';
import { buildOrmExport, isOrmId } from '@schemaloom/orm';
import { CODE } from './messages.js';
import { ORM_DIALECT } from './orm-types.js';
import { quoteIdentifier as q } from './sqlite.js';
import { TYPE_CATALOG } from './types.js';

/**
 * Phase 13 §4.2 — SQLite DDL. Everything a table has is written inside its `CREATE TABLE`
 * (SQLite can't add a constraint later): columns, the primary key, uniques, checks and foreign
 * keys. Then indexes, then views. Docs become `--` lines (SQLite has no COMMENT).
 *
 * Same three properties as the other exporters: it takes a `RedactedModel`, it's deterministic
 * (explicit sort keys), and a hidden object sets `incomplete` with one header line, no count.
 * The three renderers are shared with the migration generator's table rebuilds.
 */

const REDACTION_NOTICE = '-- Some objects are not included because of your access level.';

const ACTION_SQL: Readonly<Record<string, string>> = {
  restrict: 'RESTRICT',
  cascade: 'CASCADE',
  setNull: 'SET NULL',
  setDefault: 'SET DEFAULT',
};

/** Byte comparison, NOT `localeCompare`: the output must not depend on the server's locale. */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const byName = <T extends { name: string; id: string }>(a: T, b: T) =>
  compare(a.name, b.name) || compare(a.id, b.id);

const str = (props: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const v = props[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
};

export function renderType(field: Field): string {
  return TYPE_CATALOG.format(
    TYPE_CATALOG.resolve(field.type, { customTypes: [], namespaceName: null }),
  );
}

/** The name the importer gives a primary key SQLite keeps no name for; the exporter writes a
 *  `CONSTRAINT` name only when it differs, so a round trip changes nothing. */
export const defaultPrimaryKeyName = (table: string): string => `${table}_pkey`;

/** What a renderer leaves out because the requester can't see it. */
export type Skip = (type: IrObjectType, id: Id, reason: string) => void;

function columnDefinition(field: Field, inlinePk: boolean): string {
  const p = field.propsRedacted === true ? {} : field.engineProps;
  const parts = [q(field.name), renderType(field)];
  if (inlinePk) {
    parts.push('PRIMARY KEY');
    if (p.autoIncrement === true) parts.push('AUTOINCREMENT');
  }
  if (!field.isNullable && !inlinePk) parts.push('NOT NULL');
  const collation = str(p, 'collation');
  if (collation !== undefined) parts.push(`COLLATE ${collation}`);
  const generated = str(p, 'generatedExpression');
  if (generated !== undefined) {
    parts.push(
      `GENERATED ALWAYS AS (${generated}) ${p.generatedKind === 'STORED' ? 'STORED' : 'VIRTUAL'}`,
    );
  } else {
    const dflt = str(p, 'default');
    if (dflt !== undefined) {
      parts.push(`DEFAULT ${/^[-\w.'"]+$|^\(.*\)$/s.test(dflt) ? dflt : `(${dflt})`}`);
    }
  }
  return parts.join(' ');
}

/** A table's visible columns, in order. */
export function columnsOf(model: SchemaModel, entityId: Id, skip?: Skip): Field[] {
  return Object.values(model.objects.field)
    .filter((f) => f.entityId === entityId)
    .filter((f) => {
      if (f.restricted !== true && f.name !== '') return true;
      skip?.('field', f.id, 'hidden from the requester');
      return false;
    })
    .sort((a, b) => a.ordinal - b.ordinal || compare(a.id, b.id));
}

export function createTableText(
  model: SchemaModel,
  table: Entity,
  options: { readonly name?: string; readonly ifNotExists?: boolean; readonly skip?: Skip } = {},
): string {
  const { skip } = options;
  const fieldById = new Map(Object.values(model.objects.field).map((f) => [f.id, f]));
  const columnList = (ids: readonly Id[]): string | null => {
    const names: string[] = [];
    for (const id of ids) {
      const f = fieldById.get(id);
      if (f === undefined || f.restricted === true) return null;
      names.push(q(f.name));
    }
    return names.join(', ');
  };
  const own = Object.values(model.objects.constraint)
    .filter((c) => c.entityId === table.id)
    .filter((c) => {
      if (c.restricted !== true) return true;
      skip?.('constraint', c.id, 'hidden from the requester');
      return false;
    })
    .sort(byName);
  const pk = own.find((c) => c.kind === 'primaryKey');
  const [pkOnly] = pk?.fieldIds ?? [];
  // `INTEGER PRIMARY KEY` inline keeps the rowid alias, and AUTOINCREMENT needs it there.
  const inline =
    pk?.fieldIds.length === 1 && pk.name === defaultPrimaryKeyName(table.name) ? pkOnly : undefined;
  const lines = columnsOf(model, table.id, skip).map((f) => columnDefinition(f, f.id === inline));
  const named = (c: Constraint, fallback: string) =>
    c.name === '' || c.name === fallback ? '' : `CONSTRAINT ${q(c.name)} `;
  for (const c of own) {
    if (c.kind === 'primaryKey' && inline === undefined) {
      const cols = columnList(c.fieldIds);
      if (cols === null) skip?.('constraint', c.id, 'it references a column not in this export');
      else lines.push(`${named(c, defaultPrimaryKeyName(table.name))}PRIMARY KEY (${cols})`);
    } else if (c.kind === 'unique') {
      const cols = columnList(c.fieldIds);
      if (cols === null) skip?.('constraint', c.id, 'it references a column not in this export');
      else lines.push(`UNIQUE (${cols})`);
    } else if (c.kind === 'check') {
      const body = c.propsRedacted === true ? undefined : str(c.engineProps, 'expression');
      if (body === undefined) skip?.('constraint', c.id, 'its body is hidden');
      else lines.push(`CONSTRAINT ${q(c.name)} CHECK (${body})`);
    }
  }
  const links = Object.values(model.objects.link)
    .filter((l) => l.kind === 'foreignKey' && l.from.entityId === table.id)
    .sort(byName);
  for (const l of links) {
    const parent = model.objects.entity[l.to.entityId];
    const from = columnList(l.from.fieldIds);
    const to = columnList(l.to.fieldIds);
    if (l.restricted === true) {
      skip?.('link', l.id, 'hidden from the requester');
      continue;
    }
    if (parent === undefined || parent.restricted === true || from === null || to === null) {
      skip?.('link', l.id, 'one of its sides is not in this export');
      continue;
    }
    const props = l.propsRedacted === true ? {} : l.engineProps;
    const del = ACTION_SQL[str(props, 'onDelete') ?? ''];
    const upd = ACTION_SQL[str(props, 'onUpdate') ?? ''];
    lines.push(
      [
        `FOREIGN KEY (${from}) REFERENCES ${q(parent.name)} (${to})`,
        del === undefined ? '' : ` ON DELETE ${del}`,
        upd === undefined ? '' : ` ON UPDATE ${upd}`,
        props.deferred === true ? ' DEFERRABLE INITIALLY DEFERRED' : '',
      ].join(''),
    );
  }
  const p = table.propsRedacted === true ? {} : table.engineProps;
  const tail = [p.strict === true ? 'STRICT' : '', p.withoutRowid === true ? 'WITHOUT ROWID' : '']
    .filter((x) => x !== '')
    .join(', ');
  const name = options.name ?? table.name;
  return `CREATE TABLE ${options.ifNotExists === true ? 'IF NOT EXISTS ' : ''}${q(name)} (\n  ${lines.join(',\n  ')}\n)${tail === '' ? '' : ` ${tail}`}`;
}

/** Null when a column or the predicate is hidden. */
export function createIndexText(
  model: SchemaModel,
  ix: Index,
  options: { readonly table?: string; readonly ifNotExists?: boolean } = {},
): string | null {
  const table = model.objects.entity[ix.entityId];
  if (table === undefined || table.restricted === true || ix.propsRedacted === true) return null;
  const cols: string[] = [];
  for (const c of [...ix.columns].sort((a, b) => a.ordinal - b.ordinal)) {
    const field = c.fieldId === null ? undefined : model.objects.field[c.fieldId];
    if (c.fieldId !== null && (field === undefined || field.restricted === true)) return null;
    const base = field === undefined ? c.expression : q(field.name);
    if (base === null || base === '') return null;
    const coll =
      typeof c.engineProps.collation === 'string' ? ` COLLATE ${c.engineProps.collation}` : '';
    cols.push(`${base}${coll}${c.direction === 'desc' ? ' DESC' : ''}`);
  }
  if (cols.length === 0) return null;
  const where = str(ix.engineProps, 'where');
  return `CREATE ${ix.isUnique ? 'UNIQUE ' : ''}INDEX ${options.ifNotExists === true ? 'IF NOT EXISTS ' : ''}${q(ix.name)} ON ${q(options.table ?? table.name)} (${cols.join(', ')})${where === undefined ? '' : ` WHERE ${where}`}`;
}

/** Null when the body is hidden or was never written. */
export function createViewText(view: Entity, ifNotExists = false): string | null {
  const body = view.propsRedacted === true ? undefined : str(view.engineProps, 'viewDefinition');
  if (body === undefined) return null;
  return `CREATE VIEW ${ifNotExists ? 'IF NOT EXISTS ' : ''}${q(view.name)} AS ${body}`;
}

export function buildExport(input: ExportInput): ExportResult {
  const { model, options } = input;
  const diagnostics: Diagnostic[] = [];
  let skipped = false as boolean;
  const skip: Skip = (type, id, reason) => {
    skipped = true;
    if (model.redacted) return;
    diagnostics.push({
      code: CODE.exportOmitted,
      severity: 'warning',
      params: { reason },
      target: { type, id },
    });
  };

  const entities = Object.values(model.objects.entity)
    .filter((e) => {
      if (e.restricted !== true) return true;
      skip('entity', e.id, 'hidden from the requester');
      return false;
    })
    .sort(byName);
  const statements: Omit<ExportStatement, 'ordinal'>[] = [];
  const ifNotExists = options.includeIfNotExists;

  for (const table of entities.filter((e) => e.kind === 'table')) {
    statements.push({
      phase: 'entities',
      kind: 'CREATE TABLE',
      text: createTableText(model, table, { ifNotExists, skip }),
      target: { type: 'entity', id: table.id },
    });
  }

  for (const ix of Object.values(model.objects.index).sort(byName)) {
    if (ix.restricted === true) {
      skip('index', ix.id, 'hidden from the requester');
      continue;
    }
    if (model.objects.entity[ix.entityId]?.restricted === true) continue;
    const text = createIndexText(model, ix, { ifNotExists });
    if (text === null) {
      skip('index', ix.id, 'it references something not in this export');
      continue;
    }
    statements.push({
      phase: 'indexes',
      kind: 'CREATE INDEX',
      text,
      target: { type: 'index', id: ix.id },
    });
  }

  for (const view of entities.filter((e) => e.kind === 'view')) {
    const text = createViewText(view, ifNotExists);
    if (text === null) {
      skip('entity', view.id, 'its definition is hidden or empty');
      continue;
    }
    // After the indexes: a view may read any table.
    statements.push({
      phase: 'footer',
      kind: 'CREATE VIEW',
      text,
      target: { type: 'entity', id: view.id },
    });
  }

  if (options.includeComments) {
    for (const entity of entities) {
      if (entity.doc !== null && entity.doc.excerpt !== '') {
        statements.push(
          comment(entity.name, entity.doc.excerpt, { type: 'entity', id: entity.id }),
        );
      }
      for (const field of columnsOf(model, entity.id)) {
        if (field.doc !== null && field.doc.excerpt !== '') {
          statements.push(
            comment(`${entity.name}.${field.name}`, field.doc.excerpt, {
              type: 'field',
              id: field.id,
            }),
          );
        }
      }
    }
  }

  if (options.includeDrops) {
    statements.unshift(
      ...entities.map((e): Omit<ExportStatement, 'ordinal'> => ({
        phase: 'drops',
        kind: e.kind === 'view' ? 'DROP VIEW' : 'DROP TABLE',
        text: `DROP ${e.kind === 'view' ? 'VIEW' : 'TABLE'} IF EXISTS ${q(e.name)}`,
        target: { type: 'entity', id: e.id },
      })),
    );
  }

  if (skipped) {
    statements.unshift({ phase: 'header', kind: 'comment', text: REDACTION_NOTICE, target: null });
  }
  const ordered = statements
    .map((s, i) => ({ s, i }))
    .sort((a, b) => EXPORT_PHASE_RANK[a.s.phase] - EXPORT_PHASE_RANK[b.s.phase] || a.i - b.i)
    .map(({ s }, ordinal) => ({ ...s, ordinal }));
  return { statements: ordered, separator: ';', incomplete: skipped, diagnostics };
}

function comment(
  name: string,
  doc: string,
  target: ExportStatement['target'],
): Omit<ExportStatement, 'ordinal'> {
  return {
    phase: 'comments',
    kind: 'comment',
    text: doc
      .split('\n')
      .map((line) => `-- ${name}: ${line}`.trimEnd())
      .join('\n'),
    target,
  };
}

export const EXPORTER: Exporter = {
  export(input) {
    const { format } = input.options;
    if (isOrmId(format)) return Promise.resolve(buildOrmExport(format, input, ORM_DIALECT));
    if (format !== 'ddl') return Promise.reject(new Error(`unknown export format “${format}”`));
    return Promise.resolve(buildExport(input));
  },
};
