import { open } from 'node:fs/promises';
import { IntrospectError, type Introspector } from '@schemaloom/engine-sdk';
import { openReadOnly } from './sqlite.js';

/**
 * Phase 13 §5 — reading an uploaded `.db` file. Core wrote it to a temporary file (and deletes
 * it); this opens it READ-ONLY and runs one query over `sqlite_schema`, so no row of user data
 * is ever read. The result is DDL in the engine's own `ddl` format, which goes through the
 * normal import pipeline (introspection produces source, not IR).
 */

const MAGIC = 'SQLite format 3\u0000';

/** The SQLite version that last wrote the file: header bytes 96–99, big-endian. */
function writerVersion(header: Buffer): string {
  const n = header.length >= 100 ? header.readUInt32BE(96) : 0;
  if (n === 0) return 'SQLite';
  return `SQLite ${String(Math.floor(n / 1_000_000))}.${String(Math.floor(n / 1000) % 1000)}.${String(n % 1000)}`;
}

export const INTROSPECTOR: Introspector = {
  async introspect(req) {
    if (req.file === undefined) {
      throw new IntrospectError('failed', 'Upload the database file to read it.');
    }
    const handle = await open(req.file, 'r');
    const header = Buffer.alloc(100);
    try {
      await handle.read(header, 0, 100, 0);
    } finally {
      await handle.close();
    }
    if (header.subarray(0, 16).toString('latin1') !== MAGIC) {
      throw new IntrospectError('failed', 'This is not an SQLite database file.');
    }
    let db;
    try {
      db = await openReadOnly(req.file);
    } catch {
      throw new IntrospectError('failed', 'The file could not be opened as an SQLite database.');
    }
    let rows;
    try {
      // Tables first, then indexes, then views, each in the order they were made. The
      // `sqlite_` objects are SQLite's own (autoindexes, sqlite_sequence).
      rows = db.all(
        "SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' " +
          "AND type IN ('table', 'index', 'view') " +
          "ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, rowid",
      );
    } catch {
      throw new IntrospectError('failed', 'The file’s schema could not be read.');
    } finally {
      db.close();
    }
    const source = rows.map((r) => `${String(r.sql)};`).join('\n');
    if (Buffer.byteLength(source, 'utf8') > req.maxBytes) {
      throw new IntrospectError('too_large', 'The schema is larger than the import limit.');
    }
    return { source, format: 'ddl', serverVersion: writerVersion(header) };
  },
};
