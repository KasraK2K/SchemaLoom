import { connect as netConnect } from 'node:net';
import {
  IntrospectError,
  type ConnectionValues,
  type IntrospectErrorCode,
  type IntrospectRequest,
  type IntrospectResult,
  type Introspector,
} from '@schemaloom/engine-sdk';
import { createConnection, type Connection, type ConnectionOptions } from 'mysql2/promise';

/**
 * Design §4, step 9b — a live database read with the `mysql2` driver (Q5): list the objects
 * in `information_schema.TABLES`, then concatenate `SHOW CREATE TABLE` / `SHOW CREATE VIEW`.
 * The text goes through the same importer as pasted SQL, so nothing here builds IR. No client
 * binary, so this never throws `not_available`.
 *
 * Server-only (`node:net`, `mysql2`): exported from `.` and never from `./static`.
 */

const TOTAL_TIMEOUT_MS = 120_000;
const CONNECT_TIMEOUT_MS = 10_000;

const text = (values: ConnectionValues, id: string): string => {
  const value = values[id];
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
};

/**
 * The driver's options. The socket is dialled to `resolvedAddress`, the address core's SSRF
 * guard checked, so nothing re-resolves the name (DNS rebinding). `host` stays the typed name:
 * mysql2 sends it as the TLS server name and checks the certificate against it.
 */
export function mysqlConnectionOptions(
  req: Pick<IntrospectRequest, 'connection'>,
): ConnectionOptions {
  const { connection } = req;
  const mode = text(connection, 'sslmode') || 'REQUIRED';
  const pem = (id: string) => text(connection, id) || undefined;
  return {
    host: text(connection, 'host'),
    port: Number(text(connection, 'port') || 3306),
    user: text(connection, 'user'),
    password: text(connection, 'password'),
    database: text(connection, 'database'),
    connectTimeout: CONNECT_TIMEOUT_MS,
    charset: 'utf8mb4',
    multipleStatements: false,
    // MySQL's --ssl-mode vocabulary. No CA means Node's trust store. PREFERRED is not offered:
    // it falls back to plain text silently, past core's insecure-value guard.
    ssl:
      mode === 'DISABLED'
        ? undefined
        : {
            rejectUnauthorized: mode !== 'REQUIRED',
            verifyIdentity: mode === 'VERIFY_IDENTITY',
            ca: pem('sslca'),
            cert: pem('sslcert'),
            key: pem('sslkey'),
          },
  };
}

const MESSAGES: Record<IntrospectErrorCode, string> = {
  not_available: 'Reading a database is not available on this server.',
  unreachable: 'Could not reach the database. Check the host and port.',
  auth_failed: 'The database refused the user name or password.',
  tls_failed: 'The TLS connection failed. Check the SSL mode and certificates.',
  server_too_new: 'The database server is too new to read.',
  too_large: 'The schema is larger than the import limit.',
  timeout: 'Reading the schema took too long.',
  failed: 'Could not read the schema.',
};

const AUTH_CODES = new Set([
  'ER_ACCESS_DENIED_ERROR',
  'ER_DBACCESS_DENIED_ERROR',
  'ER_ACCESS_DENIED_NO_PASSWORD_ERROR',
  'ER_NOT_SUPPORTED_AUTH_MODE',
]);
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'PROTOCOL_CONNECTION_LOST',
]);

/** Maps a driver or socket error to a code. Only `failed` carries the server's own text
 *  (an unknown database, a missing privilege), with the password scrubbed anyway. */
export function classifyMySqlError(error: unknown, password: string): IntrospectError {
  const { code = '', message = '' } = (error ?? {}) as { code?: unknown; message?: unknown };
  const c = typeof code === 'string' ? code : '';
  const m = typeof message === 'string' ? message : '';
  const kind: IntrospectErrorCode = AUTH_CODES.has(c)
    ? 'auth_failed'
    : c === 'HANDSHAKE_NO_SSL_SUPPORT' ||
        c === 'ER_SECURE_TRANSPORT_REQUIRED' ||
        /CERT|SSL|TLS/.test(c) ||
        /certificate|SSL|TLS/.test(m)
      ? 'tls_failed'
      : UNREACHABLE_CODES.has(c) || /ENOTFOUND|EAI_AGAIN/.test(c)
        ? 'unreachable'
        : 'failed';
  const scrubbed = (password === '' ? m : m.split(password).join('***')).slice(0, 300);
  const detail = kind === 'failed' ? scrubbed.trim() : '';
  return new IntrospectError(kind, detail === '' ? MESSAGES[kind] : `${MESSAGES[kind]} ${detail}`);
}

/** `8.4.3` → `MySQL 8.4.3`; `11.4.4-MariaDB-ubu2404` → `MariaDB 11.4.4` (the product name the
 *  target-version picker uses). */
export function formatServerVersion(version: string): string {
  const number = version.split('-')[0] ?? version;
  return /mariadb/i.test(version) ? `MariaDB ${number}` : `MySQL ${number}`;
}

const quote = (name: string) => `\`${name.replace(/`/g, '``')}\``;

/** A query's rows as arrays. Every column read here is text (names, versions, DDL). */
async function arrays(conn: Connection, sql: string): Promise<readonly (readonly string[])[]> {
  const [result] = await conn.query({ sql, rowsAsArray: true });
  return result as unknown as string[][];
}

async function readSchema(conn: Connection, maxBytes: number): Promise<IntrospectResult> {
  const versionRows = await arrays(conn, 'SELECT VERSION()');
  const serverVersion = formatServerVersion(versionRows[0]?.[0] ?? 'unknown');
  // SHOW CREATE's text depends on these: backticks, and no ANSI_QUOTES or ORACLE spelling.
  await conn.query("SET SESSION sql_mode = '', SESSION sql_quote_show_create = 1");
  await conn.query('SET SESSION TRANSACTION READ ONLY');
  // Tables first, then views, each by name, so the same database reads the same text.
  const objects = await arrays(
    conn,
    'SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES ' +
      "WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_TYPE = 'VIEW', TABLE_NAME",
  );

  const header = `-- Read from ${serverVersion} by SchemaLoom`;
  const parts = [header];
  let bytes = Buffer.byteLength(header, 'utf8');
  for (const [name = '', type] of objects) {
    const kind = type === 'VIEW' ? 'VIEW' : 'TABLE';
    const rows = await arrays(conn, `SHOW CREATE ${kind} ${quote(name)}`);
    const statement = `${rows[0]?.[1] ?? ''};`;
    bytes += Buffer.byteLength(statement, 'utf8') + 2;
    if (bytes > maxBytes) throw new IntrospectError('too_large', MESSAGES.too_large);
    parts.push(statement);
  }
  return { source: `${parts.join('\n\n')}\n`, format: 'ddl', serverVersion };
}

export const INTROSPECTOR: Introspector = {
  async introspect(req: IntrospectRequest): Promise<IntrospectResult> {
    const options = mysqlConnectionOptions(req);
    const socket = netConnect(options.port ?? 3306, req.resolvedAddress);
    socket.setNoDelay(true);
    // A holder, not a `let`: the flow analysis can't see the timer setting it.
    const stopped: { error: IntrospectError | null } = { error: null };
    let conn: Connection | null = null;
    const stop = () => {
      stopped.error ??= new IntrospectError('timeout', MESSAGES.timeout);
      socket.destroy();
    };
    const timer = setTimeout(stop, TOTAL_TIMEOUT_MS);
    req.signal.addEventListener('abort', stop, { once: true });
    try {
      conn = await createConnection({ ...options, stream: socket });
      return await readSchema(conn, req.maxBytes);
    } catch (error) {
      if (stopped.error !== null) throw stopped.error;
      if (error instanceof IntrospectError) throw error;
      throw classifyMySqlError(error, options.password ?? '');
    } finally {
      clearTimeout(timer);
      req.signal.removeEventListener('abort', stop);
      conn?.destroy();
      socket.destroy();
    }
  },
};
