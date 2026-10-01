import type {
  Constraint,
  CustomType,
  Diagnostic,
  Entity,
  ExportInput,
  ExportResult,
  ExportStatement,
  Field,
  Id,
  Index,
  IrObjectType,
  Link,
  SchemaModel,
  TypeRef,
} from '@schemaloom/engine-sdk';
import { propString, propStringArray } from './export-ddl.js';
import { compare } from './exporter.js';
import { CODE } from './messages.js';
import { TYPE_CATALOG } from './types.js';

/**
 * Phase 7 — the `prisma` export format: a `schema.prisma` shaped like what `prisma db pull`
 * writes for the same database (`docs/phase7/DESIGN.md` §3).
 *
 * Same three properties as the DDL exporter: it takes a `RedactedModel`, it is deterministic
 * (explicit sort keys, byte comparison), and a hidden object sets `incomplete` with one
 * header line and no count. What Prisma cannot express is NOT incomplete: the column stays
 * (as `Unsupported`) or a `//` comment in the model names what was left out.
 */

const REDACTION_NOTICE = '// Some objects are not included because of your access level.';
const NO_UNIQUE_IDENTIFIER =
  '/// The underlying table does not contain a valid unique identifier and can therefore currently not be handled by Prisma Client.';

/** canonical PostgreSQL type id → Prisma scalar, plus the `@db.*` attribute when the scalar's
 *  default native type is not this one. `precision` is PostgreSQL's default when unwritten. */
const SCALARS: Readonly<
  Record<string, { scalar: string; native?: string; precision?: number; serial?: true }>
> = {
  smallint: { scalar: 'Int', native: 'SmallInt' },
  integer: { scalar: 'Int' },
  bigint: { scalar: 'BigInt' },
  smallserial: { scalar: 'Int', native: 'SmallInt', serial: true },
  serial: { scalar: 'Int', serial: true },
  bigserial: { scalar: 'BigInt', serial: true },
  numeric: { scalar: 'Decimal', native: 'Decimal' },
  real: { scalar: 'Float', native: 'Real' },
  'double precision': { scalar: 'Float' },
  money: { scalar: 'Decimal', native: 'Money' },
  text: { scalar: 'String' },
  varchar: { scalar: 'String', native: 'VarChar' },
  char: { scalar: 'String', native: 'Char' },
  boolean: { scalar: 'Boolean' },
  date: { scalar: 'DateTime', native: 'Date' },
  time: { scalar: 'DateTime', native: 'Time', precision: 6 },
  timetz: { scalar: 'DateTime', native: 'Timetz', precision: 6 },
  timestamp: { scalar: 'DateTime', native: 'Timestamp', precision: 6 },
  timestamptz: { scalar: 'DateTime', native: 'Timestamptz', precision: 6 },
  uuid: { scalar: 'String', native: 'Uuid' },
  json: { scalar: 'Json', native: 'Json' },
  jsonb: { scalar: 'Json' },
  bytea: { scalar: 'Bytes' },
  bit: { scalar: 'String', native: 'Bit' },
  varbit: { scalar: 'String', native: 'VarBit' },
  inet: { scalar: 'String', native: 'Inet' },
  xml: { scalar: 'String', native: 'Xml' },
};

const ACTIONS: Readonly<Record<string, string>> = {
  noAction: 'NoAction',
  restrict: 'Restrict',
  cascade: 'Cascade',
  setNull: 'SetNull',
  setDefault: 'SetDefault',
};

const INDEX_TYPES: Readonly<Record<string, string>> = {
  hash: 'Hash',
  gist: 'Gist',
  gin: 'Gin',
  spgist: 'SpGist',
  brin: 'Brin',
};

/** A Prisma identifier: a letter, then letters, digits and `_`. */
export function prismaName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `x${cleaned}`;
}

export function prismaString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

const list = (names: readonly string[]): string => `[${names.join(', ')}]`;

function docLines(doc: { excerpt: string } | null, indent: string): string[] {
  if (doc === null || doc.excerpt === '') return [];
  return doc.excerpt.split('\n').map((line) => `${indent}/// ${line}`.trimEnd());
}

/** Unique names in one Prisma scope (a model's fields, or the file's models and enums). */
class Names {
  private readonly used = new Set<string>();
  take(preferred: string, fallback: () => string): string {
    let name = this.used.has(preferred) ? fallback() : preferred;
    for (let n = 2; this.used.has(name); n++) name = `${preferred}_${String(n)}`;
    this.used.add(name);
    return name;
  }
}

interface ModelPlan {
  readonly entity: Entity;
  readonly nsName: string;
  readonly name: string;
  readonly fields: readonly Field[];
  readonly fieldNames: Names;
  readonly fieldName: Map<Id, string>;
  /** field id → extra field attributes (`@id`, `@unique`) */
  readonly fieldAttrs: Map<Id, string[]>;
  readonly blockAttrs: string[];
  readonly relationLines: (readonly [string, string, string])[];
  readonly unsupported: string[];
  /** sorted field-id sets that are unique on this table */
  readonly uniqueSets: string[];
  ignored: boolean;
}

/** Prisma's default constraint names; `map:` is written only when the real name differs. */
const defaultName = (table: string, columns: readonly string[], suffix: string): string =>
  `${table}_${columns.join('_')}_${suffix}`;

const mapArg = (name: string, expected: string): string | null =>
  name === expected || name === '' ? null : `map: ${prismaString(name)}`;

const setKey = (ids: readonly Id[]): string => [...ids].sort(compare).join(',');

export function buildPrismaExport(input: ExportInput): ExportResult {
  const { model, options } = input;
  const diagnostics: Diagnostic[] = [];
  // `as boolean`: set inside `skip`, which narrowing cannot see.
  let skipped = false as boolean;
  const skip = (type: IrObjectType, id: Id, reason: string): void => {
    skipped = true;
    if (model.redacted) return;
    diagnostics.push({
      code: CODE.exportOmitted,
      severity: 'warning',
      params: { reason },
      target: { type, id },
    });
  };

  const nsName = (id: Id): string => model.objects.namespace[id]?.name ?? '';
  const defaultNs = new Set(
    Object.values(model.objects.namespace)
      .filter((n) => n.isDefault)
      .map((n) => n.id),
  );
  const fileNames = new Names();
  const schemas = new Set<string>();

  // --- enums ------------------------------------------------------------------------------
  const enums = new Map<Id, { name: string; values: Map<string, string>; ns: string }>();
  const sortedTypes = Object.values(model.objects.customType).sort(
    (a, b) =>
      compare(nsName(a.namespaceId), nsName(b.namespaceId)) ||
      compare(a.name, b.name) ||
      compare(a.id, b.id),
  );
  for (const customType of sortedTypes) {
    if (customType.restricted === true) {
      skip('customType', customType.id, 'hidden from the requester');
      continue;
    }
    if (customType.kind !== 'enum') continue; // domains map to their base type, composites to Unsupported
    const labels =
      customType.propsRedacted === true
        ? undefined
        : propStringArray(customType.engineProps, 'labels');
    if (labels === undefined || labels.length === 0) continue;
    const ns = nsName(customType.namespaceId);
    const valueNames = new Names();
    const values = new Map(
      labels.map((label) => [label, valueNames.take(prismaName(label), () => prismaName(label))]),
    );
    enums.set(customType.id, {
      name: fileNames.take(prismaName(customType.name), () =>
        prismaName(`${ns}_${customType.name}`),
      ),
      values,
      ns,
    });
  }

  // --- models -----------------------------------------------------------------------------
  const fieldsByEntity = new Map<Id, Field[]>();
  for (const field of Object.values(model.objects.field)) {
    const bucket = fieldsByEntity.get(field.entityId);
    if (bucket === undefined) fieldsByEntity.set(field.entityId, [field]);
    else bucket.push(field);
  }

  const primaryKeyFields = new Set(
    Object.values(model.objects.constraint)
      .filter((c) => c.kind === 'primaryKey' && c.restricted !== true)
      .flatMap((c) => c.fieldIds),
  );
  const plans = new Map<Id, ModelPlan>();
  let viewsLeftOut = false;
  const sortedEntities = Object.values(model.objects.entity).sort(
    (a, b) =>
      compare(nsName(a.namespaceId), nsName(b.namespaceId)) ||
      compare(a.name, b.name) ||
      compare(a.id, b.id),
  );
  for (const entity of sortedEntities) {
    if (entity.restricted === true) {
      skip('entity', entity.id, 'hidden from the requester');
      continue;
    }
    if (entity.kind !== 'table') {
      viewsLeftOut = true;
      continue;
    }
    const ns = nsName(entity.namespaceId);
    const fields: Field[] = [];
    for (const field of (fieldsByEntity.get(entity.id) ?? []).sort(
      (a, b) => a.ordinal - b.ordinal || compare(a.id, b.id),
    )) {
      if (field.restricted === true || field.name === '') {
        skip('field', field.id, 'hidden from the requester');
        continue;
      }
      // PostgreSQL makes primary-key columns NOT NULL, and an import of an inline
      // `PRIMARY KEY` doesn't say so on the field. Prisma rejects `@id` on an optional field.
      fields.push(primaryKeyFields.has(field.id) ? { ...field, isNullable: false } : field);
    }
    const fieldNames = new Names();
    const fieldName = new Map<Id, string>();
    for (const field of fields)
      fieldName.set(
        field.id,
        fieldNames.take(prismaName(field.name), () => prismaName(field.name)),
      );
    plans.set(entity.id, {
      entity,
      nsName: ns,
      name: fileNames.take(prismaName(entity.name), () => prismaName(`${ns}_${entity.name}`)),
      fields,
      fieldNames,
      fieldName,
      fieldAttrs: new Map(),
      blockAttrs: [],
      relationLines: [],
      unsupported: [],
      uniqueSets: [],
      ignored: false,
    });
  }

  const fieldById = new Map<Id, Field>();
  for (const plan of plans.values())
    for (const field of plan.fields) fieldById.set(field.id, field);
  const namesOf = (plan: ModelPlan, ids: readonly Id[]): string[] | null => {
    const names: string[] = [];
    for (const id of ids) {
      const name = plan.fieldName.get(id);
      if (name === undefined) return null;
      names.push(name);
    }
    return names;
  };
  const columnsOf = (ids: readonly Id[]): string[] =>
    ids.map((id) => fieldById.get(id)?.name ?? '');
  const addFieldAttr = (plan: ModelPlan, id: Id, attr: string): void => {
    const attrs = plan.fieldAttrs.get(id);
    if (attrs === undefined) plan.fieldAttrs.set(id, [attr]);
    else attrs.push(attr);
  };
  const allRequired = (ids: readonly Id[]): boolean =>
    ids.every((id) => fieldById.get(id)?.isNullable === false);
  const identifiers = new Map<Id, boolean>();

  /** `@id` / `@unique` on one field, `@@id` / `@@unique` on several. */
  const addKey = (
    plan: ModelPlan,
    kind: 'id' | 'unique',
    ids: readonly Id[],
    name: string,
    suffix: string,
  ): void => {
    const names = namesOf(plan, ids);
    if (names === null) return;
    const table = plan.entity.name;
    const map = mapArg(
      name,
      suffix === 'pkey' ? `${table}_pkey` : defaultName(table, columnsOf(ids), suffix),
    );
    const [only] = ids;
    if (ids.length === 1 && only !== undefined) {
      addFieldAttr(plan, only, map === null ? `@${kind}` : `@${kind}(${map})`);
    } else {
      plan.blockAttrs.push(`@@${kind}(${[list(names), map].filter((a) => a !== null).join(', ')})`);
    }
    plan.uniqueSets.push(setKey(ids));
    if (kind === 'id' || allRequired(ids)) identifiers.set(plan.entity.id, true);
  };

  // --- constraints ------------------------------------------------------------------------
  for (const constraint of Object.values(model.objects.constraint).sort(byName)) {
    const plan = plans.get(constraint.entityId);
    if (constraint.restricted === true) {
      skip('constraint', constraint.id, 'hidden from the requester');
      continue;
    }
    if (plan === undefined) continue;
    if (constraint.kind === 'primaryKey' || constraint.kind === 'unique') {
      if (namesOf(plan, constraint.fieldIds) === null || constraint.fieldIds.length === 0) {
        skip('constraint', constraint.id, 'it references a column not in this export');
        continue;
      }
      if (constraint.kind === 'primaryKey')
        addKey(plan, 'id', constraint.fieldIds, constraint.name, 'pkey');
      else addKey(plan, 'unique', constraint.fieldIds, constraint.name, 'key');
      continue;
    }
    plan.unsupported.push(`${constraint.kind} constraint ${prismaString(constraint.name)}`);
  }

  // --- indexes ----------------------------------------------------------------------------
  for (const index of Object.values(model.objects.index).sort(byName)) {
    const plan = plans.get(index.entityId);
    if (index.restricted === true) {
      skip('index', index.id, 'hidden from the requester');
      continue;
    }
    if (plan === undefined) continue;
    const ids = indexFieldIds(index);
    if (
      ids === null ||
      index.propsRedacted === true ||
      propString(index.engineProps, 'where') !== undefined
    ) {
      plan.unsupported.push(`index ${prismaString(index.name)}`);
      continue;
    }
    if (namesOf(plan, ids) === null) {
      skip('index', index.id, 'it references a column not in this export');
      continue;
    }
    if (index.isUnique) {
      if (!plan.uniqueSets.includes(setKey(ids))) addKey(plan, 'unique', ids, index.name, 'key');
      continue;
    }
    const keys = [...index.columns]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((c) => {
        const name = plan.fieldName.get(c.fieldId ?? '') ?? '';
        return c.direction === 'desc' ? `${name}(sort: Desc)` : name;
      });
    const type = INDEX_TYPES[index.kind];
    plan.blockAttrs.push(
      `@@index(${[
        list(keys),
        mapArg(index.name, defaultName(plan.entity.name, columnsOf(ids), 'idx')),
        type === undefined ? null : `type: ${type}`,
      ]
        .filter((a) => a !== null)
        .join(', ')})`,
    );
  }

  for (const plan of plans.values()) plan.ignored = identifiers.get(plan.entity.id) !== true;

  // --- relations (foreign keys) -----------------------------------------------------------
  const links = Object.values(model.objects.link)
    .filter((l) => {
      if (l.restricted === true) {
        skip('link', l.id, 'hidden from the requester');
        return false;
      }
      return l.kind === 'foreignKey';
    })
    .sort(byName);
  const pairCount = new Map<string, number>();
  const pair = (l: Link): string => [l.from.entityId, l.to.entityId].sort(compare).join('|');
  for (const l of links) pairCount.set(pair(l), (pairCount.get(pair(l)) ?? 0) + 1);

  for (const l of links) {
    const child = plans.get(l.from.entityId);
    const parent = plans.get(l.to.entityId);
    if (child === undefined || parent === undefined) {
      if (
        model.objects.entity[l.from.entityId]?.restricted === true ||
        model.objects.entity[l.to.entityId]?.restricted === true
      ) {
        skip('link', l.id, 'one of its tables is not in this export');
      }
      continue;
    }
    const fields = namesOf(child, l.from.fieldIds);
    const references = namesOf(parent, l.to.fieldIds);
    if (
      fields === null ||
      references === null ||
      fields.length === 0 ||
      fields.length !== references.length
    ) {
      skip('link', l.id, 'it references a column not in this export');
      continue;
    }
    const optional = l.from.fieldIds.some((id) => fieldById.get(id)?.isNullable !== false);
    const named = child === parent || (pairCount.get(pair(l)) ?? 0) > 1;
    const relationName = named ? prismaString(l.name) : null;
    const props = l.propsRedacted === true ? {} : l.engineProps;
    const onDelete = ACTIONS[propString(props, 'onDelete') ?? 'noAction'] ?? 'NoAction';
    const onUpdate = ACTIONS[propString(props, 'onUpdate') ?? 'noAction'] ?? 'NoAction';
    const suffix = `_${columnsOf(l.from.fieldIds).join('_')}`;

    const forward = child.fieldNames.take(parent.name, () => prismaName(`${parent.name}${suffix}`));
    const args = [
      relationName,
      `fields: ${list(fields)}`,
      `references: ${list(references)}`,
      onDelete === (optional ? 'SetNull' : 'Restrict') ? null : `onDelete: ${onDelete}`,
      onUpdate === 'Cascade' ? null : `onUpdate: ${onUpdate}`,
      mapArg(l.name, defaultName(child.entity.name, columnsOf(l.from.fieldIds), 'fkey')),
    ].filter((a) => a !== null);
    child.relationLines.push([
      forward,
      `${parent.name}${optional ? '?' : ''}`,
      `@relation(${args.join(', ')})${parent.ignored && !child.ignored ? ' @ignore' : ''}`,
    ]);

    const oneToOne = child.uniqueSets.includes(setKey(l.from.fieldIds));
    const back = parent.fieldNames.take(child.name, () => prismaName(`${child.name}${suffix}`));
    parent.relationLines.push([
      back,
      `${child.name}${oneToOne ? '?' : '[]'}`,
      [
        relationName === null ? null : `@relation(${relationName})`,
        child.ignored && !parent.ignored ? '@ignore' : null,
      ]
        .filter((a) => a !== null)
        .join(' '),
    ]);
  }

  // --- render -----------------------------------------------------------------------------
  const blocks: {
    phase: ExportStatement['phase'];
    kind: string;
    text: string;
    target: ExportStatement['target'];
  }[] = [];

  for (const [id, e] of enums) {
    if (!defaultNs.has(model.objects.customType[id]?.namespaceId ?? '')) schemas.add(e.ns);
  }
  for (const plan of plans.values())
    if (!defaultNs.has(plan.entity.namespaceId)) schemas.add(plan.nsName);
  const multiSchema = schemas.size > 0;
  if (multiSchema) {
    for (const e of enums.values()) schemas.add(e.ns);
    for (const plan of plans.values()) schemas.add(plan.nsName);
  }

  for (const [id, e] of enums) {
    const customType = model.objects.customType[id] as CustomType;
    const lines = [`enum ${e.name} {`];
    for (const [label, name] of e.values) {
      lines.push(name === label ? `  ${name}` : `  ${name} @map(${prismaString(label)})`);
    }
    const attrs = [
      e.name === customType.name ? null : `@@map(${prismaString(customType.name)})`,
      multiSchema ? `@@schema(${prismaString(e.ns)})` : null,
    ].filter((a) => a !== null);
    if (attrs.length > 0) lines.push('', ...attrs.map((a) => `  ${a}`));
    lines.push('}');
    blocks.push({
      phase: 'custom-types',
      kind: 'enum',
      text: lines.join('\n'),
      target: { type: 'customType', id },
    });
  }

  for (const plan of plans.values()) {
    const lines: string[] = [];
    if (plan.ignored) lines.push(NO_UNIQUE_IDENTIFIER);
    if (options.includeComments) lines.push(...docLines(plan.entity.doc, ''));
    lines.push(`model ${plan.name} {`);
    const rows: (readonly [string, string, string] | string)[] = [];
    for (const field of plan.fields) {
      if (options.includeComments) rows.push(...docLines(field.doc, '  '));
      const name = plan.fieldName.get(field.id) ?? field.name;
      const { defaultAttr, nativeAttr } = fieldAttributes(field, model, enums);
      const attrs = [
        ...(plan.fieldAttrs.get(field.id) ?? []),
        defaultAttr,
        name === field.name ? null : `@map(${prismaString(field.name)})`,
        nativeAttr,
      ].filter((a) => a !== null);
      rows.push([name, fieldType(field, model, enums), attrs.join(' ')]);
    }
    rows.push(...plan.relationLines);
    lines.push(...aligned(rows));
    const attrs = [
      ...plan.blockAttrs,
      plan.name === plan.entity.name ? null : `@@map(${prismaString(plan.entity.name)})`,
      plan.ignored ? '@@ignore' : null,
      multiSchema ? `@@schema(${prismaString(plan.nsName)})` : null,
    ].filter((a) => a !== null);
    if (attrs.length > 0) lines.push('', ...attrs.map((a) => `  ${a}`));
    if (plan.unsupported.length > 0) {
      lines.push(
        '',
        ...plan.unsupported.map((u) => `  // Not supported by Prisma, left out: ${u}`),
      );
    }
    lines.push('}');
    blocks.push({
      phase: 'entities',
      kind: 'model',
      text: lines.join('\n'),
      target: { type: 'entity', id: plan.entity.id },
    });
  }

  const header: string[] = [];
  if (skipped) header.push(REDACTION_NOTICE);
  if (viewsLeftOut)
    header.push('// Views are not included: Prisma supports them only as a preview feature.');
  const datasource = [
    'datasource db {',
    '  provider = "postgresql"',
    '  url      = env("DATABASE_URL")',
    ...(multiSchema ? [`  schemas  = ${list([...schemas].sort(compare).map(prismaString))}`] : []),
    '}',
  ];
  const statements: ExportStatement[] = [
    ...(header.length > 0 ? [header.join('\n')] : []),
    'generator client {\n  provider = "prisma-client-js"\n}',
    datasource.join('\n'),
  ].map((text, ordinal) => ({ ordinal, phase: 'header', kind: 'prisma', text, target: null }));
  for (const block of blocks) statements.push({ ordinal: statements.length, ...block });

  return { statements, separator: '\n', incomplete: skipped, diagnostics };
}

function byName(a: Constraint | Index | Link, b: Constraint | Index | Link): number {
  return compare(a.name, b.name) || compare(a.id, b.id);
}

/** The key columns of an index, or null when Prisma can't express it (expressions, INCLUDE). */
function indexFieldIds(index: Index): Id[] | null {
  const ids: Id[] = [];
  for (const column of [...index.columns].sort((a, b) => a.ordinal - b.ordinal)) {
    if (column.fieldId === null || column.role === 'include') return null;
    ids.push(column.fieldId);
  }
  return ids.length === 0 ? null : ids;
}

type Enums = ReadonlyMap<Id, { name: string; values: ReadonlyMap<string, string> }>;

/** The field's type resolved through domains to a built-in, with the domain's array-ness kept. */
function resolveField(field: Field, model: SchemaModel): ReturnType<typeof TYPE_CATALOG.resolve> {
  const ctx = { customTypes: Object.values(model.objects.customType), namespaceName: '' };
  let resolved = TYPE_CATALOG.resolve(field.type, ctx);
  const custom = resolved.customType;
  if (custom?.kind === 'domain' && custom.propsRedacted !== true) {
    const base = propString(custom.engineProps, 'baseType');
    const parsed = base === undefined ? null : /^\s*([^(]+?)\s*(?:\(([^)]*)\))?\s*$/.exec(base);
    if (parsed?.[1] !== undefined) {
      const args = parsed[2]?.split(',').map((a) => (/^\s*\d+\s*$/.test(a) ? Number(a) : a.trim()));
      const ref: TypeRef = {
        name: parsed[1],
        ...(args === undefined ? {} : { args }),
        dimensions: field.type.dimensions ?? 0,
      };
      resolved = TYPE_CATALOG.resolve(ref, ctx);
    }
  }
  return resolved;
}

export function fieldType(field: Field, model: SchemaModel, enums: Enums): string {
  const resolved = resolveField(field, model);
  const dims = resolved.dimensions;
  const enumType = resolved.customType === null ? undefined : enums.get(resolved.customType.id);
  const scalar = enumType?.name ?? SCALARS[resolved.descriptor?.id ?? '']?.scalar;
  if (scalar === undefined || dims > 1) {
    return `Unsupported(${prismaString(TYPE_CATALOG.format(TYPE_CATALOG.resolve(field.type, { customTypes: Object.values(model.objects.customType), namespaceName: '' })))})${field.isNullable ? '?' : ''}`;
  }
  // A list can't be optional in Prisma; `db pull` drops the `?` the same way.
  return dims === 1 ? `${scalar}[]` : `${scalar}${field.isNullable ? '?' : ''}`;
}

function fieldAttributes(
  field: Field,
  model: SchemaModel,
  enums: Enums,
): { defaultAttr: string | null; nativeAttr: string | null } {
  const resolved = resolveField(field, model);
  const scalar = SCALARS[resolved.descriptor?.id ?? ''];
  const enumType = resolved.customType === null ? undefined : enums.get(resolved.customType.id);
  const props = field.propsRedacted === true ? {} : field.engineProps;
  let defaultAttr: string | null = null;
  let nativeAttr: string | null = null;

  if (scalar?.serial === true || props.identity === 'always' || props.identity === 'byDefault') {
    defaultAttr = '@default(autoincrement())';
  } else {
    const expression = propString(props, 'default');
    if (expression !== undefined) {
      const kind = enumType === undefined ? (scalar?.scalar ?? null) : 'enum';
      defaultAttr = `@default(${defaultValue(expression, kind, enumType?.values, resolved.dimensions > 0)})`;
    }
  }

  if (scalar?.native !== undefined && resolved.dimensions <= 1 && enumType === undefined) {
    const args = resolved.ref.args ?? (scalar.precision === undefined ? [] : [scalar.precision]);
    nativeAttr = `@db.${scalar.native}${args.length > 0 ? `(${args.join(', ')})` : ''}`;
  }
  return { defaultAttr, nativeAttr };
}

/** `prisma format`'s layout: name, type and attributes in columns; a comment line passes through. */
function aligned(rows: readonly (readonly [string, string, string] | string)[]): string[] {
  const fields = rows.filter((r) => typeof r !== 'string');
  const nameWidth = Math.max(0, ...fields.map((r) => r[0].length));
  const typeWidth = Math.max(0, ...fields.map((r) => r[1].length));
  return rows.map((r) =>
    typeof r === 'string'
      ? r
      : `  ${r[0].padEnd(nameWidth)} ${r[2] === '' ? r[1] : `${r[1].padEnd(typeWidth)} ${r[2]}`}`,
  );
}

/** A SQL default as Prisma writes it; `dbgenerated` when there's no exact Prisma literal. */
export function defaultValue(
  expression: string,
  scalar: string | null,
  enumValues: ReadonlyMap<string, string> | undefined,
  isList: boolean,
): string {
  const sql = expression.trim();
  const generated = `dbgenerated(${prismaString(sql)})`;
  if (isList) return generated;
  if (/^-?\d+(\.\d+)?$/.test(sql) && ['Int', 'BigInt', 'Float', 'Decimal'].includes(scalar ?? ''))
    return sql;
  if (/^(true|false)$/i.test(sql) && scalar === 'Boolean') return sql.toLowerCase();
  if (/^(now\(\)|current_timestamp)$/i.test(sql) && scalar === 'DateTime') return 'now()';
  const literal = /^'((?:[^']|'')*)'(?:::[\w\s."[\]]+)?$/.exec(sql);
  if (literal?.[1] !== undefined) {
    const text = literal[1].replace(/''/g, "'");
    if (scalar === 'String') return prismaString(text);
    const value = enumValues?.get(text);
    if (scalar === 'enum' && value !== undefined) return value;
  }
  return generated;
}
