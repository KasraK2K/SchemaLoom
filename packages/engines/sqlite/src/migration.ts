import {
  compareMigrationSteps,
  entryIsDestructive,
  needsMigrationStep,
  type DiagnosticParam,
  type DiffEntry,
  type Entity,
  type Field,
  type Id,
  type IrObjectRef,
  type MigrationGenerator,
  type MigrationInput,
  type MigrationOperation,
  type MigrationPhase,
  type MigrationPlan,
  type MigrationStep,
  type SchemaModel,
  type UnsupportedChange,
} from '@schemaloom/engine-sdk';
import { typeChangeRisk } from './annotate.js';
import { columnsOf, createIndexText, createTableText, createViewText } from './exporter.js';
import { CODE } from './messages.js';
import { normalizeName } from './normalize-name.js';
import { quoteIdentifier as q } from './sqlite.js';

/**
 * Phase 13 §4.4 — migrations for SQLite. Its ALTER TABLE can rename a table, rename a column,
 * add a column (with limits) and drop one; anything else rebuilds the table the documented way:
 * create it anew, copy the rows, drop the old one, rename the new one into place, then put back
 * its indexes and the views that read it. A rebuild is ONE step, so commenting it out (when it
 * drops data and destructive steps aren't allowed) comments out all of it.
 *
 * Foreign keys are switched off around the whole script (`PRAGMA foreign_keys` only works
 * outside a transaction), and `foreign_key_check` runs before the commit.
 */

type Draft = Omit<MigrationStep, 'ordinal' | 'commentedOut'>;

const ref = (entry: Pick<DiffEntry, 'objectType' | 'id'>): IrObjectRef => ({
  type: entry.objectType,
  id: entry.id,
});

/** What ADD COLUMN can't do in SQLite (https://sqlite.org/lang_altertable.html). */
function addable(field: Field, after: SchemaModel): boolean {
  const p = field.engineProps;
  const dflt = typeof p.default === 'string' ? p.default.trim() : undefined;
  if (p.generatedKind === 'STORED') return false;
  if (!field.isNullable && (dflt === undefined || /^null$/i.test(dflt))) return false;
  if (
    dflt !== undefined &&
    (/^current_(time|date|timestamp)$/i.test(dflt) || dflt.startsWith('('))
  ) {
    return false;
  }
  const inKey = Object.values(after.objects.constraint).some(
    (c) => c.fieldIds.includes(field.id) && (c.kind === 'primaryKey' || c.kind === 'unique'),
  );
  const inLink = Object.values(after.objects.link).some((l) => l.from.fieldIds.includes(field.id));
  return !inKey && !inLink;
}

/** What DROP COLUMN can't do: the column is part of a key, index, foreign key or check. */
function droppable(field: Field, before: SchemaModel): boolean {
  const id = field.id;
  const name = normalizeName(field.name);
  const mentions = (text: unknown) =>
    typeof text === 'string' && normalizeName(text).includes(name);
  if (
    Object.values(before.objects.constraint).some(
      (c) => c.fieldIds.includes(id) || mentions(c.engineProps.expression),
    )
  ) {
    return false;
  }
  if (
    Object.values(before.objects.index).some(
      (i) =>
        i.columns.some((c) => c.fieldId === id || mentions(c.expression)) ||
        mentions(i.engineProps.where),
    )
  ) {
    return false;
  }
  if (
    Object.values(before.objects.link).some(
      (l) => l.from.fieldIds.includes(id) || l.to.fieldIds.includes(id),
    )
  ) {
    return false;
  }
  return !Object.values(before.objects.field).some((f) =>
    mentions(f.engineProps.generatedExpression),
  );
}

/** Views whose definition names the table: dropped before a rebuild and put back after. */
function dependentViews(model: SchemaModel, table: Entity): Entity[] {
  const name = normalizeName(table.name);
  return Object.values(model.objects.entity)
    .filter((e) => e.kind === 'view')
    .filter(
      (v) =>
        (v.refs?.entityIds.includes(table.id) ?? false) ||
        (typeof v.engineProps.viewDefinition === 'string' &&
          normalizeName(v.engineProps.viewDefinition).includes(name)),
    )
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function generateMigration(input: MigrationInput): Promise<MigrationPlan> {
  const { diff, before, after, options } = input;
  const drafts: Draft[] = [];
  const unsupported: UnsupportedChange[] = [];
  const entries = diff.entries.filter(needsMigrationStep);

  const step = (
    phase: MigrationPhase,
    operation: MigrationOperation,
    kind: string,
    text: string,
    covers: readonly IrObjectRef[],
    extra: Partial<
      Pick<Draft, 'destructive' | 'lossy' | 'requiresTableRewrite' | 'reasonCode' | 'reasonParams'>
    > = {},
  ) => {
    drafts.push({
      phase,
      operation,
      kind,
      text,
      covers,
      destructive: extra.destructive ?? false,
      lossy: extra.lossy ?? false,
      requiresTableRewrite: extra.requiresTableRewrite ?? false,
      reasonCode: extra.reasonCode ?? null,
      reasonParams: extra.reasonParams ?? {},
    });
  };

  // Old table → new table. The ids are the same when the two models share a history (a
  // snapshot and the live design); a drift read pairs them by name, and a change the diff
  // matched says so itself.
  const tableFor = new Map<Id, Id>();
  const fieldFor = new Map<Id, Id>();
  for (const e of diff.entries) {
    if (e.change !== 'changed') continue;
    if (e.objectType === 'entity') tableFor.set(e.before.id, e.after.id);
    if (e.objectType === 'field') fieldFor.set(e.before.id, e.after.id);
  }
  const afterTableByName = new Map(
    Object.values(after.objects.entity).map((e) => [normalizeName(e.name), e.id] as const),
  );
  for (const e of Object.values(before.objects.entity)) {
    if (tableFor.has(e.id)) continue;
    const same =
      after.objects.entity[e.id] !== undefined ? e.id : afterTableByName.get(normalizeName(e.name));
    if (same !== undefined) tableFor.set(e.id, same);
  }
  const beforeTableOf = new Map([...tableFor].map(([b, a]) => [a, b] as const));
  /** The old column a new one continues, if any. */
  const oldColumn = (field: Field, oldTable: Entity): Field | undefined => {
    if (before.objects.field[field.id]?.entityId === oldTable.id)
      return before.objects.field[field.id];
    const renamed = [...fieldFor].find(([, a]) => a === field.id)?.[0];
    if (renamed !== undefined) return before.objects.field[renamed];
    return columnsOf(before, oldTable.id).find(
      (f) => normalizeName(f.name) === normalizeName(field.name),
    );
  };

  const ownerOf = (entry: DiffEntry): Id | undefined => {
    const id = entry.objectType === 'entity' ? entry.id : entry.ownerEntityId;
    if (id === undefined) return undefined;
    return entry.change === 'removed' ? (tableFor.get(id) ?? id) : id;
  };

  // Namespaces and custom types don't exist in SQLite; say so rather than skip silently.
  for (const entry of entries) {
    if (entry.objectType === 'namespace' || entry.objectType === 'customType') {
      unsupported.push({
        entry: ref(entry),
        changeCode: CODE.migrationChange,
        changeParams: { object: entry.objectType, property: entry.change, change: entry.change },
        reasonCode: CODE.migrationUnsupported,
        reasonParams: { reason: 'a SQLite database has one schema and no custom types' },
      });
    }
  }

  // Group everything else by table.
  const byTable = new Map<Id, DiffEntry[]>();
  for (const entry of entries) {
    const owner = ownerOf(entry);
    if (owner === undefined) continue;
    byTable.set(owner, [...(byTable.get(owner) ?? []), entry]);
  }

  const rebuilt = new Set<Id>();
  for (const [tableId, group] of byTable) {
    const own = group.find((e) => e.objectType === 'entity');
    const now = after.objects.entity[tableId];
    const was = before.objects.entity[beforeTableOf.get(tableId) ?? tableId];
    const kind = (now ?? was)?.kind;

    // --- views: no data, so drop and create ------------------------------------------------
    if (kind === 'view') {
      const covers = group.map(ref);
      // A view holds no data, but removing one is still removing an object (core's rule).
      const removed = own?.change === 'removed';
      if (was !== undefined) {
        step('drops', 'drop', 'DROP VIEW', `DROP VIEW IF EXISTS ${q(was.name)}`, covers, {
          destructive: removed,
          reasonCode: removed ? CODE.migrationDropsData : null,
          reasonParams: removed ? { object: was.name } : {},
        });
      }
      const text = now === undefined ? null : createViewText(now);
      if (text !== null) step('creates', 'create', 'CREATE VIEW', text, covers);
      else if (was === undefined) {
        for (const e of group) {
          unsupported.push({
            entry: ref(e),
            changeCode: CODE.migrationChange,
            changeParams: { object: (now ?? was)?.name ?? '', property: 'view', change: e.change },
            reasonCode: CODE.migrationUnsupported,
            reasonParams: { reason: 'the view has no definition' },
          });
        }
      }
      continue;
    }

    // --- a new table, or a dropped one --------------------------------------------------------
    if (own?.change === 'added' && now !== undefined) {
      step(
        'creates',
        'create',
        'CREATE TABLE',
        createTableText(after, now),
        group.filter((e) => e.objectType !== 'index').map(ref),
      );
      for (const e of group.filter((x) => x.objectType === 'index' && x.change !== 'removed')) {
        const ix = after.objects.index[e.id];
        const text = ix === undefined ? null : createIndexText(after, ix);
        if (text !== null) step('creates', 'create', 'CREATE INDEX', text, [ref(e)]);
      }
      continue;
    }
    if (own?.change === 'removed' && was !== undefined) {
      step('drops', 'drop', 'DROP TABLE', `DROP TABLE ${q(was.name)}`, group.map(ref), {
        destructive: true,
        reasonCode: CODE.migrationDropsData,
        reasonParams: { object: was.name },
      });
      continue;
    }
    if (now === undefined || was === undefined) continue;

    // --- an existing table: ALTER where SQLite can, a rebuild otherwise -----------------------
    const tableEntries = group.filter((e) => e.objectType !== 'index');
    const simple = tableEntries.every((e) => {
      if (e.objectType === 'entity') {
        return (
          e.change === 'changed' &&
          e.properties.every((p) => p.path[0] === 'name' || p.severity !== 'structural')
        );
      }
      if (e.objectType !== 'field') return false;
      if (e.change === 'added') return addable(e.after, after);
      if (e.change === 'removed') return droppable(e.before, before);
      return e.properties.every((p) => p.path[0] === 'name' || p.severity !== 'structural');
    });

    if (!simple) {
      rebuilt.add(tableId);
      // Every new column that continues an old one, generated columns aside (SQLite fills them).
      const keep = columnsOf(after, now.id).flatMap((f) => {
        const old = oldColumn(f, was);
        return old === undefined || typeof f.engineProps.generatedExpression === 'string'
          ? []
          : [{ old, f }];
      });
      const source = keep.map(({ old }) => q(old.name));
      const target = keep.map(({ f }) => q(f.name));
      const temp = `${now.name}__new`;
      const views = dependentViews(before, was);
      const viewsAfter = views.flatMap((v) => {
        const text = createViewText(after.objects.entity[v.id] ?? v);
        return text === null ? [] : [text];
      });
      const indexes = Object.values(after.objects.index)
        .filter((i) => i.entityId === now.id)
        .flatMap((i) => createIndexText(after, i) ?? []);
      const lines = [
        ...views.map((v) => `DROP VIEW IF EXISTS ${q(v.name)}`),
        createTableText(after, now, { name: temp }),
        ...(keep.length === 0
          ? []
          : [
              `INSERT INTO ${q(temp)} (${target.join(', ')}) SELECT ${source.join(', ')} FROM ${q(was.name)}`,
            ]),
        `DROP TABLE ${q(was.name)}`,
        `ALTER TABLE ${q(temp)} RENAME TO ${q(now.name)}`,
        ...indexes,
        ...viewsAfter,
      ];
      if (!options.transactional) lines.unshift('PRAGMA foreign_keys = OFF');
      if (!options.transactional) lines.push('PRAGMA foreign_keys = ON');
      const dropsData = tableEntries.some(
        (e) => entryIsDestructive(diff, e) || (e.objectType === 'field' && e.change === 'removed'),
      );
      const lossy = tableEntries.find(
        (e) =>
          e.objectType === 'field' &&
          e.change === 'changed' &&
          e.properties.some((p) => p.path[0] === 'type') &&
          typeChangeRisk(e.before, e.after).lossy,
      );
      const params: Record<string, DiagnosticParam> =
        lossy?.objectType === 'field' && lossy.change === 'changed'
          ? (({ from, to }) => ({ from, to }))(typeChangeRisk(lossy.before, lossy.after))
          : { object: now.name };
      step('alters', 'alter', 'REBUILD TABLE', lines.join(';\n'), group.map(ref), {
        destructive: dropsData,
        lossy: lossy !== undefined,
        requiresTableRewrite: true,
        reasonCode: dropsData
          ? CODE.migrationDropsData
          : lossy !== undefined
            ? CODE.migrationAffinity
            : CODE.migrationRebuild,
        reasonParams: dropsData ? { object: now.name } : params,
      });
      continue;
    }

    // ALTER TABLE steps.
    // A structural change that is still "simple" is a rename.
    if (own?.change === 'changed') {
      step(
        'alters',
        'rename',
        'ALTER TABLE',
        `ALTER TABLE ${q(was.name)} RENAME TO ${q(now.name)}`,
        [ref(own)],
      );
    }
    for (const e of tableEntries) {
      if (e.objectType !== 'field') continue;
      if (e.change === 'added') {
        const add = columnDefinitionOf(after, now, e.after);
        step('alters', 'alter', 'ALTER TABLE', `ALTER TABLE ${q(now.name)} ADD COLUMN ${add}`, [
          ref(e),
        ]);
      } else if (e.change === 'removed') {
        step(
          'alters',
          'drop',
          'ALTER TABLE',
          `ALTER TABLE ${q(now.name)} DROP COLUMN ${q(e.before.name)}`,
          [ref(e)],
          {
            destructive: true,
            reasonCode: CODE.migrationDropsData,
            reasonParams: { object: `${now.name}.${e.before.name}` },
          },
        );
      } else {
        step(
          'alters',
          'rename',
          'ALTER TABLE',
          `ALTER TABLE ${q(now.name)} RENAME COLUMN ${q(e.before.name)} TO ${q(e.after.name)}`,
          [ref(e)],
        );
      }
    }
  }

  // Indexes on tables that weren't rebuilt (a rebuild recreates its table's indexes).
  for (const entry of entries.filter((e) => e.objectType === 'index')) {
    const owner = entry.ownerEntityId;
    if (owner === undefined || rebuilt.has(owner)) continue;
    const ownEntry = byTable.get(owner)?.find((e) => e.objectType === 'entity');
    if (ownEntry?.change === 'added' || ownEntry?.change === 'removed') continue;
    if (entry.change !== 'added') {
      step('drops', 'drop', 'DROP INDEX', `DROP INDEX IF EXISTS ${q(entry.before.name)}`, [
        ref(entry),
      ]);
    }
    if (entry.change !== 'removed') {
      const ix = after.objects.index[entry.id];
      const text = ix === undefined ? null : createIndexText(after, ix);
      if (text !== null) step('creates', 'create', 'CREATE INDEX', text, [ref(entry)]);
    }
  }

  const ordered = drafts
    .map((d, i) => ({ d, i }))
    .sort((a, b) => compareMigrationSteps(a.d, b.d) || a.i - b.i)
    .map(({ d }, ordinal): MigrationStep => ({
      ...d,
      ordinal,
      commentedOut: d.destructive && !options.allowDestructive,
    }));
  const rebuilds = ordered.some((s) => s.requiresTableRewrite);
  return Promise.resolve({
    steps: ordered,
    summary: {
      total: ordered.length,
      destructive: ordered.filter((s) => s.destructive).length,
      lossy: ordered.filter((s) => s.lossy).length,
      rewrites: ordered.filter((s) => s.requiresTableRewrite).length,
    },
    unsupported,
    diagnostics: [],
    transaction: options.transactional
      ? rebuilds
        ? {
            begin: 'PRAGMA foreign_keys = OFF;\nBEGIN',
            commit: 'PRAGMA foreign_key_check;\nCOMMIT;\nPRAGMA foreign_keys = ON',
          }
        : { begin: 'BEGIN', commit: 'COMMIT' }
      : null,
  });
}

/** One column's definition, as `CREATE TABLE` would write it. */
function columnDefinitionOf(model: SchemaModel, table: Entity, field: Field): string {
  const lone = createTableText(
    {
      ...model,
      objects: {
        ...model.objects,
        field: { [field.id]: field },
        constraint: {},
        link: {},
      },
    },
    table,
  );
  return lone.split('\n')[1]?.trim() ?? '';
}

export const MIGRATION_GENERATOR: MigrationGenerator = {
  generate: generateMigration,
};
