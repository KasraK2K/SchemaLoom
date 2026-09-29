import {
  compareMigrationSteps,
  entryIsDestructive,
  entryRiskKey,
  needsMigrationStep,
  type CustomType,
  type DiagnosticParam,
  type DiffEntry,
  type Entity,
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
import { typeChangeRisk } from './annotate.js';
import {
  addConstraint,
  columnDefinition,
  constraintBody,
  createIndex,
  createSchema,
  createTable,
  createView,
  enableRowLevelSecurity,
  foreignKeyBody,
  propBool,
  propString,
  propStringArray,
  qualify,
  quoteIdentifier,
} from './export-ddl.js';
import {
  ENTITY_SUBJECT,
  compare,
  customTypeStatement,
  entityDepths,
  indexColumns,
  renderType,
} from './exporter.js';
import { CODE } from './messages.js';
import { quoteLiteral } from './sql-text.js';

/**
 * Doc 03 §11.2 — the PostgreSQL migration generator.
 *
 * WHICH NAME A STEP USES depends on when it runs, so the phases are chosen to make that one
 * rule rather than a case per object:
 *
 *  - `pre`     renames first (namespaces, types, tables, then their children), then
 *              CREATE SCHEMA / CREATE TYPE, then SET SCHEMA and enum ADD VALUE. After `pre`
 *              every surviving object is at its AFTER name.
 *  - `drops`   links, constraints, indexes, views, columns, tables — addressed at the
 *              current (post-rename) location, never CASCADE: a dependency the diff does not
 *              account for fails loudly instead of silently taking something with it.
 *  - `alters`  column type / NOT NULL / DEFAULT, row-level security.
 *  - `creates` CREATE TABLE, ADD COLUMN, CREATE VIEW.
 *  - `post`    constraints, indexes and foreign keys (which need the columns), then DROP TYPE
 *              and DROP SCHEMA — last, because a column may stop using the type in `alters`.
 *
 * An entry the generator cannot express goes to `unsupported` WHOLE, with no steps: half an
 * entry's DDL next to a "needs a manual step" line is two answers to one question.
 */

interface Pending {
  readonly phase: MigrationPhase;
  readonly operation: MigrationOperation;
  /** dependency rank inside (phase, operation) */
  readonly rank: number;
  /** §10.1's tie-break, `(namespaceName, objectName, id)` */
  readonly sort: readonly [string, string, string];
  readonly kind: string;
  readonly text: string;
  readonly destructive?: boolean;
  readonly lossy?: boolean;
  readonly requiresTableRewrite?: boolean;
  readonly reasonCode?: string;
  readonly reasonParams?: Readonly<Record<string, DiagnosticParam>>;
  /** mutable while planning: implied entries (renumbered ordinals, retyped columns) join */
  readonly covers: IrObjectRef[];
}

const refOf = (entry: DiffEntry): IrObjectRef => ({ type: entry.objectType, id: entry.id });
const keyOf = (type: IrObjectType, id: Id): string => entryRiskKey({ objectType: type, id });

type Changed<T extends IrObjectType> = Extract<DiffEntry, { objectType: T; change: 'changed' }>;

const structuralRoots = (entry: DiffEntry): ReadonlySet<string> =>
  new Set(
    entry.change === 'changed'
      ? entry.properties.filter((p) => p.severity === 'structural').map((p) => p.path[0] ?? '')
      : [],
  );

/** Whether a changed entry's structural properties are exactly `name` — a plain rename. */
const onlyRenamed = (entry: DiffEntry): boolean => {
  const roots = structuralRoots(entry);
  return roots.size === 1 && roots.has('name');
};

const VIEW_KINDS: ReadonlySet<string> = new Set(['view', 'materializedView']);

class Planner {
  readonly pending: Pending[] = [];
  readonly unsupported: UnsupportedChange[] = [];
  private readonly stepsByKey = new Map<string, Pending[]>();
  private readonly unsupportedKeys = new Set<string>();

  add(step: Pending): Pending {
    this.pending.push(step);
    for (const ref of step.covers) {
      const key = keyOf(ref.type, ref.id);
      this.stepsByKey.set(key, [...(this.stepsByKey.get(key) ?? []), step]);
    }
    return step;
  }

  /** An entry whose change is accounted for by another entry's step. */
  attach(entry: DiffEntry, to: string): boolean {
    const step = this.stepsByKey.get(to)?.[0];
    if (step === undefined) return false;
    step.covers.push(refOf(entry));
    this.stepsByKey.set(entryRiskKey(entry), [step]);
    return true;
  }

  isHandled(key: string): boolean {
    return this.stepsByKey.has(key) || this.unsupportedKeys.has(key);
  }

  refuse(entry: DiffEntry, property: string, reason: string): void {
    const key = entryRiskKey(entry);
    if (this.unsupportedKeys.has(key)) return;
    this.unsupportedKeys.add(key);
    this.unsupported.push({
      entry: refOf(entry),
      changeCode: CODE.migrationChange,
      changeParams: { object: refOf(entry), change: entry.change, property },
      reasonCode: CODE.migrationUnsupported,
      reasonParams: { reason },
    });
  }
}

function generatePlan(input: MigrationInput): MigrationPlan {
  const { diff, before, after, options } = input;
  const plan = new Planner();
  const relevant = diff.entries.filter(needsMigrationStep);
  const entryAt = new Map(diff.entries.map((e) => [entryRiskKey(e), e]));
  const entryOf = (type: IrObjectType, id: Id): DiffEntry | undefined =>
    entryAt.get(keyOf(type, id));

  // --- names -------------------------------------------------------------------------------
  const nsNow = (id: Id): string =>
    after.objects.namespace[id]?.name ?? before.objects.namespace[id]?.name ?? '';
  const nsAfter = (id: Id): string => after.objects.namespace[id]?.name ?? '';
  /** Where an entity is once `pre` has run: its after location if it survives. */
  const entityNow = (id: Id): string => {
    const a = after.objects.entity[id];
    if (a !== undefined) return qualify(nsAfter(a.namespaceId), a.name);
    const b = before.objects.entity[id];
    return b === undefined ? '' : qualify(nsNow(b.namespaceId), b.name);
  };
  const entityNsNow = (id: Id): string => {
    const a = after.objects.entity[id];
    if (a !== undefined) return nsAfter(a.namespaceId);
    const b = before.objects.entity[id];
    return b === undefined ? '' : nsNow(b.namespaceId);
  };
  const sortOf = (entityId: Id, name: string, id: Id): readonly [string, string, string] => {
    const e = after.objects.entity[entityId] ?? before.objects.entity[entityId];
    return [entityNsNow(entityId), e === undefined ? name : `${e.name}.${name}`, id];
  };
  const typeContext = (model: SchemaModel, nsId: Id) => ({
    customTypes: Object.values(model.objects.customType),
    namespaceName: model.objects.namespace[nsId]?.name ?? null,
  });

  const destructiveStep = (entry: DiffEntry): Partial<Pending> =>
    entryIsDestructive(diff, entry)
      ? {
          destructive: true,
          reasonCode: CODE.migrationDropsData,
          reasonParams: { object: refOf(entry) },
        }
      : {};

  // --- entities whose DDL is rebuilt or dropped as a whole ---------------------------------
  const removedEntities = new Set(
    relevant.filter((e) => e.objectType === 'entity' && e.change === 'removed').map((e) => e.id),
  );
  const addedEntities = new Set(
    relevant.filter((e) => e.objectType === 'entity' && e.change === 'added').map((e) => e.id),
  );
  const ownedBy = (entityId: Id): DiffEntry[] =>
    relevant.filter((e) => e.objectType !== 'entity' && e.ownerEntityId === entityId);

  // A table that became a view (or back) is not an ALTER. The entry and everything it owns
  // needs a hand-written step.
  const kindChanged = new Set(
    relevant
      .filter((e): e is Changed<'entity'> => e.objectType === 'entity' && e.change === 'changed')
      .filter((e) => structuralRoots(e).has('kind'))
      .map((e) => e.id),
  );
  for (const id of kindChanged) {
    const own = entryOf('entity', id);
    if (own !== undefined)
      plan.refuse(own, 'kind', 'PostgreSQL cannot turn a table into a view in place');
    for (const child of ownedBy(id)) plan.refuse(child, 'entityId', 'its table changed kind');
  }

  /** Views are recreated whole on any structural change: a view IS its definition. */
  const recreatedViews = new Set<Id>();
  for (const e of relevant) {
    // An index change on a materialized view is an index change, not a new view.
    if (e.objectType !== 'entity' && e.objectType !== 'field') continue;
    const id = e.objectType === 'entity' ? e.id : e.ownerEntityId;
    if (id === undefined || kindChanged.has(id) || removedEntities.has(id) || addedEntities.has(id))
      continue;
    const view = after.objects.entity[id];
    if (view !== undefined && VIEW_KINDS.has(view.kind)) recreatedViews.add(id);
  }

  const beforeDepths = entityDepths(Object.values(before.objects.entity));
  const afterDepths = entityDepths(Object.values(after.objects.entity));

  const fieldsOf = (model: SchemaModel, entityId: Id): Field[] =>
    Object.values(model.objects.field)
      .filter((f) => f.entityId === entityId)
      .sort((a, b) => a.ordinal - b.ordinal || compare(a.id, b.id));
  const afterFieldMap = (entityId: Id): Map<Id, Field> =>
    new Map(fieldsOf(after, entityId).map((f) => [f.id, f]));
  const columnNames = (ids: readonly Id[]): string[] | null => {
    const names: string[] = [];
    for (const id of ids) {
      const f = after.objects.field[id];
      if (f === undefined) return null;
      names.push(f.name);
    }
    return names;
  };

  // --- the statements, one family at a time ------------------------------------------------

  const createViewStep = (entity: Entity, covers: IrObjectRef[]): boolean => {
    const body = propString(entity.engineProps, 'viewDefinition');
    if (body === undefined) return false;
    const kind = entity.kind === 'materializedView' ? 'materializedView' : 'view';
    plan.add({
      phase: 'creates',
      operation: 'create',
      rank: 200 + (afterDepths.get(entity.id) ?? 0),
      sort: [nsAfter(entity.namespaceId), entity.name, entity.id],
      kind: kind === 'view' ? 'CREATE VIEW' : 'CREATE MATERIALIZED VIEW',
      text: createView(
        kind,
        qualify(nsAfter(entity.namespaceId), entity.name),
        body,
        entity.engineProps,
        false,
      ),
      covers,
    });
    return true;
  };

  const createIndexStep = (index: Index, covers: IrObjectRef[]): boolean => {
    const entity = after.objects.entity[index.entityId];
    const columns = indexColumns(index, afterFieldMap(index.entityId));
    if (entity === undefined || columns === null) return false;
    plan.add({
      phase: 'post',
      operation: 'create',
      rank: 1,
      sort: sortOf(index.entityId, index.name, index.id),
      kind: 'CREATE INDEX',
      text: createIndex(
        index.name,
        qualify(nsAfter(entity.namespaceId), entity.name),
        index.kind,
        index.isUnique,
        columns.keys,
        columns.included,
        index.engineProps,
      ),
      covers,
    });
    return true;
  };

  const dropEntityStep = (entity: Entity, covers: IrObjectRef[], extra: Partial<Pending>): void => {
    const subject = ENTITY_SUBJECT[entity.kind] ?? 'TABLE';
    const view = VIEW_KINDS.has(entity.kind);
    const depth = beforeDepths.get(entity.id) ?? 0;
    plan.add({
      phase: 'drops',
      operation: 'drop',
      // Dependent views before what they select from; views before columns and tables.
      rank: view ? 100 - depth : 300 - depth,
      sort: [nsNow(entity.namespaceId), entity.name, entity.id],
      kind: `DROP ${subject}`,
      text: `DROP ${subject} ${qualify(nsNow(entity.namespaceId), entity.name)}`,
      covers,
      ...extra,
    });
  };

  // Views: drop at the old name (their renames are not run), recreate from `after`, and for a
  // materialized view put back every index the drop took with it.
  for (const id of [...recreatedViews].sort(compare)) {
    const b = before.objects.entity[id];
    const a = after.objects.entity[id];
    const own = entryOf('entity', id);
    const covers = [...(own === undefined ? [] : [own]), ...ownedBy(id)].map(refOf);
    if (
      b === undefined ||
      a === undefined ||
      propString(a.engineProps, 'viewDefinition') === undefined
    ) {
      for (const e of [...(own === undefined ? [] : [own]), ...ownedBy(id)]) {
        plan.refuse(e, 'viewDefinition', 'the view has no definition');
      }
      continue;
    }
    dropEntityStep(b, covers, {});
    createViewStep(a, covers);
    for (const index of Object.values(after.objects.index).filter((i) => i.entityId === id)) {
      const entry = entryOf('index', index.id);
      createIndexStep(index, entry === undefined ? covers : [refOf(entry)]);
    }
  }

  const skip = (e: DiffEntry): boolean => {
    const owner = e.objectType === 'entity' ? e.id : e.ownerEntityId;
    return owner !== undefined && (recreatedViews.has(owner) || kindChanged.has(owner));
  };

  // --- namespaces ---
  for (const e of relevant) {
    if (e.objectType !== 'namespace') continue;
    if (e.change === 'added') {
      plan.add({
        phase: 'pre',
        operation: 'create',
        rank: 0,
        sort: [e.after.name, e.after.name, e.id],
        kind: 'CREATE SCHEMA',
        text: createSchema(e.after.name, e.after.engineProps, e.after.isDefault),
        covers: [refOf(e)],
      });
    } else if (e.change === 'removed') {
      plan.add({
        phase: 'post',
        operation: 'drop',
        rank: 1,
        sort: [e.before.name, e.before.name, e.id],
        kind: 'DROP SCHEMA',
        text: `DROP SCHEMA ${quoteIdentifier(e.before.name)}`,
        covers: [refOf(e)],
        ...destructiveStep(e),
      });
    } else {
      const roots = structuralRoots(e);
      const odd = [...roots].find((r) => r !== 'name' && r !== 'engineProps');
      const props = e.properties.filter((p) => p.path[0] === 'engineProps');
      if (odd !== undefined || props.some((p) => p.path[1] !== 'owner')) {
        plan.refuse(e, odd ?? 'engineProps', 'no ALTER SCHEMA form for this change');
        continue;
      }
      const sort: [string, string, string] = [e.after.name, e.after.name, e.id];
      if (roots.has('name')) {
        plan.add({
          phase: 'pre',
          operation: 'rename',
          rank: 0,
          sort,
          kind: 'ALTER SCHEMA RENAME',
          text: `ALTER SCHEMA ${quoteIdentifier(e.before.name)} RENAME TO ${quoteIdentifier(e.after.name)}`,
          covers: [refOf(e)],
        });
      }
      if (props.length > 0) {
        const owner = propString(e.after.engineProps, 'owner');
        if (owner === undefined) {
          plan.refuse(e, 'engineProps.owner', 'a schema always has an owner');
          continue;
        }
        plan.add({
          phase: 'pre',
          operation: 'alter',
          rank: 0,
          sort,
          kind: 'ALTER SCHEMA OWNER',
          text: `ALTER SCHEMA ${quoteIdentifier(e.after.name)} OWNER TO ${quoteIdentifier(owner)}`,
          covers: [refOf(e)],
        });
      }
    }
  }

  // --- custom types ---
  const typeSubject = (t: CustomType): string => (t.kind === 'domain' ? 'DOMAIN' : 'TYPE');
  for (const e of relevant) {
    if (e.objectType !== 'customType') continue;
    if (e.change === 'added') {
      const statement = customTypeStatement(e.after, nsAfter(e.after.namespaceId));
      if (statement === null) {
        plan.refuse(e, 'kind', `a ${e.after.kind} type cannot be rendered`);
        continue;
      }
      plan.add({
        phase: 'pre',
        operation: 'create',
        rank: 1,
        sort: [nsAfter(e.after.namespaceId), e.after.name, e.id],
        kind: statement.kind,
        text: statement.text,
        covers: [refOf(e)],
      });
      continue;
    }
    if (e.change === 'removed') {
      plan.add({
        phase: 'post',
        operation: 'drop',
        rank: 0,
        sort: [nsNow(e.before.namespaceId), e.before.name, e.id],
        kind: `DROP ${typeSubject(e.before)}`,
        text: `DROP ${typeSubject(e.before)} ${qualify(nsNow(e.before.namespaceId), e.before.name)}`,
        covers: [refOf(e)],
        ...destructiveStep(e),
      });
      continue;
    }
    const roots = structuralRoots(e);
    const odd = [...roots].find((r) => r !== 'name' && r !== 'namespaceId' && r !== 'engineProps');
    const propPaths = e.properties.filter((p) => p.path[0] === 'engineProps');
    if (
      odd !== undefined ||
      propPaths.some((p) => p.path[1] !== 'labels') ||
      (propPaths.length > 0 && e.after.kind !== 'enum')
    ) {
      plan.refuse(e, odd ?? 'engineProps', 'no ALTER TYPE form for this change');
      continue;
    }
    const beforeLabels = propStringArray(e.before.engineProps, 'labels') ?? [];
    const afterLabels = propStringArray(e.after.engineProps, 'labels') ?? [];
    const kept = afterLabels.filter((l) => beforeLabels.includes(l));
    if (kept.length !== beforeLabels.length || kept.some((l, i) => l !== beforeLabels[i])) {
      plan.refuse(e, 'engineProps.labels', 'PostgreSQL cannot remove or reorder enum labels');
      continue;
    }
    const subject = typeSubject(e.after);
    const sort: [string, string, string] = [nsAfter(e.after.namespaceId), e.after.name, e.id];
    if (roots.has('name')) {
      plan.add({
        phase: 'pre',
        operation: 'rename',
        rank: 1,
        sort,
        kind: `ALTER ${subject} RENAME`,
        text: `ALTER ${subject} ${qualify(nsNow(e.before.namespaceId), e.before.name)} RENAME TO ${quoteIdentifier(e.after.name)}`,
        covers: [refOf(e)],
      });
    }
    if (roots.has('namespaceId')) {
      plan.add({
        phase: 'pre',
        operation: 'alter',
        rank: 1,
        sort,
        kind: `ALTER ${subject} SET SCHEMA`,
        text: `ALTER ${subject} ${qualify(nsNow(e.before.namespaceId), e.after.name)} SET SCHEMA ${quoteIdentifier(nsAfter(e.after.namespaceId))}`,
        covers: [refOf(e)],
      });
    }
    // In after-order, each new label AFTER its predecessor (emitted just before it), or, at
    // the head, BEFORE the first label that already exists.
    const firstKept = kept[0];
    afterLabels.forEach((label, i) => {
      if (beforeLabels.includes(label)) return;
      const previous = afterLabels[i - 1];
      const anchor =
        previous !== undefined
          ? ` AFTER ${quoteLiteral(previous)}`
          : firstKept !== undefined
            ? ` BEFORE ${quoteLiteral(firstKept)}`
            : '';
      plan.add({
        phase: 'pre',
        operation: 'alter',
        rank: 2,
        sort,
        kind: 'ALTER TYPE ADD VALUE',
        text: `ALTER TYPE ${qualify(nsAfter(e.after.namespaceId), e.after.name)} ADD VALUE ${quoteLiteral(label)}${anchor}`,
        covers: [refOf(e)],
      });
    });
  }

  // --- entities (tables and views; recreated views are done) ---
  for (const e of relevant) {
    if (e.objectType !== 'entity' || skip(e)) continue;
    if (e.change === 'removed') {
      // Everything the table owned goes with it: no DROP COLUMN for a dropped table.
      dropEntityStep(e.before, [e, ...ownedBy(e.id)].map(refOf), destructiveStep(e));
      continue;
    }
    if (e.change === 'added') {
      const entity = e.after;
      const addedFields = ownedBy(e.id).filter(
        (x) => x.objectType === 'field' && x.change === 'added',
      );
      const covers = [e, ...addedFields].map(refOf);
      if (VIEW_KINDS.has(entity.kind)) {
        if (!createViewStep(entity, covers)) {
          for (const x of [e, ...addedFields])
            plan.refuse(x, 'viewDefinition', 'the view has no definition');
        }
        continue;
      }
      const ctx = typeContext(after, entity.namespaceId);
      const columns = fieldsOf(after, e.id).map((f) =>
        columnDefinition({
          name: f.name,
          type: renderType(f, ctx, entity.namespaceId, nsAfter),
          isNullable: f.isNullable,
          props: f.engineProps,
        }),
      );
      const qualified = qualify(nsAfter(entity.namespaceId), entity.name);
      const sort: [string, string, string] = [nsAfter(entity.namespaceId), entity.name, entity.id];
      plan.add({
        phase: 'creates',
        operation: 'create',
        rank: 0,
        sort,
        kind: 'CREATE TABLE',
        text: createTable(qualified, columns, entity.engineProps, false),
        covers,
      });
      if (propBool(entity.engineProps, 'rowLevelSecurity')) {
        plan.add({
          phase: 'post',
          operation: 'alter',
          rank: 0,
          sort,
          kind: 'ALTER TABLE',
          text: enableRowLevelSecurity(qualified),
          covers: [refOf(e)],
        });
      }
      continue;
    }

    // A changed table.
    const roots = structuralRoots(e);
    const odd = [...roots].find((r) => r !== 'name' && r !== 'namespaceId' && r !== 'engineProps');
    const propPaths = e.properties.filter((p) => p.path[0] === 'engineProps');
    if (odd !== undefined || propPaths.some((p) => p.path[1] !== 'rowLevelSecurity')) {
      plan.refuse(
        e,
        odd ?? propPaths.find((p) => p.path[1] !== 'rowLevelSecurity')?.path.join('.') ?? '',
        'no ALTER TABLE form for this change',
      );
      continue;
    }
    const sort: [string, string, string] = [nsAfter(e.after.namespaceId), e.after.name, e.id];
    if (roots.has('name')) {
      plan.add({
        phase: 'pre',
        operation: 'rename',
        rank: 2,
        sort,
        kind: 'ALTER TABLE RENAME',
        text: `ALTER TABLE ${qualify(nsNow(e.before.namespaceId), e.before.name)} RENAME TO ${quoteIdentifier(e.after.name)}`,
        covers: [refOf(e)],
      });
    }
    if (roots.has('namespaceId')) {
      plan.add({
        phase: 'pre',
        operation: 'alter',
        rank: 3,
        sort,
        kind: 'ALTER TABLE SET SCHEMA',
        text: `ALTER TABLE ${qualify(nsNow(e.before.namespaceId), e.after.name)} SET SCHEMA ${quoteIdentifier(nsAfter(e.after.namespaceId))}`,
        covers: [refOf(e)],
      });
    }
    if (propPaths.length > 0) {
      const on = propBool(e.after.engineProps, 'rowLevelSecurity');
      plan.add({
        phase: 'alters',
        operation: 'alter',
        rank: 1,
        sort,
        kind: 'ALTER TABLE',
        text: `ALTER TABLE ${entityNow(e.id)} ${on ? 'ENABLE' : 'DISABLE'} ROW LEVEL SECURITY`,
        covers: [refOf(e)],
      });
    }
  }

  /** Table and column name while `pre` renames children: renamed, not yet moved. */
  const entityMid = (id: Id): string => {
    const a = after.objects.entity[id];
    const b = before.objects.entity[id];
    return a === undefined || b === undefined
      ? entityNow(id)
      : qualify(nsNow(b.namespaceId), a.name);
  };

  // --- fields (of tables) ---
  const ordinalOnly: Changed<'field'>[] = [];
  const reshapedTables = new Map<Id, DiffEntry>(); // table -> an ADD/DROP COLUMN entry
  for (const e of relevant) {
    if (e.objectType !== 'field' || skip(e)) continue;
    if (e.change === 'added') {
      if (addedEntities.has(e.after.entityId)) continue; // in its CREATE TABLE
      const entity = after.objects.entity[e.after.entityId];
      if (entity === undefined) continue;
      plan.add({
        phase: 'creates',
        operation: 'create',
        rank: 100,
        sort: sortOf(entity.id, e.after.name, e.id),
        kind: 'ALTER TABLE ADD COLUMN',
        text: `ALTER TABLE ${entityNow(entity.id)} ADD COLUMN ${columnDefinition({
          name: e.after.name,
          type: renderType(
            e.after,
            typeContext(after, entity.namespaceId),
            entity.namespaceId,
            nsAfter,
          ),
          isNullable: e.after.isNullable,
          props: e.after.engineProps,
        })}`,
        covers: [refOf(e)],
      });
      if (!reshapedTables.has(entity.id)) reshapedTables.set(entity.id, e);
      continue;
    }
    if (e.change === 'removed') {
      if (removedEntities.has(e.before.entityId)) continue; // in its DROP TABLE
      plan.add({
        phase: 'drops',
        operation: 'drop',
        rank: 200,
        sort: sortOf(e.before.entityId, e.before.name, e.id),
        kind: 'ALTER TABLE DROP COLUMN',
        text: `ALTER TABLE ${entityNow(e.before.entityId)} DROP COLUMN ${quoteIdentifier(e.before.name)}`,
        covers: [refOf(e)],
        ...destructiveStep(e),
      });
      if (!reshapedTables.has(e.before.entityId)) reshapedTables.set(e.before.entityId, e);
      continue;
    }

    const roots = structuralRoots(e);
    const defaultOnly = (p: { path: readonly string[] }) =>
      p.path[0] !== 'engineProps' || p.path[1] === 'default';
    const odd = [...roots].find(
      (r) => !['name', 'type', 'isNullable', 'ordinal', 'engineProps'].includes(r),
    );
    const badProp = e.properties.find((p) => p.severity === 'structural' && !defaultOnly(p));
    if (odd !== undefined || badProp !== undefined) {
      plan.refuse(e, odd ?? badProp?.path.join('.') ?? '', 'no ALTER COLUMN form for this change');
      continue;
    }
    if (roots.size === 1 && roots.has('ordinal')) {
      ordinalOnly.push(e);
      continue;
    }
    const entity = after.objects.entity[e.after.entityId];
    if (entity === undefined) continue;
    const table = entityNow(entity.id);
    const column = quoteIdentifier(e.after.name);
    const sort = sortOf(entity.id, e.after.name, e.id);
    if (roots.has('name')) {
      plan.add({
        phase: 'pre',
        operation: 'rename',
        rank: 3,
        sort,
        kind: 'ALTER TABLE RENAME COLUMN',
        text: `ALTER TABLE ${entityMid(entity.id)} RENAME COLUMN ${quoteIdentifier(e.before.name)} TO ${column}`,
        covers: [refOf(e)],
      });
    }
    if (roots.has('type')) {
      const risk = typeChangeRisk(before, e.before, after, e.after);
      const customId = e.after.type.customTypeId;
      const carried =
        risk.same &&
        customId !== null &&
        customId !== undefined &&
        plan.attach(e, keyOf('customType', customId));
      if (!carried) {
        const type = renderType(
          e.after,
          typeContext(after, entity.namespaceId),
          entity.namespaceId,
          nsAfter,
        );
        plan.add({
          phase: 'alters',
          operation: 'alter',
          rank: 0,
          sort,
          kind: 'ALTER TABLE ALTER COLUMN TYPE',
          text: `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${type}${risk.lossy ? ` USING ${column}::${type}` : ''}`,
          lossy: risk.lossy,
          requiresTableRewrite: risk.requiresTableRewrite,
          ...(risk.lossy
            ? {
                reasonCode: CODE.migrationTypeNarrowed,
                reasonParams: { from: risk.from, to: risk.to },
              }
            : risk.requiresTableRewrite
              ? {
                  reasonCode: CODE.migrationTypeRewrite,
                  reasonParams: { from: risk.from, to: risk.to },
                }
              : {}),
          covers: [refOf(e)],
        });
      }
    }
    if (roots.has('isNullable')) {
      const adding = !e.after.isNullable;
      plan.add({
        phase: 'alters',
        operation: 'alter',
        rank: 0,
        sort,
        kind: adding ? 'ALTER TABLE SET NOT NULL' : 'ALTER TABLE DROP NOT NULL',
        text: `ALTER TABLE ${table} ALTER COLUMN ${column} ${adding ? 'SET' : 'DROP'} NOT NULL`,
        ...(adding
          ? {
              requiresTableRewrite: true,
              reasonCode: CODE.migrationNotNull,
              reasonParams: { object: refOf(e) },
            }
          : {}),
        covers: [refOf(e)],
      });
    }
    if (roots.has('engineProps')) {
      const value = propString(e.after.engineProps, 'default');
      plan.add({
        phase: 'alters',
        operation: 'alter',
        rank: 0,
        sort,
        kind: value === undefined ? 'ALTER TABLE DROP DEFAULT' : 'ALTER TABLE SET DEFAULT',
        text: `ALTER TABLE ${table} ALTER COLUMN ${column} ${value === undefined ? 'DROP DEFAULT' : `SET DEFAULT ${value}`}`,
        covers: [refOf(e)],
      });
    }
  }

  // Ordinals: an ADD or DROP COLUMN renumbers its siblings densely, and that renumbering is
  // what the step already does. A genuine REORDER is not something PostgreSQL can do in place.
  for (const e of ordinalOnly) {
    const tableId = e.after.entityId;
    const survivors = fieldsOf(before, tableId).filter(
      (f) => after.objects.field[f.id] !== undefined,
    );
    const afterOrder = [...survivors].sort(
      (x, y) =>
        (after.objects.field[x.id]?.ordinal ?? 0) - (after.objects.field[y.id]?.ordinal ?? 0),
    );
    const reordered = afterOrder.some((f, i) => f.id !== survivors[i]?.id);
    const cause = reshapedTables.get(tableId);
    if (reordered || cause === undefined || !plan.attach(e, entryRiskKey(cause))) {
      plan.refuse(e, 'ordinal', 'PostgreSQL cannot reorder columns in place');
    }
  }

  // --- constraints and links (both are ALTER TABLE … CONSTRAINT) ---
  const dropConstraint = (e: DiffEntry, entityId: Id, name: string, rank: number): void => {
    plan.add({
      phase: 'drops',
      operation: 'drop',
      rank,
      sort: sortOf(entityId, name, e.id),
      kind: 'ALTER TABLE DROP CONSTRAINT',
      text: `ALTER TABLE ${entityNow(entityId)} DROP CONSTRAINT ${quoteIdentifier(name)}`,
      covers: [refOf(e)],
    });
  };
  const renameConstraint = (e: DiffEntry, entityId: Id, from: string, to: string): void => {
    plan.add({
      phase: 'pre',
      operation: 'rename',
      rank: 3,
      sort: sortOf(entityId, to, e.id),
      kind: 'ALTER TABLE RENAME CONSTRAINT',
      text: `ALTER TABLE ${entityMid(entityId)} RENAME CONSTRAINT ${quoteIdentifier(from)} TO ${quoteIdentifier(to)}`,
      covers: [refOf(e)],
    });
  };

  for (const e of relevant) {
    if (e.objectType !== 'constraint' || skip(e)) continue;
    const addIt = (): void => {
      if (e.change === 'removed') return;
      const c = e.after;
      const names = columnNames(c.fieldIds);
      const body = names === null ? undefined : constraintBody(c.kind, names, c.engineProps);
      if (body === undefined) {
        plan.refuse(e, 'kind', `a ${c.kind} constraint cannot be rendered`);
        return;
      }
      plan.add({
        phase: 'post',
        operation: 'create',
        rank: 0,
        sort: sortOf(c.entityId, c.name, c.id),
        kind: 'ALTER TABLE ADD CONSTRAINT',
        text: addConstraint(entityNow(c.entityId), c.name, body),
        covers: [refOf(e)],
      });
    };
    if (e.change === 'added') {
      addIt();
      continue;
    }
    const b = e.before;
    if (e.change === 'removed' && removedEntities.has(b.entityId)) continue;
    if (b.name === '') {
      plan.refuse(e, 'name', 'an unnamed constraint cannot be dropped by name');
      continue;
    }
    if (e.change === 'changed' && structuralRoots(e).has('entityId')) {
      plan.refuse(e, 'entityId', 'a constraint cannot move to another table');
      continue;
    }
    if (e.change === 'changed' && onlyRenamed(e)) {
      renameConstraint(e, b.entityId, b.name, e.after.name);
      continue;
    }
    dropConstraint(e, b.entityId, b.name, 1);
    addIt();
  }

  for (const e of relevant) {
    if (e.objectType !== 'link' || skip(e)) continue;
    const link: Link = e.change === 'removed' ? e.before : e.after;
    if (link.kind !== 'foreignKey') {
      plan.refuse(e, 'kind', `a ${link.kind} link has no DDL form`);
      continue;
    }
    const addIt = (): void => {
      if (e.change === 'removed') return;
      const l = e.after;
      const from = columnNames(l.from.fieldIds);
      const to = columnNames(l.to.fieldIds);
      if (from === null || to === null || from.length === 0 || to.length === 0) {
        plan.refuse(e, 'fieldIds', 'its columns are not in the target schema');
        return;
      }
      plan.add({
        phase: 'post',
        operation: 'create',
        rank: 2,
        sort: sortOf(l.from.entityId, l.name, l.id),
        kind: 'ALTER TABLE ADD CONSTRAINT',
        text: addConstraint(
          entityNow(l.from.entityId),
          l.name,
          foreignKeyBody(from, entityNow(l.to.entityId), to, l.engineProps),
        ),
        covers: [refOf(e)],
      });
    };
    if (e.change === 'added') {
      addIt();
      continue;
    }
    const b = e.before;
    // Dropped explicitly even when its own table goes too: `DROP TABLE` without CASCADE
    // refuses a table another dropped table still references, and tables drop in name order.
    if (b.name === '') {
      if (e.change === 'removed' && removedEntities.has(b.from.entityId)) continue; // in DROP TABLE
      plan.refuse(e, 'name', 'an unnamed foreign key cannot be dropped by name');
      continue;
    }
    if (e.change === 'changed' && onlyRenamed(e)) {
      renameConstraint(e, b.from.entityId, b.name, e.after.name);
      continue;
    }
    dropConstraint(e, b.from.entityId, b.name, 0);
    addIt();
  }

  // --- indexes ---
  for (const e of relevant) {
    if (e.objectType !== 'index' || skip(e)) continue;
    if (e.change === 'added') {
      if (!createIndexStep(e.after, [refOf(e)]))
        plan.refuse(e, 'columns', 'it references a column not in the target schema');
      continue;
    }
    const b = e.before;
    if (e.change === 'removed' && removedEntities.has(b.entityId)) continue;
    if (e.change === 'changed' && structuralRoots(e).has('entityId')) {
      plan.refuse(e, 'entityId', 'an index cannot move to another table');
      continue;
    }
    if (e.change === 'changed' && onlyRenamed(e)) {
      plan.add({
        phase: 'pre',
        operation: 'rename',
        rank: 3,
        sort: sortOf(b.entityId, e.after.name, e.id),
        kind: 'ALTER INDEX RENAME',
        text: `ALTER INDEX ${qualify(nsNow(before.objects.entity[b.entityId]?.namespaceId ?? ''), b.name)} RENAME TO ${quoteIdentifier(e.after.name)}`,
        covers: [refOf(e)],
      });
      continue;
    }
    plan.add({
      phase: 'drops',
      operation: 'drop',
      rank: 2,
      sort: sortOf(b.entityId, b.name, e.id),
      kind: 'DROP INDEX',
      text: `DROP INDEX ${qualify(entityNsNow(b.entityId), b.name)}`,
      covers: [refOf(e)],
    });
    if (e.change === 'changed' && !createIndexStep(e.after, [refOf(e)])) {
      plan.refuse(e, 'columns', 'it references a column not in the target schema');
    }
  }

  // Guarantee 2 is checked by the conformance suite; this is the belt to its braces — an
  // entry nothing above handled is a bug here, and it must surface rather than vanish.
  for (const e of relevant) {
    if (!plan.isHandled(entryRiskKey(e)))
      plan.refuse(e, e.objectType, 'not handled by this generator');
  }

  return assemble(plan, options.allowDestructive, options.transactional);
}

function assemble(plan: Planner, allowDestructive: boolean, transactional: boolean): MigrationPlan {
  // An entry refused after one of its steps was planned (an ADD half that could not be
  // rendered) must not appear in both places — §11.2 guarantee 2's "never both".
  const refused = new Set(plan.unsupported.map((u) => keyOf(u.entry.type, u.entry.id)));
  const kept = plan.pending
    .map((p) => ({ ...p, covers: p.covers.filter((ref) => !refused.has(keyOf(ref.type, ref.id))) }))
    .filter((p) => p.covers.length > 0);

  const ordered = kept.sort(
    (a, b) =>
      compareMigrationSteps(a, b) ||
      a.rank - b.rank ||
      compare(a.sort[0], b.sort[0]) ||
      compare(a.sort[1], b.sort[1]) ||
      compare(a.sort[2], b.sort[2]),
  );

  const steps = ordered.map((p, ordinal): MigrationStep => {
    const destructive = p.destructive === true;
    return {
      ordinal,
      phase: p.phase,
      operation: p.operation,
      kind: p.kind,
      text: p.text,
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
    // PostgreSQL's DDL is transactional. (`CREATE INDEX CONCURRENTLY` is not, and the exporter
    // emits it only when an index asks for it.)
    transaction: transactional ? { begin: 'BEGIN', commit: 'COMMIT' } : null,
  };
}

export const MIGRATION_GENERATOR: MigrationGenerator = {
  generate(input: MigrationInput): Promise<MigrationPlan> {
    return Promise.resolve(generatePlan(input));
  },
};
