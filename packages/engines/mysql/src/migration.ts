import {
  compareMigrationSteps,
  entryIsDestructive,
  entryRiskKey,
  needsMigrationStep,
  type Constraint,
  type DiagnosticParam,
  type DiffEntry,
  type Field,
  type Id,
  type Index,
  type IrObjectRef,
  type IrObjectType,
  type Link,
  type MigrationGenerator,
  type MigrationInput,
  type MigrationOperation,
  type MigrationPhase,
  type MigrationPlan,
  type MigrationStep,
  type SchemaModel,
  type UnsupportedChange,
} from '@schemaloom/engine-sdk';
import { isMariaDb } from './capabilities.js';
import {
  ACTION_SQL,
  columnDefinition,
  constraintDefinition,
  entityDepths,
  indexDefinition,
  quoteIdentifier as q,
  tableOptions,
  viewStatement,
} from './exporter.js';
import { CODE } from './messages.js';
import { typeChangeRisk } from './annotate.js';

/**
 * Doc 03 §11.2 for MySQL (design §4). Phases, in order:
 *
 *  - `pre`     RENAME TABLE / RENAME COLUMN / RENAME INDEX: after `pre` every surviving object
 *              is at its after-name.
 *  - `drops`   foreign keys, then checks, keys and indexes, then columns, then views, tables.
 *  - `alters`  MODIFY COLUMN (the whole definition, which MySQL requires), table options.
 *  - `creates` CREATE TABLE (keys inline), ADD COLUMN, CREATE OR REPLACE VIEW.
 *  - `post`    primary and unique keys, checks, indexes, then foreign keys.
 *
 * MySQL commits every DDL statement on its own, so `transaction` is always null and the first
 * step says so. An entry the generator cannot express goes to `unsupported` whole.
 */

interface Pending {
  readonly phase: MigrationPhase;
  readonly operation: MigrationOperation;
  readonly rank: number;
  readonly sort: string;
  readonly kind: string;
  readonly text: string;
  readonly destructive?: boolean;
  readonly lossy?: boolean;
  readonly requiresTableRewrite?: boolean;
  readonly reasonCode?: string;
  readonly reasonParams?: Readonly<Record<string, DiagnosticParam>>;
  readonly covers: IrObjectRef[];
}

const NOT_TRANSACTIONAL =
  '-- MySQL commits each schema change as it runs; this script cannot be rolled back as a whole.';

const refOf = (entry: DiffEntry): IrObjectRef => ({ type: entry.objectType, id: entry.id });
const keyOf = (type: IrObjectType, id: Id): string => entryRiskKey({ objectType: type, id });
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const structuralRoots = (entry: DiffEntry): Set<string> =>
  new Set(
    entry.change === 'changed'
      ? entry.properties.filter((p) => p.severity === 'structural').map((p) => p.path[0] ?? '')
      : [],
  );

class Planner {
  readonly pending: Pending[] = [];
  readonly unsupported: UnsupportedChange[] = [];
  private readonly handled = new Set<string>();
  private readonly byTable = new Map<Id, Pending[]>();

  add(step: Pending, tableId?: Id): void {
    this.pending.push(step);
    for (const ref of step.covers) this.handled.add(keyOf(ref.type, ref.id));
    if (tableId !== undefined)
      this.byTable.set(tableId, [...(this.byTable.get(tableId) ?? []), step]);
  }

  /** An entry another step already accounts for (a column renumbered by an ADD COLUMN). */
  attachToTable(entry: DiffEntry, tableId: Id): boolean {
    const step = this.byTable.get(tableId)?.[0];
    if (step === undefined) return false;
    step.covers.push(refOf(entry));
    this.handled.add(entryRiskKey(entry));
    return true;
  }

  isHandled(entry: DiffEntry): boolean {
    return this.handled.has(entryRiskKey(entry));
  }

  refuse(entry: DiffEntry, property: string, reason: string): void {
    if (this.isHandled(entry)) return;
    this.handled.add(entryRiskKey(entry));
    this.unsupported.push({
      entry: refOf(entry),
      changeCode: CODE.migrationChange,
      changeParams: { object: refOf(entry), change: entry.change, property },
      reasonCode: CODE.migrationUnsupported,
      reasonParams: { reason },
    });
  }
}

function fieldsOf(model: SchemaModel, entityId: Id): Field[] {
  return Object.values(model.objects.field)
    .filter((f) => f.entityId === entityId)
    .sort((a, b) => a.ordinal - b.ordinal || compare(a.id, b.id));
}

/** `AFTER `prev`` or `FIRST`: where a column sits among the table's after-columns. */
function position(after: SchemaModel, field: Field): string {
  const columns = fieldsOf(after, field.entityId);
  const at = columns.findIndex((f) => f.id === field.id);
  const prev = at > 0 ? columns[at - 1] : undefined;
  return prev === undefined ? ' FIRST' : ` AFTER ${q(prev.name)}`;
}

/** Whether the columns both models share keep their relative order. */
function orderKept(before: SchemaModel, after: SchemaModel, entityId: Id): boolean {
  const shared = new Set(fieldsOf(before, entityId).map((f) => f.id));
  const a = fieldsOf(after, entityId)
    .filter((f) => shared.has(f.id))
    .map((f) => f.id);
  const kept = new Set(a);
  const b = fieldsOf(before, entityId)
    .filter((f) => kept.has(f.id))
    .map((f) => f.id);
  return a.join() === b.join();
}

function generatePlan(input: MigrationInput): MigrationPlan {
  const { diff, before, after, options } = input;
  const mariaDb = isMariaDb(input.context.serverVersion ?? after.engineVersion);
  const plan = new Planner();
  const relevant = diff.entries.filter(needsMigrationStep);

  /** A table's name once `pre` has run: its after-name if it survives. */
  const tableNow = (id: Id): string =>
    after.objects.entity[id]?.name ?? before.objects.entity[id]?.name ?? '';
  const drops = (entry: DiffEntry): Partial<Pending> =>
    entryIsDestructive(diff, entry)
      ? {
          destructive: true,
          reasonCode: CODE.migrationDropsData,
          reasonParams: { object: refOf(entry) },
        }
      : {};
  const owned = (entityId: Id) =>
    relevant.filter((e) => e.objectType !== 'entity' && e.ownerEntityId === entityId);
  const beforeDepths = entityDepths(Object.values(before.objects.entity));
  const afterDepths = entityDepths(Object.values(after.objects.entity));
  const fieldMap = (model: SchemaModel, entityId: Id) =>
    new Map(fieldsOf(model, entityId).map((f) => [f.id, f]));

  // --- entities ---------------------------------------------------------------------------
  const rebuilt = new Set<Id>(); // created, dropped or recreated whole: children follow it
  for (const entry of relevant) {
    if (entry.objectType === 'namespace' || entry.objectType === 'customType') {
      plan.refuse(entry, entry.objectType, 'a MySQL project is one database with no custom types');
      continue;
    }
    if (entry.objectType !== 'entity') continue;

    if (entry.change === 'added') {
      const entity = entry.after;
      const children = owned(entity.id).filter((c) => c.change === 'added');
      if (entity.kind === 'view') {
        const body =
          typeof entity.engineProps.viewDefinition === 'string'
            ? entity.engineProps.viewDefinition
            : '';
        if (body === '') {
          plan.refuse(entry, 'engineProps', 'the view has no definition');
          continue;
        }
        plan.add({
          phase: 'creates',
          operation: 'create',
          rank: 200 + (afterDepths.get(entity.id) ?? 0),
          sort: entity.name,
          kind: 'CREATE VIEW',
          text: viewStatement(entity.name, entity.engineProps, body, false),
          covers: [refOf(entry), ...children.filter((c) => c.objectType === 'field').map(refOf)],
        });
      } else {
        const fields = fieldMap(after, entity.id);
        const lines = [...fields.values()].map((f) => columnDefinition(f, undefined));
        const coveredChildren: IrObjectRef[] = [];
        for (const c of children) {
          if (c.objectType === 'field') coveredChildren.push(refOf(c));
          if (c.objectType === 'constraint') {
            const line = constraintDefinition(c.after, fields);
            if (line !== null) {
              lines.push(line);
              coveredChildren.push(refOf(c));
            }
          }
          if (c.objectType === 'index') {
            const line = indexDefinition(c.after, fields);
            if (line !== null) {
              lines.push(line);
              coveredChildren.push(refOf(c));
            }
          }
        }
        plan.add(
          {
            phase: 'creates',
            operation: 'create',
            rank: afterDepths.get(entity.id) ?? 0,
            sort: entity.name,
            kind: 'CREATE TABLE',
            text: `CREATE TABLE ${q(entity.name)} (\n  ${lines.join(',\n  ')}\n) ${tableOptions(entity.engineProps, undefined)}`,
            covers: [refOf(entry), ...coveredChildren],
          },
          entity.id,
        );
      }
      rebuilt.add(entity.id);
      continue;
    }

    if (entry.change === 'removed') {
      const entity = entry.before;
      const view = entity.kind === 'view';
      const depth = beforeDepths.get(entity.id) ?? 0;
      plan.add({
        phase: 'drops',
        operation: 'drop',
        // Dependent views before what they select from; views before tables.
        rank: view ? 100 - depth : 300 - depth,
        sort: entity.name,
        kind: view ? 'DROP VIEW' : 'DROP TABLE',
        text: `DROP ${view ? 'VIEW' : 'TABLE'} ${q(entity.name)}`,
        covers: [
          refOf(entry),
          ...owned(entity.id)
            .filter((c) => c.change === 'removed')
            .map(refOf),
        ],
        ...drops(entry),
      });
      rebuilt.add(entity.id);
      continue;
    }

    const roots = structuralRoots(entry);
    if (roots.has('kind')) {
      plan.refuse(entry, 'kind', 'MySQL cannot turn a table into a view in place');
      for (const child of owned(entry.id)) plan.refuse(child, 'entityId', 'its table changed kind');
      rebuilt.add(entry.id);
      continue;
    }
    if (roots.has('name')) {
      plan.add({
        phase: 'pre',
        operation: 'rename',
        rank: 0,
        sort: entry.after.name,
        kind: entry.after.kind === 'view' ? 'RENAME TABLE (view)' : 'RENAME TABLE',
        text: `RENAME TABLE ${q(entry.before.name)} TO ${q(entry.after.name)}`,
        covers: [refOf(entry)],
      });
    }
    if (entry.after.kind === 'view') {
      // A view IS its definition: any structural change, or a change to its columns, is a
      // CREATE OR REPLACE.
      const fieldChanges = owned(entry.id).filter((c) => c.objectType === 'field');
      if ([...roots].some((r) => r !== 'name') || fieldChanges.length > 0) {
        const body =
          typeof entry.after.engineProps.viewDefinition === 'string'
            ? entry.after.engineProps.viewDefinition
            : '';
        if (body === '') {
          plan.refuse(entry, 'engineProps', 'the view has no definition');
          continue;
        }
        plan.add({
          phase: 'creates',
          operation: 'create',
          rank: 200 + (afterDepths.get(entry.id) ?? 0),
          sort: entry.after.name,
          kind: 'CREATE OR REPLACE VIEW',
          text: viewStatement(entry.after.name, entry.after.engineProps, body, true),
          covers: [refOf(entry), ...fieldChanges.map(refOf)],
        });
      }
      rebuilt.add(entry.id);
      continue;
    }
    if (roots.has('engineProps')) {
      plan.add({
        phase: 'alters',
        operation: 'alter',
        rank: 0,
        sort: entry.after.name,
        kind: 'ALTER TABLE',
        text: `ALTER TABLE ${q(entry.after.name)} ${tableOptions(entry.after.engineProps, undefined)}`,
        requiresTableRewrite: true,
        reasonCode: CODE.migrationTableCopy,
        reasonParams: { from: 'the table options', to: 'the new ones' },
        covers: [refOf(entry)],
      });
    }
    const rest = [...roots].filter((r) => r !== 'name' && r !== 'engineProps');
    if (rest.length > 0)
      plan.refuse(entry, rest.join(', '), `a change to ${rest.join(', ')} has no MySQL statement`);
  }

  // --- columns ------------------------------------------------------------------------------
  const renumbered: Extract<DiffEntry, { objectType: 'field'; change: 'changed' }>[] = [];
  for (const entry of relevant) {
    if (entry.objectType !== 'field' || plan.isHandled(entry)) continue;
    const entityId = entry.ownerEntityId ?? '';
    if (rebuilt.has(entityId)) {
      if (!plan.isHandled(entry))
        plan.refuse(entry, 'entityId', 'its table is created or dropped in this migration');
      continue;
    }
    const table = q(tableNow(entityId));
    if (entry.change === 'added') {
      plan.add(
        {
          phase: 'creates',
          operation: 'create',
          rank: 100 + entry.after.ordinal,
          sort: `${tableNow(entityId)}.${entry.after.name}`,
          kind: 'ALTER TABLE ADD COLUMN',
          text: `ALTER TABLE ${table} ADD COLUMN ${columnDefinition(entry.after, undefined)}${position(after, entry.after)}`,
          covers: [refOf(entry)],
        },
        entityId,
      );
      continue;
    }
    if (entry.change === 'removed') {
      plan.add(
        {
          phase: 'drops',
          operation: 'drop',
          rank: 200,
          sort: `${tableNow(entityId)}.${entry.before.name}`,
          kind: 'ALTER TABLE DROP COLUMN',
          text: `ALTER TABLE ${table} DROP COLUMN ${q(entry.before.name)}`,
          covers: [refOf(entry)],
          ...drops(entry),
        },
        entityId,
      );
      continue;
    }
    const roots = structuralRoots(entry);
    if (roots.has('name')) {
      plan.add({
        phase: 'pre',
        operation: 'rename',
        rank: 1,
        sort: `${tableNow(entityId)}.${entry.after.name}`,
        kind: 'ALTER TABLE RENAME COLUMN',
        text: `ALTER TABLE ${table} RENAME COLUMN ${q(entry.before.name)} TO ${q(entry.after.name)}`,
        covers: [refOf(entry)],
      });
    }
    const moves = roots.has('ordinal') && !orderKept(before, after, entityId);
    const definitionChanged = [...roots].some((r) => r !== 'name' && r !== 'ordinal');
    if (!definitionChanged && !moves) {
      if (roots.has('ordinal') && !roots.has('name')) renumbered.push(entry);
      continue;
    }
    const risk =
      roots.has('type') || entry.properties.some((p) => p.path[1] === 'unsigned')
        ? typeChangeRisk(entry.before, entry.after)
        : null;
    const tightened = roots.has('isNullable') && entry.before.isNullable && !entry.after.isNullable;
    plan.add(
      {
        phase: 'alters',
        operation: 'alter',
        rank: entry.after.ordinal,
        sort: `${tableNow(entityId)}.${entry.after.name}`,
        kind: 'ALTER TABLE MODIFY COLUMN',
        text: `ALTER TABLE ${table} MODIFY COLUMN ${columnDefinition(entry.after, undefined)}${moves ? position(after, entry.after) : ''}`,
        lossy: risk?.lossy === true || tightened,
        requiresTableRewrite: risk !== null || tightened,
        ...(risk?.lossy === true
          ? {
              reasonCode: CODE.migrationTypeNarrowed,
              reasonParams: { from: risk.from, to: risk.to },
            }
          : risk !== null
            ? {
                reasonCode: CODE.migrationTableCopy,
                reasonParams: { from: risk.from, to: risk.to },
              }
            : tightened
              ? { reasonCode: CODE.migrationNotNull, reasonParams: { object: refOf(entry) } }
              : {}),
        covers: [refOf(entry)],
      },
      entityId,
    );
  }
  // A column whose ordinal moved only because another was added or dropped beside it.
  for (const entry of renumbered) {
    if (!plan.attachToTable(entry, entry.ownerEntityId ?? '')) {
      plan.add({
        phase: 'alters',
        operation: 'alter',
        rank: entry.after.ordinal,
        sort: `${tableNow(entry.after.entityId)}.${entry.after.name}`,
        kind: 'ALTER TABLE MODIFY COLUMN',
        text: `ALTER TABLE ${q(tableNow(entry.after.entityId))} MODIFY COLUMN ${columnDefinition(entry.after, undefined)}${position(after, entry.after)}`,
        covers: [refOf(entry)],
      });
    }
  }

  // --- keys, checks and indexes --------------------------------------------------------------
  const dropKey = (c: Constraint): string => {
    const table = q(tableNow(c.entityId));
    if (c.kind === 'primaryKey') return `ALTER TABLE ${table} DROP PRIMARY KEY`;
    if (c.kind === 'unique') return `ALTER TABLE ${table} DROP INDEX ${q(c.name)}`;
    return `ALTER TABLE ${table} DROP ${mariaDb ? 'CONSTRAINT' : 'CHECK'} ${q(c.name)}`;
  };
  const addKey = (c: Constraint): string | null => {
    const line = constraintDefinition(c, fieldMap(after, c.entityId));
    return line === null ? null : `ALTER TABLE ${q(tableNow(c.entityId))} ADD ${line}`;
  };
  const dropIndex = (i: Index): string => `DROP INDEX ${q(i.name)} ON ${q(tableNow(i.entityId))}`;
  const addIndex = (i: Index): string | null => {
    const line = indexDefinition(i, fieldMap(after, i.entityId));
    if (line === null) return null;
    // `UNIQUE KEY n (…)` → `CREATE UNIQUE INDEX n ON t (…)`
    const [, lead = 'KEY', rest = ''] =
      /^((?:FULLTEXT |SPATIAL |UNIQUE )?KEY) (.*)$/.exec(line) ?? [];
    const head = lead.replace(/KEY$/, 'INDEX');
    const nameEnd = rest.indexOf(' (');
    return `CREATE ${head} ${rest.slice(0, nameEnd)} ON ${q(tableNow(i.entityId))}${rest.slice(nameEnd)}`;
  };

  for (const entry of relevant) {
    if (
      (entry.objectType !== 'constraint' && entry.objectType !== 'index') ||
      plan.isHandled(entry)
    )
      continue;
    const entityId = entry.ownerEntityId ?? '';
    if (rebuilt.has(entityId)) {
      plan.refuse(entry, 'entityId', 'its table is created or dropped in this migration');
      continue;
    }
    const sort = `${tableNow(entityId)}.${entry.change === 'removed' ? entry.before.name : entry.after.name}`;
    const isConstraint = entry.objectType === 'constraint';
    const dropText = (o: Constraint | Index) =>
      isConstraint ? dropKey(o as Constraint) : dropIndex(o as Index);
    const addText = (o: Constraint | Index) =>
      isConstraint ? addKey(o as Constraint) : addIndex(o as Index);
    const drop = (o: Constraint | Index): Pending => ({
      phase: 'drops',
      operation: 'drop',
      rank: 50,
      sort,
      kind: isConstraint ? 'ALTER TABLE DROP' : 'DROP INDEX',
      text: dropText(o),
      covers: [refOf(entry)],
    });
    const add = (o: Constraint | Index): Pending | null => {
      const text = addText(o);
      return text === null
        ? null
        : {
            phase: 'post',
            operation: 'create',
            rank: isConstraint ? 0 : 1,
            sort,
            kind: isConstraint ? 'ALTER TABLE ADD' : 'CREATE INDEX',
            text,
            covers: [refOf(entry)],
          };
    };

    if (entry.change === 'removed') {
      plan.add(drop(entry.before));
      continue;
    }
    if (entry.change === 'added') {
      const step = add(entry.after);
      if (step === null) plan.refuse(entry, 'columns', 'it names a column that does not exist');
      else plan.add(step);
      continue;
    }
    const roots = structuralRoots(entry);
    const renameOnly = roots.size === 1 && roots.has('name');
    const renamable = !isConstraint || entry.before.kind === 'unique';
    if (renameOnly && renamable) {
      plan.add({
        phase: 'pre',
        operation: 'rename',
        rank: 2,
        sort,
        kind: 'ALTER TABLE RENAME INDEX',
        text: `ALTER TABLE ${q(tableNow(entityId))} RENAME INDEX ${q(entry.before.name)} TO ${q(entry.after.name)}`,
        covers: [refOf(entry)],
      });
      continue;
    }
    const step = add(entry.after);
    if (step === null) {
      plan.refuse(entry, 'columns', 'it names a column that does not exist');
      continue;
    }
    plan.add(drop(entry.before));
    plan.add(step);
  }

  // --- foreign keys ---------------------------------------------------------------------------
  const dropFk = (l: Link): string =>
    `ALTER TABLE ${q(tableNow(l.from.entityId))} DROP FOREIGN KEY ${q(l.name)}`;
  const addFk = (l: Link): string | null => {
    const cols = (ids: readonly Id[]) => {
      const names = ids.map((id) => after.objects.field[id]?.name);
      return names.every((n) => n !== undefined) ? names.map((n) => q(n)).join(',') : null;
    };
    const from = cols(l.from.fieldIds);
    const to = cols(l.to.fieldIds);
    const target = after.objects.entity[l.to.entityId];
    if (from === null || to === null || target === undefined) return null;
    const actions = (['onDelete', 'onUpdate'] as const)
      .map((key) => {
        const value = l.engineProps[key];
        const sql = typeof value === 'string' ? ACTION_SQL[value] : undefined;
        return sql === undefined ? '' : ` ON ${key === 'onDelete' ? 'DELETE' : 'UPDATE'} ${sql}`;
      })
      .join('');
    return `ALTER TABLE ${q(tableNow(l.from.entityId))} ADD CONSTRAINT ${q(l.name)} FOREIGN KEY (${from}) REFERENCES ${q(target.name)} (${to})${actions}`;
  };
  for (const entry of relevant) {
    if (entry.objectType !== 'link' || plan.isHandled(entry)) continue;
    const sort = `${tableNow(entry.ownerEntityId ?? '')}.${entry.change === 'removed' ? entry.before.name : entry.after.name}`;
    const removedOwner =
      entry.change === 'removed' && !after.objects.entity[entry.before.from.entityId];
    if (entry.change === 'removed' || entry.change === 'changed') {
      const link = entry.before;
      // A table being dropped takes its own foreign keys with it.
      if (!removedOwner) {
        plan.add({
          phase: 'drops',
          operation: 'drop',
          rank: 0,
          sort,
          kind: 'ALTER TABLE DROP FOREIGN KEY',
          text: dropFk(link),
          covers: [refOf(entry)],
        });
      }
      if (entry.change === 'removed') continue;
    }
    const text = addFk(entry.after);
    if (text === null) {
      plan.refuse(entry, 'fieldIds', 'a column or table it joins is not in the new schema');
      continue;
    }
    plan.add({
      phase: 'post',
      operation: 'create',
      rank: 2,
      sort,
      kind: 'ALTER TABLE ADD FOREIGN KEY',
      text,
      covers: [refOf(entry)],
    });
  }

  // Never silently drop an input (§11.2 guarantee 2).
  for (const entry of relevant) {
    if (!plan.isHandled(entry))
      plan.refuse(entry, entry.change, 'SchemaLoom has no MySQL statement for this change');
  }

  return assemble(plan, options.allowDestructive);
}

function assemble(plan: Planner, allowDestructive: boolean): MigrationPlan {
  const ordered = [...plan.pending].sort(
    (a, b) =>
      compareMigrationSteps(a, b) ||
      a.rank - b.rank ||
      compare(a.sort, b.sort) ||
      compare(a.text, b.text),
  );
  const steps: MigrationStep[] = ordered.map((p, ordinal) => {
    const destructive = p.destructive === true;
    return {
      ordinal,
      phase: p.phase,
      operation: p.operation,
      kind: p.kind,
      text: ordinal === 0 ? `${NOT_TRANSACTIONAL}\n${p.text}` : p.text,
      destructive,
      lossy: p.lossy === true,
      requiresTableRewrite: p.requiresTableRewrite === true,
      reasonCode: p.reasonCode ?? null,
      reasonParams: p.reasonParams ?? {},
      covers: p.covers,
      commentedOut: destructive && !allowDestructive,
    };
  });
  return {
    steps,
    summary: {
      total: steps.length,
      destructive: steps.filter((s) => s.destructive).length,
      lossy: steps.filter((s) => s.lossy).length,
      rewrites: steps.filter((s) => s.requiresTableRewrite).length,
    },
    unsupported: plan.unsupported,
    diagnostics: [],
    // MySQL DDL is not transactional: there is nothing honest to wrap it in.
    transaction: null,
  };
}

export const MIGRATION_GENERATOR: MigrationGenerator = {
  generate(input: MigrationInput) {
    return Promise.resolve(generatePlan(input));
  },
};
