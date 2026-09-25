import type { EngineProps } from '@schemaloom/engine-sdk';
import type { ReferentialAction } from './props.js';
import { qualify, quoteIdentifier, quoteLiteral } from './sql-text.js';

/**
 * One function per statement shape. Everything here is PURE TEXT over values the caller has
 * already resolved — no model lookups, no ordering decisions, no redaction. `exporter.ts`
 * owns all three, so a change to what is emitted and a change to when it is emitted cannot
 * be made in the same edit by accident.
 *
 * Every function returns a statement WITHOUT its trailing separator: `ExportStatement.text`
 * says "no trailing separator, no trailing newline", and `renderStatements` adds it.
 */

// --- reading an engineProps bag (unknown values, by C4) ---

export function propString(props: EngineProps, key: string): string | undefined {
  const value = props[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function propBool(props: EngineProps, key: string): boolean {
  return props[key] === true;
}

export function propNumber(props: EngineProps, key: string): number | undefined {
  const value = props[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A plain object, or undefined. `Array.isArray` narrows `unknown` to `any[]`, which takes
 *  the type checking with it, so every bag read below goes through this instead. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function propStringArray(props: EngineProps, key: string): readonly string[] | undefined {
  const value = props[key];
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === 'string');
  return out.length === value.length ? out : undefined;
}

const ACTION_SQL: Readonly<Record<ReferentialAction, string>> = {
  noAction: 'NO ACTION',
  restrict: 'RESTRICT',
  cascade: 'CASCADE',
  setNull: 'SET NULL',
  setDefault: 'SET DEFAULT',
};

function referentialAction(props: EngineProps, key: string): string | undefined {
  const value = props[key];
  return typeof value === 'string' && value in ACTION_SQL
    ? ACTION_SQL[value as ReferentialAction]
    : undefined;
}

/** Join the parts that are present. Written once because every renderer below is this. */
function join(...parts: readonly (string | undefined | false)[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ');
}

function deferral(props: EngineProps): string | undefined {
  if (!propBool(props, 'deferrable')) return undefined;
  return propBool(props, 'initiallyDeferred') ? 'DEFERRABLE INITIALLY DEFERRED' : 'DEFERRABLE';
}

function withOptions(props: EngineProps): string | undefined {
  const fillfactor = propNumber(props, 'fillfactor');
  return fillfactor === undefined ? undefined : `WITH (fillfactor = ${String(fillfactor)})`;
}

// --- namespaces ---

export function createSchema(name: string, props: EngineProps, ifNotExists: boolean): string {
  const owner = propString(props, 'owner');
  return join(
    'CREATE SCHEMA',
    ifNotExists && 'IF NOT EXISTS',
    quoteIdentifier(name),
    owner === undefined ? undefined : `AUTHORIZATION ${quoteIdentifier(owner)}`,
  );
}

// --- custom types ---

export function createEnum(qualified: string, labels: readonly string[]): string {
  return `CREATE TYPE ${qualified} AS ENUM (${labels.map(quoteLiteral).join(', ')})`;
}

export function createDomain(qualified: string, props: EngineProps): string {
  const base = propString(props, 'baseType') ?? 'text';
  const checks = propStringArray(props, 'checks') ?? [];
  return join(
    `CREATE DOMAIN ${qualified} AS ${base}`,
    propBool(props, 'notNull') && 'NOT NULL',
    mapDefined(propString(props, 'default'), (d) => `DEFAULT ${d}`),
    ...checks.map((check) => `CHECK (${check})`),
  );
}

export interface CompositeAttribute {
  readonly name: string;
  readonly type: string;
  readonly collation?: string | undefined;
}

export function createComposite(
  qualified: string,
  attributes: readonly CompositeAttribute[],
): string {
  const body = attributes
    .map((attribute) =>
      join(
        quoteIdentifier(attribute.name),
        attribute.type,
        mapDefined(attribute.collation, (c) => `COLLATE ${quoteIdentifier(c)}`),
      ),
    )
    .join(', ');
  return `CREATE TYPE ${qualified} AS (${body})`;
}

/** `CompositeAttribute[]` out of a composite type's props bag, or undefined when the bag does
 *  not hold the documented shape — in which case the exporter reports rather than guesses. */
export function compositeAttributes(props: EngineProps): readonly CompositeAttribute[] | undefined {
  const value: unknown = props.attributes;
  if (!Array.isArray(value)) return undefined;
  const items: readonly unknown[] = value;
  const out: CompositeAttribute[] = [];
  for (const item of items) {
    const record = asRecord(item);
    if (record === undefined) return undefined;
    const name = record.name;
    const type = record.type;
    const collation = record.collation;
    if (typeof name !== 'string' || typeof type !== 'string') return undefined;
    out.push({ name, type, collation: typeof collation === 'string' ? collation : undefined });
  }
  return out;
}

// --- entities ---

export interface ColumnInput {
  readonly name: string;
  /** already rendered by the type catalog */
  readonly type: string;
  readonly isNullable: boolean;
  readonly props: EngineProps;
}

/**
 * PostgreSQL's `ColumnDef` order: name, type, STORAGE, COMPRESSION, then column constraints.
 * Fixed here rather than derived, because the order IS part of the byte-identical contract.
 */
export function columnDefinition(column: ColumnInput): string {
  const props = column.props;
  const identity = props.identity;
  return join(
    quoteIdentifier(column.name),
    column.type,
    mapDefined(propString(props, 'collation'), (c) => `COLLATE ${quoteIdentifier(c)}`),
    mapDefined(propString(props, 'storage'), (s) => `STORAGE ${s.toUpperCase()}`),
    mapDefined(propString(props, 'compression'), (c) => `COMPRESSION ${c}`),
    mapDefined(propString(props, 'default'), (d) => `DEFAULT ${d}`),
    mapDefined(
      propString(props, 'generatedExpression'),
      (e) => `GENERATED ALWAYS AS (${e}) STORED`,
    ),
    identity === 'always'
      ? 'GENERATED ALWAYS AS IDENTITY'
      : identity === 'byDefault'
        ? 'GENERATED BY DEFAULT AS IDENTITY'
        : undefined,
    !column.isNullable && 'NOT NULL',
  );
}

export function createTable(
  qualified: string,
  columns: readonly string[],
  props: EngineProps,
  ifNotExists: boolean,
): string {
  const partitionBy = partitionClause(props);
  const body = columns.length === 0 ? '()' : `(\n  ${columns.join(',\n  ')}\n)`;
  return join(
    'CREATE',
    propBool(props, 'unlogged') && 'UNLOGGED',
    'TABLE',
    ifNotExists && 'IF NOT EXISTS',
    `${qualified} ${body}`,
    partitionBy,
    withOptions(props),
    mapDefined(propString(props, 'tablespace'), (t) => `TABLESPACE ${quoteIdentifier(t)}`),
  );
}

function partitionClause(props: EngineProps): string | undefined {
  const record = asRecord(props.partitionBy);
  if (record === undefined) return undefined;
  const strategy = record.strategy;
  const expression = record.expression;
  if (typeof strategy !== 'string' || typeof expression !== 'string') return undefined;
  return `PARTITION BY ${strategy.toUpperCase()} (${expression})`;
}

export function createView(
  kind: 'view' | 'materializedView',
  qualified: string,
  body: string,
  props: EngineProps,
  ifNotExists: boolean,
): string {
  if (kind === 'view') {
    const checkOption = propString(props, 'checkOption');
    return join(
      'CREATE VIEW',
      qualified,
      `AS ${body}`,
      checkOption === undefined
        ? undefined
        : `WITH ${checkOption.toUpperCase()} CHECK OPTION`,
    );
  }
  return join(
    'CREATE MATERIALIZED VIEW',
    ifNotExists && 'IF NOT EXISTS',
    qualified,
    mapDefined(propString(props, 'tablespace'), (t) => `TABLESPACE ${quoteIdentifier(t)}`),
    `AS ${body}`,
    props.withData === false ? 'WITH NO DATA' : undefined,
  );
}

export function enableRowLevelSecurity(qualified: string): string {
  return `ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY`;
}

// --- constraints ---

export function addConstraint(qualified: string, name: string, body: string): string {
  const named = name === '' ? '' : `ADD CONSTRAINT ${quoteIdentifier(name)}`;
  return join(`ALTER TABLE ${qualified}`, named === '' ? `ADD ${body}` : `${named} ${body}`);
}

/** The constraint body, or undefined when this engine cannot render the kind — which the
 *  caller turns into a report rather than into silence. */
export function constraintBody(
  kind: string,
  columns: readonly string[],
  props: EngineProps,
): string | undefined {
  const quoted = columns.map(quoteIdentifier).join(', ');
  const usingIndex = propString(props, 'usingIndex');

  switch (kind) {
    case 'primaryKey':
      return join(
        usingIndex === undefined
          ? `PRIMARY KEY (${quoted})`
          : `PRIMARY KEY USING INDEX ${quoteIdentifier(usingIndex)}`,
        deferral(props),
      );
    case 'unique':
      return join(
        'UNIQUE',
        propBool(props, 'nullsNotDistinct') && 'NULLS NOT DISTINCT',
        usingIndex === undefined ? `(${quoted})` : `USING INDEX ${quoteIdentifier(usingIndex)}`,
        deferral(props),
      );
    case 'check': {
      const expression = propString(props, 'expression');
      if (expression === undefined) return undefined;
      return join(`CHECK (${expression})`, propBool(props, 'noInherit') && 'NO INHERIT');
    }
    case 'exclusion': {
      const expression = propString(props, 'expression');
      if (expression === undefined) return undefined;
      return join(
        'EXCLUDE',
        mapDefined(propString(props, 'using'), (u) => `USING ${u}`),
        `(${expression})`,
        deferral(props),
      );
    }
    default:
      return undefined;
  }
}

export function foreignKeyBody(
  fromColumns: readonly string[],
  targetQualified: string,
  toColumns: readonly string[],
  props: EngineProps,
): string {
  const target =
    toColumns.length === 0
      ? targetQualified
      : `${targetQualified} (${toColumns.map(quoteIdentifier).join(', ')})`;
  return join(
    `FOREIGN KEY (${fromColumns.map(quoteIdentifier).join(', ')})`,
    `REFERENCES ${target}`,
    propBool(props, 'matchFull') && 'MATCH FULL',
    mapDefined(referentialAction(props, 'onDelete'), (a) => `ON DELETE ${a}`),
    mapDefined(referentialAction(props, 'onUpdate'), (a) => `ON UPDATE ${a}`),
    deferral(props),
  );
}

// --- indexes ---

export interface IndexColumnInput {
  /** exactly one of the two is set, mirroring `INDEX_COLUMN_SOURCE` */
  readonly columnName?: string | undefined;
  readonly expression?: string | undefined;
  readonly direction?: 'asc' | 'desc' | undefined;
  readonly props: EngineProps;
}

function indexColumnText(column: IndexColumnInput): string {
  const head =
    column.columnName !== undefined
      ? quoteIdentifier(column.columnName)
      : `(${column.expression ?? ''})`;
  return join(
    head,
    mapDefined(propString(column.props, 'collation'), (c) => `COLLATE ${quoteIdentifier(c)}`),
    propString(column.props, 'opclass'),
    column.direction === 'desc' ? 'DESC' : column.direction === 'asc' ? 'ASC' : undefined,
    mapDefined(propString(column.props, 'nullsOrder'), (o) => `NULLS ${o.toUpperCase()}`),
  );
}

export function createIndex(
  name: string,
  qualified: string,
  method: string,
  isUnique: boolean,
  keys: readonly IndexColumnInput[],
  included: readonly string[],
  props: EngineProps,
): string {
  return join(
    'CREATE',
    isUnique && 'UNIQUE',
    'INDEX',
    propBool(props, 'concurrently') && 'CONCURRENTLY',
    name === '' ? undefined : quoteIdentifier(name),
    `ON ${qualified}`,
    `USING ${method}`,
    `(${keys.map(indexColumnText).join(', ')})`,
    included.length === 0
      ? undefined
      : `INCLUDE (${included.map(quoteIdentifier).join(', ')})`,
    propBool(props, 'nullsNotDistinct') && 'NULLS NOT DISTINCT',
    withOptions(props),
    mapDefined(propString(props, 'tablespace'), (t) => `TABLESPACE ${quoteIdentifier(t)}`),
    mapDefined(propString(props, 'where'), (w) => `WHERE ${w}`),
  );
}

// --- comments (§10.2) ---

export type CommentSubject =
  | 'TABLE'
  | 'VIEW'
  | 'MATERIALIZED VIEW'
  | 'COLUMN'
  | 'SCHEMA'
  | 'TYPE'
  | 'DOMAIN'
  | 'INDEX';

export function commentOn(subject: CommentSubject, target: string, body: string): string {
  return `COMMENT ON ${subject} ${target} IS ${body}`;
}

// --- drops ---

export function dropStatement(subject: CommentSubject, target: string): string {
  return `DROP ${subject} IF EXISTS ${target} CASCADE`;
}

/** `undefined`-in, `undefined`-out mapping, so the `join` calls above stay one expression
 *  each instead of a local per optional clause. */
function mapDefined<T>(value: T | undefined, f: (value: T) => string): string | undefined {
  return value === undefined ? undefined : f(value);
}

export { qualify, quoteIdentifier };
