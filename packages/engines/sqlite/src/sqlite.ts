/**
 * Phase 13 Q1 — the one file that touches `node:sqlite`. It loads lazily, so `./static` never
 * reaches it, and swapping in another driver (`better-sqlite3`) is this file only.
 *
 * Every database opened here is either a fresh `:memory:` one, where the importer runs an
 * allowlist of DDL and the query validator compiles a query, or an uploaded file opened
 * READ-ONLY. Extensions stay off (`node:sqlite`'s default), and `trusted_schema` is off so a
 * schema can't call functions with side effects.
 */

export type Row = Readonly<Record<string, unknown>>;

export interface Sqlite {
  exec(sql: string): void;
  all(sql: string): readonly Row[];
  /** compiles `sql` without running it; throws SQLite's error */
  prepare(sql: string): void;
  close(): void;
}

interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}

type DatabaseSyncCtor = new (path: string, options?: { readOnly?: boolean }) => DatabaseSyncLike;

let driver: Promise<DatabaseSyncCtor> | undefined;

function load(): Promise<DatabaseSyncCtor> {
  driver ??= import('node:sqlite').then(
    (m) => (m as unknown as { DatabaseSync: DatabaseSyncCtor }).DatabaseSync,
  );
  return driver;
}

function wrap(db: DatabaseSyncLike): Sqlite {
  db.exec('PRAGMA trusted_schema = OFF');
  return {
    exec: (sql) => {
      db.exec(sql);
    },
    all: (sql) => db.prepare(sql).all() as Row[],
    prepare: (sql) => {
      db.prepare(sql);
    },
    close: () => {
      db.close();
    },
  };
}

export async function openMemory(): Promise<Sqlite> {
  const DatabaseSync = await load();
  return wrap(new DatabaseSync(':memory:'));
}

export async function openReadOnly(path: string): Promise<Sqlite> {
  const DatabaseSync = await load();
  return wrap(new DatabaseSync(path, { readOnly: true }));
}

/** A SQL string literal. */
export const sqlString = (text: string): string => `'${text.replace(/'/g, "''")}'`;

/** A double-quoted identifier. */
export const quoteIdentifier = (name: string): string => `"${name.replace(/"/g, '""')}"`;
