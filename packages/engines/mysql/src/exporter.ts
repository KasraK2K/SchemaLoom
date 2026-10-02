import type {
  Constraint,
  Diagnostic,
  EngineProps,
  Entity,
  ExportInput,
  ExportPhase,
  ExportResult,
  ExportStatement,
  Exporter,
  Field,
  Id,
  Index,
  IndexColumn,
  IrObjectRef,
  IrObjectType,
  Link,
} from '@schemaloom/engine-sdk';
import { EXPORT_PHASE_RANK } from '@schemaloom/engine-sdk';
import { CAPABILITIES } from './capabilities.js';
import { CODE } from './messages.js';
import { TYPE_CATALOG } from './types.js';

/**
 * MySQL DDL export (doc 03 §10, design §4). The shape follows `SHOW CREATE TABLE`: columns,
 * keys, indexes, checks and comments inline in one `CREATE TABLE`, so an export reads back
 * through the importer unchanged. Foreign keys are separate `ALTER TABLE … ADD CONSTRAINT`
 * statements in the constraints phase, so tables that reference each other still load.
 *
 * Redaction (§10.3): a stub table, a masked column and a badge-only index or constraint are
 * skipped, `propsRedacted` exports the object without its props, and one header line says
 * the export is incomplete — never which objects or how many.
 */

const REDACTION_NOTICE = '-- Some objects are not included because of your access level.';

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const quoteIdentifier = (name: string): string => `\`${name.replace(/`/g, '``')}\``;
export const quoteString = (text: string): string =>
  `'${text.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;

const propsOf = (object: { engineProps: EngineProps; propsRedacted?: true }): EngineProps =>
  object.propsRedacted === true ? {} : object.engineProps;
const str = (props: EngineProps, key: string): string | undefined => {
  const v = props[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
};
const flag = (props: EngineProps, key: string): boolean => props[key] === true;

const ACTION_SQL: Readonly<Record<string, string>> = {
  noAction: 'NO ACTION',
  restrict: 'RESTRICT',
  cascade: 'CASCADE',
  setNull: 'SET NULL',
  setDefault: 'SET DEFAULT',
};

export function renderType(field: Field): string {
  const name = field.type.name.toLowerCase();
  if (name === 'enum' || name === 'set') {
    return `${name}(${(field.type.args ?? []).map((v) => quoteString(String(v))).join(',')})`;
  }
  return TYPE_CATALOG.format(
    TYPE_CATALOG.resolve(field.type, { customTypes: [], namespaceName: null }),
  );
}

export function columnDefinition(field: Field, comment: string | undefined): string {
  const p = propsOf(field);
  const parts = [quoteIdentifier(field.name), renderType(field)];
  if (flag(p, 'unsigned')) parts.push('unsigned');
  if (flag(p, 'zerofill')) parts.push('zerofill');
  const charset = str(p, 'charset');
  if (charset !== undefined) parts.push(`CHARACTER SET ${charset}`);
  const collation = str(p, 'collation');
  if (collation !== undefined) parts.push(`COLLATE ${collation}`);
  const generated = str(p, 'generatedExpression');
  if (generated !== undefined) {
    parts.push(`GENERATED ALWAYS AS (${generated}) ${str(p, 'generatedKind') ?? 'VIRTUAL'}`);
  }
  parts.push(field.isNullable ? 'NULL' : 'NOT NULL');
  const def = str(p, 'default');
  if (def !== undefined && generated === undefined) parts.push(`DEFAULT ${def}`);
  const onUpdate = str(p, 'onUpdate');
  if (onUpdate !== undefined) parts.push(`ON UPDATE ${onUpdate}`);
  if (flag(p, 'autoIncrement')) parts.push('AUTO_INCREMENT');
  if (flag(p, 'invisible')) parts.push('INVISIBLE');
  if (typeof p.srid === 'number') parts.push(`SRID ${String(p.srid)}`);
  if (comment !== undefined) parts.push(`COMMENT ${quoteString(comment)}`);
  return parts.join(' ');
}

function keyPart(column: IndexColumn, fields: ReadonlyMap<Id, Field>): string | null {
  const direction = column.direction === 'desc' ? ' DESC' : '';
  if (column.expression !== null) return `(${column.expression})${direction}`;
  const field = column.fieldId === null ? undefined : fields.get(column.fieldId);
  if (field === undefined) return null;
  const length = column.engineProps.length;
  return `${quoteIdentifier(field.name)}${typeof length === 'number' ? `(${String(length)})` : ''}${direction}`;
}

function indexDefinition(index: Index, fields: ReadonlyMap<Id, Field>): string | null {
  const parts: string[] = [];
  for (const column of [...index.columns].sort((a, b) => a.ordinal - b.ordinal)) {
    if (column.role !== 'key') continue;
    const part = keyPart(column, fields);
    if (part === null) return null;
    parts.push(part);
  }
  if (parts.length === 0) return null;
  const lead =
    index.kind === 'fulltext'
      ? 'FULLTEXT KEY'
      : index.kind === 'spatial'
        ? 'SPATIAL KEY'
        : index.isUnique
          ? 'UNIQUE KEY'
          : 'KEY';
  const invisible = flag(propsOf(index), 'invisible') ? ' INVISIBLE' : '';
  return `${lead} ${quoteIdentifier(index.name)} (${parts.join(',')})${invisible}`;
}

function constraintDefinition(
  constraint: Constraint,
  fields: ReadonlyMap<Id, Field>,
): string | null {
  const columns: string[] = [];
  for (const id of constraint.fieldIds) {
    const field = fields.get(id);
    if (field === undefined) return null;
    columns.push(quoteIdentifier(field.name));
  }
  if (constraint.kind === 'primaryKey')
    return columns.length === 0 ? null : `PRIMARY KEY (${columns.join(',')})`;
  if (constraint.kind === 'unique') {
    return columns.length === 0
      ? null
      : `UNIQUE KEY ${quoteIdentifier(constraint.name)} (${columns.join(',')})`;
  }
  if (constraint.kind === 'check') {
    const p = propsOf(constraint);
    const expression = str(p, 'expression');
    if (expression === undefined) return null;
    return `CONSTRAINT ${quoteIdentifier(constraint.name)} CHECK (${expression})${flag(p, 'notEnforced') ? ' NOT ENFORCED' : ''}`;
  }
  return null;
}

function tableOptions(props: EngineProps, comment: string | undefined): string {
  const out: string[] = [];
  out.push(`ENGINE=${str(props, 'engine') ?? 'InnoDB'}`);
  const charset = str(props, 'charset');
  if (charset !== undefined) out.push(`DEFAULT CHARSET=${charset}`);
  const collation = str(props, 'collation');
  if (collation !== undefined) out.push(`COLLATE=${collation}`);
  const rowFormat = str(props, 'rowFormat');
  if (rowFormat !== undefined) out.push(`ROW_FORMAT=${rowFormat}`);
  if (comment !== undefined) out.push(`COMMENT=${quoteString(comment)}`);
  return out.join(' ');
}

/** Dependency depth over `refs.entityIds`: a table before the view selecting from it. */
function entityDepths(entities: readonly Entity[]): ReadonlyMap<Id, number> {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const depths = new Map<Id, number>();
  const visiting = new Set<Id>();
  const depthOf = (id: Id): number => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let depth = 0;
    for (const dep of byId.get(id)?.refs?.entityIds ?? []) {
      if (dep !== id && byId.has(dep)) depth = Math.max(depth, depthOf(dep) + 1);
    }
    visiting.delete(id);
    depths.set(id, depth);
    return depth;
  };
  for (const entity of entities) depthOf(entity.id);
  return depths;
}

interface Pending {
  readonly phase: ExportPhase;
  readonly kind: string;
  readonly text: string;
  readonly target: IrObjectRef | null;
  readonly rank: number;
  readonly sort: string;
}

function buildExport(input: ExportInput): ExportResult {
  const { model, options } = input;
  const pending: Pending[] = [];
  const diagnostics: Diagnostic[] = [];
  const state = { skipped: false };
  const skip = (type: IrObjectType, id: Id, reason: string) => {
    state.skipped = true;
    if (model.redacted) return; // §10.3 rule 4: no per-object notice on a redacted model
    diagnostics.push({
      code: CODE.exportOmitted,
      severity: 'warning',
      params: { reason },
      target: { type, id },
    });
  };
  const comments = options.includeComments && CAPABILITIES.features.comments;
  const docText = (o: { doc: { excerpt: string } | null }) =>
    comments && o.doc !== null ? o.doc.excerpt : undefined;
  const sorted = <T extends { id: Id }>(bag: Record<Id, T>): readonly T[] =>
    Object.values(bag).sort((a, b) => compare(a.id, b.id));

  const fieldsByEntity = new Map<Id, Field[]>();
  for (const field of sorted(model.objects.field)) {
    const bucket = fieldsByEntity.get(field.entityId) ?? [];
    bucket.push(field);
    fieldsByEntity.set(field.entityId, bucket);
  }

  const candidates: Entity[] = [];
  for (const entity of sorted(model.objects.entity)) {
    if (entity.restricted === true) skip('entity', entity.id, 'hidden from the requester');
    else if (entity.kind !== 'table' && entity.kind !== 'view')
      skip('entity', entity.id, `unknown entity kind “${entity.kind}”`);
    else candidates.push(entity);
  }
  const depths = entityDepths(candidates);
  const emittedEntities = new Map<Id, Entity>();
  const emittedFields = new Map<Id, Field>();

  for (const entity of candidates) {
    const props = propsOf(entity);
    const rank = depths.get(entity.id) ?? 0;
    const visible: Field[] = [];
    for (const field of (fieldsByEntity.get(entity.id) ?? []).sort(
      (a, b) => a.ordinal - b.ordinal || compare(a.id, b.id),
    )) {
      if (field.restricted === true || field.name === '')
        skip('field', field.id, 'hidden from the requester');
      else visible.push(field);
    }
    const fields = new Map(visible.map((f) => [f.id, f]));

    if (entity.kind === 'table') {
      const lines = visible.map((f) => columnDefinition(f, undefined));
      for (const constraint of sorted(model.objects.constraint)) {
        if (constraint.entityId !== entity.id) continue;
        if (constraint.restricted === true) {
          skip('constraint', constraint.id, 'hidden from the requester');
          continue;
        }
        const line = constraintDefinition(constraint, fields);
        if (line === null)
          skip('constraint', constraint.id, 'it references a column not in this export');
        else lines.push(line);
      }
      for (const index of sorted(model.objects.index)) {
        if (index.entityId !== entity.id) continue;
        if (index.restricted === true) {
          skip('index', index.id, 'hidden from the requester');
          continue;
        }
        const line = indexDefinition(index, fields);
        if (line === null) skip('index', index.id, 'it references a column not in this export');
        else lines.push(line);
      }
      const ifNotExists = options.includeIfNotExists ? 'IF NOT EXISTS ' : '';
      pending.push({
        phase: 'entities',
        kind: 'CREATE TABLE',
        text: `CREATE TABLE ${ifNotExists}${quoteIdentifier(entity.name)} (\n  ${lines.join(',\n  ')}\n) ${tableOptions(props, undefined)}`,
        target: { type: 'entity', id: entity.id },
        rank,
        sort: entity.name,
      });
    } else {
      const body = str(props, 'viewDefinition');
      if (body === undefined) {
        skip('entity', entity.id, 'the view has no definition');
        continue;
      }
      const head = [
        options.includeIfNotExists ? 'CREATE OR REPLACE' : 'CREATE',
        str(props, 'algorithm') === undefined ? undefined : `ALGORITHM=${String(props.algorithm)}`,
        str(props, 'sqlSecurity') === undefined
          ? undefined
          : `SQL SECURITY ${String(props.sqlSecurity)}`,
        'VIEW',
        quoteIdentifier(entity.name),
        'AS',
      ].filter((p) => p !== undefined);
      const check = str(props, 'checkOption');
      pending.push({
        phase: 'entities',
        kind: 'CREATE VIEW',
        text: `${head.join(' ')} ${body}${check === undefined ? '' : ` WITH ${check} CHECK OPTION`}`,
        target: { type: 'entity', id: entity.id },
        rank,
        sort: entity.name,
      });
    }
    emittedEntities.set(entity.id, entity);
    for (const field of visible) emittedFields.set(field.id, field);

    // §10.2 — MySQL has no COMMENT ON. A table takes `ALTER TABLE … COMMENT`, a column needs
    // its whole definition restated by `MODIFY COLUMN`. A view's comment has nowhere to go.
    if (entity.kind === 'table') {
      const tableDoc = docText(entity);
      if (tableDoc !== undefined) {
        pending.push({
          phase: 'comments',
          kind: 'ALTER TABLE',
          text: `ALTER TABLE ${quoteIdentifier(entity.name)} COMMENT = ${quoteString(tableDoc)}`,
          target: { type: 'entity', id: entity.id },
          rank: 0,
          sort: entity.name,
        });
      }
      for (const field of visible) {
        const fieldDoc = docText(field);
        if (fieldDoc === undefined) continue;
        pending.push({
          phase: 'comments',
          kind: 'ALTER TABLE',
          text: `ALTER TABLE ${quoteIdentifier(entity.name)} MODIFY COLUMN ${columnDefinition(field, fieldDoc)}`,
          target: { type: 'field', id: field.id },
          rank: 0,
          sort: `${entity.name}.${field.name}`,
        });
      }
    }
    if (options.includeDrops) {
      const what = entity.kind === 'view' ? 'VIEW' : 'TABLE';
      pending.push({
        phase: 'drops',
        kind: `DROP ${what}`,
        text: `DROP ${what} IF EXISTS ${quoteIdentifier(entity.name)}`,
        target: { type: 'entity', id: entity.id },
        rank: -rank,
        sort: entity.name,
      });
    }
  }

  for (const link of sorted(model.objects.link)) {
    const reason = linkSkipReason(link, emittedEntities, emittedFields);
    if (reason !== null) {
      skip('link', link.id, reason);
      continue;
    }
    const from = emittedEntities.get(link.from.entityId);
    const to = emittedEntities.get(link.to.entityId);
    if (from === undefined || to === undefined) continue; // `linkSkipReason` checked both
    const cols = (ids: readonly Id[]) =>
      ids.map((id) => quoteIdentifier(emittedFields.get(id)?.name ?? '')).join(',');
    const p = propsOf(link);
    const actions = (['onDelete', 'onUpdate'] as const)
      .map((key) => {
        const value = p[key];
        const action = typeof value === 'string' ? ACTION_SQL[value] : undefined;
        return action === undefined
          ? ''
          : ` ON ${key === 'onDelete' ? 'DELETE' : 'UPDATE'} ${action}`;
      })
      .join('');
    pending.push({
      phase: 'constraints',
      kind: 'ALTER TABLE',
      text: `ALTER TABLE ${quoteIdentifier(from.name)} ADD CONSTRAINT ${quoteIdentifier(link.name)} FOREIGN KEY (${cols(link.from.fieldIds)}) REFERENCES ${quoteIdentifier(to.name)} (${cols(link.to.fieldIds)})${actions}`,
      target: { type: 'link', id: link.id },
      rank: 0,
      sort: `${from.name}.${link.name}`,
    });
  }

  const ordered = pending.sort(
    (a, b) =>
      EXPORT_PHASE_RANK[a.phase] - EXPORT_PHASE_RANK[b.phase] ||
      a.rank - b.rank ||
      compare(a.sort, b.sort) ||
      compare(a.target?.id ?? '', b.target?.id ?? ''),
  );
  const statements: ExportStatement[] = [];
  if (state.skipped)
    statements.push({
      ordinal: 0,
      phase: 'header',
      kind: 'COMMENT',
      text: REDACTION_NOTICE,
      target: null,
    });
  for (const item of ordered) {
    statements.push({
      ordinal: statements.length,
      phase: item.phase,
      kind: item.kind,
      text: item.text,
      target: item.target,
    });
  }
  return {
    statements,
    separator: CAPABILITIES.queryLanguage.statementSeparator,
    incomplete: state.skipped,
    diagnostics,
  };
}

function linkSkipReason(
  link: Link,
  entities: ReadonlyMap<Id, Entity>,
  fields: ReadonlyMap<Id, Field>,
): string | null {
  if (link.restricted === true) return 'hidden from the requester';
  if (!entities.has(link.from.entityId) || !entities.has(link.to.entityId))
    return 'a table it joins is not in this export';
  const all = [...link.from.fieldIds, ...link.to.fieldIds];
  if (all.length === 0 || all.some((id) => !fields.has(id)))
    return 'it references a column not in this export';
  if (link.from.fieldIds.length !== link.to.fieldIds.length)
    return 'its two sides have different column counts';
  return null;
}

export const EXPORTER: Exporter = {
  export(input) {
    if (input.options.format !== 'ddl') {
      return Promise.reject(new Error(`unknown export format “${input.options.format}”`));
    }
    return Promise.resolve(buildExport(input));
  },
};
