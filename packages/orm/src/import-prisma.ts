import type {
  Constraint,
  CustomType,
  Diagnostic,
  EngineProps,
  Entity,
  Field,
  Id,
  ImportContext,
  ImportedDoc,
  ImportOptions,
  ImportReport,
  ImportResult,
  ImportStatementReport,
  ImportStatementStatus,
  Index,
  IndexColumn,
  IrObjectRef,
  IrObjectType,
  Link,
  Namespace,
  SchemaModel,
  SourceRange,
  TypeRef,
} from '@schemaloom/engine-sdk';
import type { OrmDialect } from './dialect.js';

/**
 * Phase 7b (`docs/phase7/PRISMA-IMPORT.md`) — a `schema.prisma` read into the IR.
 *
 * Prisma's own parser and validator (`@prisma/prisma-schema-wasm`, `get_dmmf`) reads the file,
 * and the engine's ORM type table, the one the export writes from, maps each field back. A
 * statement is a top-level block (§2.3): the block scanner below finds each one's range, and
 * the report accounts for every block. Two facts the parser's output leaves out are read from
 * the block text: a relation's `map:` name, and which models are `view`s.
 */

// --- the parser's output, the parts read here -----------------------------------------------

interface DmmfField {
  readonly name: string;
  readonly dbName?: string | null;
  readonly kind: 'scalar' | 'object' | 'enum' | 'unsupported';
  readonly isList: boolean;
  readonly isRequired: boolean;
  readonly type: string;
  readonly nativeType?: readonly [string, readonly string[]] | null;
  readonly default?: unknown;
  readonly isUpdatedAt?: boolean;
  readonly relationName?: string;
  readonly relationFromFields?: readonly string[];
  readonly relationToFields?: readonly string[];
  readonly relationOnDelete?: string;
  readonly relationOnUpdate?: string;
  readonly documentation?: string;
}

interface DmmfModel {
  readonly name: string;
  readonly dbName: string | null;
  readonly schema: string | null;
  readonly fields: readonly DmmfField[];
  readonly documentation?: string;
}

interface DmmfEnum {
  readonly name: string;
  readonly dbName?: string | null;
  readonly schema?: string | null;
  readonly values: readonly { readonly name: string; readonly dbName?: string | null }[];
}

interface DmmfIndex {
  readonly model: string;
  readonly type: 'id' | 'unique' | 'normal' | 'fulltext';
  readonly dbName?: string | null;
  readonly algorithm?: string;
  readonly fields: readonly {
    readonly name: string;
    readonly sortOrder?: 'asc' | 'desc';
    readonly length?: number;
  }[];
}

interface Datamodel {
  readonly models: readonly DmmfModel[];
  readonly enums: readonly DmmfEnum[];
  readonly indexes: readonly DmmfIndex[];
}

interface SchemaWasm {
  get_dmmf(params: string): string;
}

let wasm: Promise<SchemaWasm> | undefined;

/** Loaded once per process, and only on the server: it's several megabytes of WASM. */
function loadWasm(): Promise<SchemaWasm> {
  wasm ??= import('@prisma/prisma-schema-wasm').then((m) => {
    // CommonJS through `import()`: the functions are on the module or on its default.
    const mod = m as unknown as Partial<SchemaWasm> & { default?: SchemaWasm };
    const found = typeof mod.get_dmmf === 'function' ? (mod as SchemaWasm) : mod.default;
    if (found === undefined) throw new Error('@prisma/prisma-schema-wasm has no get_dmmf');
    return found;
  });
  return wasm;
}

// --- blocks ---------------------------------------------------------------------------------

export interface PrismaBlock {
  /** `model`, `enum`, `datasource`, `generator`, `view`, `type`; null for text that isn't one */
  readonly keyword: string | null;
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** The top-level blocks, in order. Strings and comments are skipped, so a `}` in either
 *  doesn't end a block. Text that isn't a block is returned as one with a null keyword. */
export function scanBlocks(source: string): PrismaBlock[] {
  const blocks: PrismaBlock[] = [];
  let i = 0;
  const skipSpaceAndComments = (): void => {
    while (i < source.length) {
      if (/\s/.test(source[i] ?? '')) i += 1;
      else if (source.startsWith('//', i)) {
        const end = source.indexOf('\n', i);
        i = end === -1 ? source.length : end + 1;
      } else break;
    }
  };
  for (;;) {
    skipSpaceAndComments();
    if (i >= source.length) break;
    const start = i;
    const head = /^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\{/.exec(source.slice(i));
    if (head === null) {
      // Not a block: everything up to the next line that starts one.
      const next = source
        .slice(i)
        .search(/\n\s*(model|enum|datasource|generator|view|type)\s+\w+\s*\{/);
      const end = next === -1 ? source.length : i + next + 1;
      blocks.push({ keyword: null, name: '', start, end, text: source.slice(start, end) });
      i = end;
      continue;
    }
    i += head[0].length;
    let depth = 1;
    while (i < source.length && depth > 0) {
      const c = source[i];
      if (c === '"') {
        i += 1;
        while (i < source.length && source[i] !== '"') i += source[i] === '\\' ? 2 : 1;
        i += 1;
      } else if (source.startsWith('//', i)) {
        const end = source.indexOf('\n', i);
        i = end === -1 ? source.length : end;
      } else {
        if (c === '{') depth += 1;
        else if (c === '}') depth -= 1;
        i += 1;
      }
    }
    blocks.push({
      keyword: head[1] ?? null,
      name: head[2] ?? '',
      start,
      end: i,
      text: source.slice(start, i),
    });
  }
  return blocks;
}

function rangeOf(source: string, start: number, end: number): SourceRange {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < start && i < source.length; i += 1) {
    if (source[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { start, end, line, column: start - lineStart + 1 };
}

const excerptOf = (text: string): string => {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= 200 ? collapsed : `${collapsed.slice(0, 199)}…`;
};

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  postgresql: 'PostgreSQL',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  sqlite: 'SQLite',
  sqlserver: 'SQL Server',
  mongodb: 'MongoDB',
  cockroachdb: 'CockroachDB',
};

const ACTIONS: Readonly<Record<string, string>> = {
  Cascade: 'cascade',
  Restrict: 'restrict',
  NoAction: 'noAction',
  SetNull: 'setNull',
  SetDefault: 'setDefault',
};

/** Defaults Prisma Client fills in itself; the database never sees them (Q2). */
const CLIENT_DEFAULTS = new Set(['uuid', 'cuid', 'nanoid', 'ulid']);

const sqlString = (text: string): string => `'${text.replace(/'/g, "''")}'`;

// --- the import -----------------------------------------------------------------------------

export async function importPrisma(
  source: string,
  options: ImportOptions,
  ctx: ImportContext,
  dialect: OrmDialect,
): Promise<ImportResult> {
  const reader = dialect.prismaImport;
  const blocks = scanBlocks(source);
  const outcome = new Map<
    PrismaBlock,
    { status: ImportStatementStatus; reasons: string[]; produced: IrObjectRef[] }
  >();
  for (const block of blocks) outcome.set(block, { status: 'applied', reasons: [], produced: [] });
  const fail = (reason: string) => {
    for (const o of outcome.values()) {
      o.status = 'failed';
      o.reasons = [reason];
      o.produced = [];
    }
  };

  const namespace: Record<Id, Namespace> = {};
  const customType: Record<Id, CustomType> = {};
  const entity: Record<Id, Entity> = {};
  const field: Record<Id, Field> = {};
  const constraint: Record<Id, Constraint> = {};
  const index: Record<Id, Index> = {};
  const link: Record<Id, Link> = {};
  const docs: ImportedDoc[] = [];

  const prepared = prepareForParser(source, blocks);
  const datasource = blocks.find((b) => b.keyword === 'datasource');
  // Pasted models alone (no datasource) are for the project's own database; Prisma still
  // checks every `@db.` type against that provider.
  const provider =
    datasource === undefined
      ? dialect.prismaProvider
      : /\bprovider\s*=\s*"([^"]*)"/.exec(datasource.text)?.[1];
  const parsed =
    datasource === undefined
      ? `${prepared.text}\ndatasource db {\n  provider = "${dialect.prismaProvider}"\n  url      = env("DATABASE_URL")\n}\n`
      : prepared.text;
  let datamodel: Datamodel | null = null;
  if (provider === undefined) {
    fail('The datasource block has no provider, so its database is unknown.');
  } else if (
    provider !== dialect.prismaProvider &&
    !(provider === 'postgres' && dialect.prismaProvider === 'postgresql')
  ) {
    fail(
      `This file is for ${PROVIDER_NAMES[provider] ?? provider}; the project is ${PROVIDER_NAMES[dialect.prismaProvider] ?? dialect.prismaProvider}.`,
    );
  } else {
    try {
      const out = (await loadWasm()).get_dmmf(JSON.stringify({ prismaSchema: parsed }));
      datamodel = withoutSyntheticKeys((JSON.parse(out) as { datamodel: Datamodel }).datamodel);
    } catch (error) {
      fail(`Prisma rejected the file: ${prismaError(error)}`);
    }
  }

  if (datamodel !== null) {
    const defaultNsName = options.defaultNamespace ?? reader.defaultNamespace;
    const nsIds = new Map<string, Id>();
    const nsOf = (name: string | null | undefined): Id => {
      const key = name ?? defaultNsName;
      let id = nsIds.get(key);
      if (id === undefined) {
        id = ctx.newId();
        nsIds.set(key, id);
        namespace[id] = {
          id,
          name: key,
          version: 0,
          engineProps: {},
          isDefault: key === defaultNsName,
        };
      }
      return id;
    };
    nsOf(null);

    const blockOf = (keyword: string, name: string) =>
      blocks.find((b) => b.keyword === keyword && b.name === name);
    const report = (block: PrismaBlock | undefined, ref: IrObjectRef | null, reason?: string) => {
      const o = block === undefined ? undefined : outcome.get(block);
      if (o === undefined) return;
      if (ref !== null) o.produced.push(ref);
      if (reason !== undefined && !o.reasons.includes(reason)) {
        o.reasons.push(reason);
        if (o.status === 'applied') o.status = 'partial';
      }
    };

    // Enums: their own type, inline on the column, or TEXT plus a CHECK.
    const enumLabels = new Map<string, readonly string[]>();
    const enumType = new Map<string, CustomType>();
    for (const e of datamodel.enums) {
      const labels = e.values.map((v) => v.dbName ?? v.name);
      enumLabels.set(e.name, labels);
      if (reader.enums !== 'type') continue;
      const id = ctx.newId();
      const created: CustomType = {
        id,
        name: e.dbName ?? e.name,
        version: 0,
        engineProps: { labels: [...labels] },
        namespaceId: nsOf(e.schema),
        kind: 'enum',
      };
      customType[id] = created;
      enumType.set(e.name, created);
      report(blockOf('enum', e.name), { type: 'customType', id });
    }

    // Tables and columns. Prisma field name → the IR field, per model.
    const views = new Set(blocks.filter((b) => b.keyword === 'view').map((b) => b.name));
    const tableOf = new Map<string, Entity>();
    const columnOf = new Map<string, Map<string, Field>>();
    for (const model of datamodel.models) {
      const block = blockOf(views.has(model.name) ? 'view' : 'model', model.name);
      if (views.has(model.name)) continue;
      const id = ctx.newId();
      const table: Entity = {
        id,
        name: model.dbName ?? model.name,
        version: 0,
        engineProps: {},
        namespaceId: nsOf(model.schema),
        kind: 'table',
        areaId: null,
        position: { x: 0, y: 0 },
        color: null,
        doc: null,
      };
      entity[id] = table;
      tableOf.set(model.name, table);
      report(block, { type: 'entity', id });
      const tableDoc = userDoc(model.documentation);
      if (tableDoc !== null) docs.push({ target: { type: 'entity', id }, text: tableDoc });
      const columns = new Map<string, Field>();
      columnOf.set(model.name, columns);
      let ordinal = 0;
      for (const f of model.fields) {
        if (f.kind === 'object') continue;
        const unsupported = prepared.unsupported.get(`${model.name}.${f.name}`);
        const built =
          unsupported === undefined ? columnType(f) : unsupportedType(unsupported, f.isList);
        if (built === null) {
          report(
            block,
            null,
            `column “${f.dbName ?? f.name}” has a type the project's database can't hold`,
          );
          continue;
        }
        const props: EngineProps = { ...built.props };
        let type = built.type;
        const value = f.default;
        if (isDefault(value)) {
          if (value.name === 'autoincrement') {
            const auto = reader.autoIncrement(type, props);
            type = auto.type;
            Object.assign(props, auto.props);
          } else if (value.name === 'now') {
            props.default = 'CURRENT_TIMESTAMP';
          } else if (value.name === 'dbgenerated' && typeof value.args[0] === 'string') {
            props.default = value.args[0];
          } else if (CLIENT_DEFAULTS.has(value.name)) {
            report(
              block,
              null,
              `${value.name}() on “${f.name}” is filled in by Prisma Client, not the database`,
            );
          } else {
            report(block, null, `the default of “${f.name}” is not a database default`);
          }
        } else if (value !== undefined && !Array.isArray(value)) {
          if (typeof value === 'string') {
            const labels = f.kind === 'enum' ? enumLabels.get(f.type) : undefined;
            const e = datamodel.enums.find((x) => x.name === f.type);
            const label =
              labels === undefined
                ? value
                : (e?.values.find((v) => v.name === value)?.dbName ?? value);
            props.default = sqlString(label);
          } else if (typeof value === 'number' || typeof value === 'boolean') {
            props.default = String(value);
          }
        } else if (Array.isArray(value)) {
          report(block, null, `the list default of “${f.name}” is not imported`);
        }
        if (f.isUpdatedAt === true) {
          report(
            block,
            null,
            `@updatedAt on “${f.name}” is filled in by Prisma Client, not the database`,
          );
        }
        const fid = ctx.newId();
        const column: Field = {
          id: fid,
          name: f.dbName ?? f.name,
          version: 0,
          engineProps: props,
          entityId: id,
          parentFieldId: null,
          ordinal: ordinal++,
          type,
          isNullable: !f.isRequired,
          isRestricted: false,
          isPii: false,
          isDeprecated: false,
          doc: null,
        };
        field[fid] = column;
        columns.set(f.name, column);
        report(block, { type: 'field', id: fid });
        const columnDoc = userDoc(f.documentation);
        if (columnDoc !== null) docs.push({ target: { type: 'field', id: fid }, text: columnDoc });
        if (f.kind === 'enum' && reader.enums === 'check') {
          const labels = enumLabels.get(f.type) ?? [];
          const cid = ctx.newId();
          constraint[cid] = {
            id: cid,
            name: `${table.name}_${column.name}_check`,
            version: 0,
            engineProps: {
              expression: `${reader.quote(column.name)} IN (${labels.map(sqlString).join(', ')})`,
            },
            entityId: id,
            kind: 'check',
            fieldIds: [],
          };
          report(block, { type: 'constraint', id: cid });
        }
      }
    }

    /** `Unsupported("tstzrange")`, read with the engine's type parser. */
    function unsupportedType(
      text: string,
      list: boolean,
    ): { type: TypeRef; props: EngineProps } | null {
      const parsed = reader.parseType(text);
      if (parsed === null) return null;
      return { type: list ? { ...parsed, dimensions: 1 } : parsed, props: {} };
    }

    /** The field's IR type, or null when nothing in the engine fits. */
    function columnType(f: DmmfField): { type: TypeRef; props: EngineProps } | null {
      const dims = f.isList ? 1 : 0;
      if (f.kind === 'enum') {
        const ct = enumType.get(f.type);
        if (ct !== undefined)
          return {
            type: { name: ct.name, customTypeId: ct.id, ...(dims > 0 ? { dimensions: dims } : {}) },
            props: {},
          };
        const labels = enumLabels.get(f.type) ?? [];
        if (reader.enums === 'inline')
          return { type: { name: 'enum', args: [...labels] }, props: {} };
        return reader.type('text', undefined, dims);
      }
      const native = f.nativeType ?? null;
      if (native !== null) {
        const [nativeName, rawArgs] = native;
        const id = Object.entries(dialect.types).find(
          ([, t]) => t.prisma?.scalar === f.type && t.prisma.native === nativeName,
        )?.[0];
        if (id === undefined) return null;
        const args = rawArgs.map((a) => (/^\d+$/.test(a) ? Number(a) : a));
        return reader.type(id, args.length > 0 ? args : undefined, dims);
      }
      const fallback = reader.defaults[f.type];
      return fallback === undefined ? null : reader.type(fallback.id, fallback.args, dims);
    }

    // Keys and indexes.
    for (const ix of datamodel.indexes) {
      const table = tableOf.get(ix.model);
      const columns = columnOf.get(ix.model);
      if (table === undefined || columns === undefined) continue;
      const block = blockOf('model', ix.model);
      const fields = ix.fields.map((f) => columns.get(f.name));
      if (fields.some((f) => f === undefined)) {
        report(
          block,
          null,
          `a ${ix.type === 'id' ? 'primary key' : 'index'} names a column that wasn't imported`,
        );
        continue;
      }
      const resolved = fields as Field[];
      const names = resolved.map((f) => f.name);
      if (ix.type === 'id' || ix.type === 'unique') {
        const cid = ctx.newId();
        constraint[cid] = {
          id: cid,
          name:
            ix.dbName ??
            (ix.type === 'id'
              ? reader.primaryKeyName(table.name)
              : `${table.name}_${names.join('_')}_key`),
          version: 0,
          engineProps: {},
          entityId: table.id,
          kind: ix.type === 'id' ? 'primaryKey' : 'unique',
          fieldIds: resolved.map((f) => f.id),
        };
        report(block, { type: 'constraint', id: cid });
        continue;
      }
      const iid = ctx.newId();
      const cols: IndexColumn[] = ix.fields.map((f, ordinal) => ({
        ordinal,
        fieldId: resolved[ordinal]?.id ?? null,
        expression: null,
        role: 'key',
        direction: f.sortOrder === 'desc' ? 'desc' : 'asc',
        engineProps: f.length === undefined ? {} : { length: f.length },
      }));
      index[iid] = {
        id: iid,
        name: ix.dbName ?? `${table.name}_${names.join('_')}_idx`,
        version: 0,
        engineProps: {},
        entityId: table.id,
        kind: reader.indexKind(ix.type === 'fulltext' ? 'fulltext' : ix.algorithm),
        isUnique: false,
        columns: cols,
      };
      report(block, { type: 'index', id: iid });
    }

    // Foreign keys, from the side that holds `fields:`.
    for (const model of datamodel.models) {
      const child = tableOf.get(model.name);
      const childColumns = columnOf.get(model.name);
      if (child === undefined || childColumns === undefined) continue;
      const block = blockOf('model', model.name);
      for (const f of model.fields) {
        if (f.kind !== 'object' || (f.relationFromFields ?? []).length === 0) continue;
        const parent = tableOf.get(f.type);
        const parentColumns = columnOf.get(f.type);
        if (parent === undefined || parentColumns === undefined) continue;
        const from = (f.relationFromFields ?? []).map((n) => childColumns.get(n));
        const to = (f.relationToFields ?? []).map((n) => parentColumns.get(n));
        if (from.some((x) => x === undefined) || to.some((x) => x === undefined)) {
          report(block, null, `the relation “${f.name}” names a column that wasn't imported`);
          continue;
        }
        const fromFields = from as Field[];
        const optional = fromFields.some((x) => x.isNullable);
        const lid = ctx.newId();
        link[lid] = {
          id: lid,
          name:
            relationMap(block?.text ?? '', f.name) ??
            `${child.name}_${fromFields.map((x) => x.name).join('_')}_fkey`,
          version: 0,
          engineProps: {
            onDelete:
              ACTIONS[f.relationOnDelete ?? (optional ? 'SetNull' : 'Restrict')] ?? 'noAction',
            onUpdate: ACTIONS[f.relationOnUpdate ?? 'Cascade'] ?? 'cascade',
          },
          kind: 'foreignKey',
          from: { entityId: child.id, fieldIds: fromFields.map((x) => x.id) },
          to: { entityId: parent.id, fieldIds: (to as Field[]).map((x) => x.id) },
          cardinality: 'N:1',
        };
        report(block, { type: 'link', id: lid });
      }
    }

    // Implicit many-to-many: the `_AToB` table Prisma creates (Q3).
    const seen = new Set<string>();
    for (const model of datamodel.models) {
      for (const f of model.fields) {
        if (
          f.kind !== 'object' ||
          !f.isList ||
          f.relationName === undefined ||
          seen.has(f.relationName)
        )
          continue;
        const other = datamodel.models.find((m) => m.name === f.type);
        const back = other?.fields.find(
          // Both sides are lists with no `fields:`; a one-to-many back-relation has them on
          // its other side, and a self-relation's back side is a different field.
          (x) =>
            x !== f &&
            x.kind === 'object' &&
            x.relationName === f.relationName &&
            x.isList &&
            (x.relationFromFields ?? []).length === 0,
        );
        if (other === undefined || back === undefined) continue;
        seen.add(f.relationName);
        const [a, b] = [model, other].sort((x, y) =>
          x.name < y.name ? -1 : x.name > y.name ? 1 : 0,
        );
        if (a === undefined || b === undefined) continue;
        const created = joinTable(f.relationName, a, b);
        if (created !== null) report(blockOf('model', model.name), { type: 'entity', id: created });
      }
    }

    function joinTable(relation: string, a: DmmfModel, b: DmmfModel): Id | null {
      const keyOf = (m: DmmfModel): Field | undefined => {
        const pk = datamodel?.indexes.find((x) => x.model === m.name && x.type === 'id');
        return pk?.fields.length === 1
          ? columnOf.get(m.name)?.get(pk.fields[0]?.name ?? '')
          : undefined;
      };
      const [ka, kb] = [keyOf(a), keyOf(b)];
      const [ta, tb] = [tableOf.get(a.name), tableOf.get(b.name)];
      if (ka === undefined || kb === undefined || ta === undefined || tb === undefined) return null;
      const name = `_${relation}`;
      const id = ctx.newId();
      entity[id] = {
        id,
        name,
        version: 0,
        engineProps: {},
        namespaceId: ta.namespaceId,
        kind: 'table',
        areaId: null,
        position: { x: 0, y: 0 },
        color: null,
        doc: null,
      };
      const column = (letter: string, key: Field, ordinal: number): Field => {
        const fid = ctx.newId();
        const plain = { ...key.type };
        const created: Field = {
          id: fid,
          name: letter,
          version: 0,
          engineProps: reader.plainColumnProps(key.engineProps),
          entityId: id,
          parentFieldId: null,
          ordinal,
          type: reader.plainType(plain),
          isNullable: false,
          isRestricted: false,
          isPii: false,
          isDeprecated: false,
          doc: null,
        };
        field[fid] = created;
        return created;
      };
      const ca = column('A', ka, 0);
      const cb = column('B', kb, 1);
      const pairKey = (): void => {
        if (reader.implicitManyToManyKey === 'primaryKey') {
          const cid = ctx.newId();
          constraint[cid] = {
            id: cid,
            name: `${name}_AB_pkey`,
            version: 0,
            engineProps: {},
            entityId: id,
            kind: 'primaryKey',
            fieldIds: [ca.id, cb.id],
          };
        } else {
          const iid = ctx.newId();
          index[iid] = {
            id: iid,
            name: `${name}_AB_unique`,
            version: 0,
            engineProps: {},
            entityId: id,
            kind: reader.indexKind(undefined),
            isUnique: true,
            columns: [ca, cb].map((c, ordinal) => ({
              ordinal,
              fieldId: c.id,
              expression: null,
              role: 'key',
              direction: 'asc',
              engineProps: {},
            })),
          };
        }
      };
      pairKey();
      const bIndex = ctx.newId();
      index[bIndex] = {
        id: bIndex,
        name: `${name}_B_index`,
        version: 0,
        engineProps: {},
        entityId: id,
        kind: reader.indexKind(undefined),
        isUnique: false,
        columns: [
          {
            ordinal: 0,
            fieldId: cb.id,
            expression: null,
            role: 'key',
            direction: 'asc',
            engineProps: {},
          },
        ],
      };
      for (const [col, target, key] of [
        [ca, ta, ka],
        [cb, tb, kb],
      ] as const) {
        const lid = ctx.newId();
        link[lid] = {
          id: lid,
          name: `${name}_${col.name}_fkey`,
          version: 0,
          engineProps: { onDelete: 'cascade', onUpdate: 'cascade' },
          kind: 'foreignKey',
          from: { entityId: id, fieldIds: [col.id] },
          to: { entityId: target.id, fieldIds: [key.id] },
          cardinality: 'N:1',
        };
      }
      return id;
    }

    for (const block of blocks) {
      const o = outcome.get(block);
      if (o === undefined) continue;
      if (block.keyword === 'datasource' || block.keyword === 'generator') {
        o.status = 'ignored';
        o.reasons = ['Prisma configuration, not part of the schema'];
      } else if (block.keyword === 'view') {
        o.status = 'unsupported';
        o.reasons = ['A Prisma view has no SQL body to import'];
      } else if (block.keyword === 'type') {
        o.status = 'unsupported';
        o.reasons = ['Composite types are a MongoDB feature'];
      } else if (block.keyword === null) {
        o.status = 'failed';
        o.reasons = ['Not a Prisma block'];
      }
    }
  }

  const model: SchemaModel = {
    irVersion: 1,
    projectId: ctx.projectId,
    engineId: reader.engineId,
    engineVersion: ctx.serverVersion ?? '',
    redacted: false,
    objects: { area: {}, namespace, customType, entity, field, constraint, index, link },
  };

  const diagnostics: Diagnostic[] = [];
  const countsByStatus: Record<ImportStatementStatus, number> = {
    applied: 0,
    partial: 0,
    unsupported: 0,
    ignored: 0,
    failed: 0,
  };
  const statements: ImportStatementReport[] = blocks.map((block, ordinal) => {
    const o = outcome.get(block) ?? {
      status: 'failed' as const,
      reasons: ['Not read'],
      produced: [],
    };
    countsByStatus[o.status] += 1;
    const range = rangeOf(source, block.start, block.end);
    const reason = o.status === 'applied' ? null : o.reasons.join('; ');
    if (o.status === 'failed') {
      diagnostics.push({
        code: reader.importFailedCode,
        severity: 'error',
        params: { reason: reason ?? '' },
        target: { type: 'project', id: ctx.projectId },
        range,
      });
    }
    return {
      ordinal,
      kind: block.keyword ?? 'unparsed',
      range,
      excerpt: excerptOf(block.text),
      status: o.status,
      reason,
      producedObjects: o.produced,
    };
  });

  const objectCounts: Partial<Record<IrObjectType, number>> = {};
  for (const [type, bag] of Object.entries(model.objects)) {
    const size = Object.keys(bag).length;
    if (size > 0) objectCounts[type as IrObjectType] = size;
  }
  const report: ImportReport = {
    statementCount: statements.length,
    statements,
    countsByStatus,
    objectCounts,
    truncated: false,
  };
  return { model, report, diagnostics, docs };
}

/**
 * A `///` comment without the notes `prisma db pull` writes itself ("does not contain a valid
 * unique identifier", "requires additional setup for migrations… pris.ly"): those describe
 * Prisma's limits, not the table. Null when nothing is left.
 */
function userDoc(documentation: string | undefined): string | null {
  const lines = (documentation ?? '')
    .split('\n')
    .filter(
      (line) =>
        !line.includes('pris.ly/') &&
        !line.startsWith('The underlying table does not contain a valid unique identifier'),
    );
  const text = lines.join('\n').trim();
  return text === '' ? null : text;
}

/** The placeholder key an ignored model without one gets, so Prisma validates it. */
const SYNTHETIC_KEY = 'schemaloomSyntheticKey';

/**
 * Prisma's parser leaves out `@@ignore` models, `@ignore` fields and `Unsupported(…)` fields,
 * all of which are real database objects (§2.2: imported anyway). So it reads a copy with the
 * ignores removed, a placeholder key on an ignored model that has none (Prisma requires one
 * once it isn't ignored), and `String` in place of each `Unsupported("…")`, whose text is kept
 * here by `model.field`. Block ranges in the report still point into the original source.
 */
function prepareForParser(
  source: string,
  blocks: readonly PrismaBlock[],
): { text: string; unsupported: ReadonlyMap<string, string> } {
  const unsupported = new Map<string, string>();
  let text = '';
  let at = 0;
  for (const block of blocks) {
    text += source.slice(at, block.start);
    at = block.end;
    if (block.keyword !== 'model') {
      text += block.text;
      continue;
    }
    const ignored = /^\s*@@ignore\b/m.test(block.text);
    let body = block.text
      .replace(/^\s*@@ignore\b.*$/gm, '')
      .replace(/(\s)@ignore\b/g, '$1')
      .replace(
        /^(\s*)(\w+)(\s+)Unsupported\("((?:[^"\\]|\\.)*)"\)(\?|\[\])?/gm,
        (_m, indent: string, name: string, gap: string, type: string, mark: string | undefined) => {
          unsupported.set(`${block.name}.${name}`, type.replace(/\\(.)/g, '$1'));
          return `${indent}${name}${gap}String${mark ?? ''}`;
        },
      );
    if (ignored && !/@@?id\b/.test(body)) {
      const close = body.lastIndexOf('}');
      body = `${body.slice(0, close)}  ${SYNTHETIC_KEY} Int @id\n${body.slice(close)}`;
    }
    text += body;
  }
  return { text: text + source.slice(at), unsupported };
}

function withoutSyntheticKeys(datamodel: Datamodel): Datamodel {
  return {
    ...datamodel,
    models: datamodel.models.map((m) => ({
      ...m,
      fields: m.fields.filter((f) => f.name !== SYNTHETIC_KEY),
    })),
    indexes: datamodel.indexes.filter((ix) => !ix.fields.some((f) => f.name === SYNTHETIC_KEY)),
  };
}

function isDefault(value: unknown): value is { name: string; args: readonly unknown[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { name?: unknown }).name === 'string'
  );
}

/** `@relation(…, map: "x")` on the field's line; the parser's output doesn't carry it. */
function relationMap(blockText: string, fieldName: string): string | null {
  for (const line of blockText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${fieldName} `) && !trimmed.startsWith(`${fieldName}\t`)) continue;
    const relation = /@relation\((.*)\)/.exec(trimmed)?.[1];
    const map =
      relation === undefined ? undefined : /\bmap\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(relation)?.[1];
    if (map !== undefined) return map.replace(/\\(.)/g, '$1');
  }
  return null;
}

/** The first line of Prisma's validation message. */
function prismaError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(text) as { message?: string };
    if (typeof parsed.message === 'string') return firstError(parsed.message);
  } catch {
    // not JSON: the message as is
  }
  return firstError(text);
}

const firstError = (message: string): string => {
  const line =
    message.split('\n').find((l) => /error/i.test(l) && l.trim() !== '') ??
    message.split('\n')[0] ??
    message;
  return line.replace(ANSI_COLOUR, '').trim().slice(0, 300);
};

/** Terminal colour codes, which Prisma's messages carry. */
const ANSI_COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
