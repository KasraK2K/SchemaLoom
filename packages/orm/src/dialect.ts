import type { Field, Id, Index, IrObjectRef, SchemaModel } from '@schemaloom/engine-sdk';

/**
 * Phase 8 §2 — what an engine hands the ORM layer. Everything else (names, keys, relations,
 * redaction, ordering, the four writers) is the layer's, written once.
 */

export type OrmId = 'prisma' | 'drizzle' | 'typeorm' | 'django';

export const ORM_IDS: readonly OrmId[] = ['prisma', 'drizzle', 'typeorm', 'django'];

export const isOrmId = (format: string): format is OrmId =>
  (ORM_IDS as readonly string[]).includes(format);

/** One engine type, spelled for each ORM. A missing ORM entry = that ORM can't express it. */
export interface OrmTypeEntry {
  /** `native` is the `@db.*` attribute, written only when it isn't the scalar's default.
   *  `precision` is the database's default when the type is written without one. */
  readonly prisma?: {
    readonly scalar: string;
    readonly native?: string;
    readonly precision?: number;
  };
  /** `fn('col', { params[0]: args[0], …, options })`; `options` is extra, fixed object text */
  readonly drizzle?: {
    readonly fn: string;
    readonly params?: readonly string[];
    readonly options?: string;
  };
  /** `@Column({ type, params[0]: args[0], … })` */
  readonly typeorm?: {
    readonly type: string;
    readonly params?: readonly string[];
    readonly options?: string;
  };
  /** `models.<field>(params[0]=args[0], …, options)` */
  readonly django?: {
    readonly field: string;
    readonly params?: readonly string[];
    readonly options?: string;
  };
  /** the TypeScript type a driver hands back (TypeORM's property type) */
  readonly ts?: 'string' | 'number' | 'boolean' | 'Date' | 'Buffer' | 'unknown';
}

/** A field's type, after the engine resolved domains and its own spellings. */
export interface OrmColumnType {
  /** a key of `OrmDialect.types`, or null when the engine doesn't know the type */
  readonly id: string | null;
  /** positional arguments (`[255]`, `[10, 2]`); null when the type is written without any */
  readonly args: readonly (string | number)[] | null;
  readonly dimensions: number;
  /** the type as the engine writes it, for `Unsupported("…")` and comments */
  readonly display: string;
  /** an `OrmEnum.key` when the type is an enum */
  readonly enumKey: string | null;
}

export interface OrmEnum {
  readonly key: string;
  /** what the database calls it; ORMs that name enums start from this */
  readonly name: string;
  /** null for an enum that belongs to a column (MySQL's inline `enum(…)`) */
  readonly namespaceId: Id | null;
  readonly labels: readonly string[];
  /** where a writer's block points: the custom type, or the column */
  readonly target: IrObjectRef;
}

export interface OrmDialect {
  readonly prismaProvider: 'postgresql' | 'mysql' | 'sqlite';
  /** `drizzle-orm/<core>`, and the prefix of its builders (`pgTable`, `mysqlEnum`) */
  readonly drizzle: {
    readonly core: 'pg-core' | 'mysql-core' | 'sqlite-core';
    readonly prefix: 'pg' | 'mysql' | 'sqlite';
  };
  /** whether enums are database types with names of their own (PostgreSQL) */
  readonly namedEnums: boolean;
  /** the engine's `CODE.exportOmitted`, for the "not exported" diagnostics */
  readonly omittedCode: string;
  /** false where a primary key's name is fixed (MySQL's `PRIMARY`) and Prisma rejects `map:` */
  readonly namedPrimaryKeys: boolean;
  readonly types: Readonly<Record<string, OrmTypeEntry>>;
  columnType(field: Field, model: SchemaModel): OrmColumnType;
  /** visible enums, and the hidden custom types skipped on the way (they make the export
   *  incomplete) */
  enums(model: SchemaModel): { readonly enums: readonly OrmEnum[]; readonly hidden: readonly Id[] };
  /** `serial`, identity, `AUTO_INCREMENT`, `AUTOINCREMENT` */
  autoIncrement(field: Field): boolean;
  /** the index's access method when it isn't the default b-tree: `gin`, `fulltext` */
  indexMethod(index: Index): string | null;
}
