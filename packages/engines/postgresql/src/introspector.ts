import { spawn } from 'node:child_process';
import {
  IntrospectError,
  type ConnectionValues,
  type IntrospectErrorCode,
  type IntrospectRequest,
  type IntrospectResult,
  type Introspector,
} from '@schemaloom/engine-sdk';

/**
 * Phase 6 §2 — `pg_dump --schema-only`, fed back through the DDL importer. `pg_dump` already
 * handles every edge case (partitions, identity and generated columns, domains, collations,
 * comments); a catalog-to-DDL renderer would repeat thousands of lines of it.
 *
 * Server-only (`node:child_process`): exported from `.` and never from `./static`.
 */

const TOTAL_TIMEOUT_MS = 120_000;
const CONNECT_TIMEOUT_S = '10';
const STDERR_CAP = 4_096;

const text = (values: ConnectionValues, id: string): string => {
  const value = values[id];
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
};

/**
 * The child's argv and env. Credentials travel in env (`PGPASSWORD`), never argv, which `ps`
 * shows to every local user. The env is built from scratch rather than inherited, so the
 * api's own `DATABASE_URL` and `PG*` settings can't leak into the connection. `PGHOSTADDR` is
 * the address core's SSRF guard checked; `PGHOST` stays the name so TLS verifies it.
 */
export function pgDumpInvocation(req: Pick<IntrospectRequest, 'connection' | 'resolvedAddress'>): {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
} {
  const { connection } = req;
  const schemas = Array.isArray(connection.schemas)
    ? (connection.schemas as readonly string[]).map((s) => s.trim()).filter((s) => s !== '')
    : [];
  const env: Record<string, string> = {
    PGHOST: text(connection, 'host'),
    PGHOSTADDR: req.resolvedAddress,
    PGPORT: text(connection, 'port') || '5432',
    PGDATABASE: text(connection, 'database'),
    PGUSER: text(connection, 'user'),
    PGSSLMODE: text(connection, 'sslmode') || 'require',
    PGCONNECT_TIMEOUT: CONNECT_TIMEOUT_S,
    PGAPPNAME: 'schemaloom-introspect',
  };
  const password = text(connection, 'password');
  if (password !== '') env.PGPASSWORD = password;
  // What a child process needs to start at all, on Linux and on Windows dev machines.
  for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'LANG']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    // `--schema=` rather than `-n <value>`: a value can't be read as another option.
    args: [
      '--schema-only',
      '--no-owner',
      '--no-privileges',
      ...schemas.map((s) => `--schema=${s}`),
    ],
    env,
  };
}

const MESSAGES: Record<IntrospectErrorCode, string> = {
  not_available: 'Reading a database is not available on this server (pg_dump is not installed).',
  unreachable: 'Could not reach the database. Check the host and port.',
  auth_failed: 'The database refused the user name or password.',
  tls_failed: 'The TLS connection failed. Check the SSL mode.',
  server_too_new: 'The database server is newer than this server’s pg_dump.',
  too_large: 'The schema is larger than the import limit.',
  timeout: 'Reading the schema took too long.',
  failed: 'pg_dump could not read the schema.',
};

/** Maps pg_dump's stderr to a code. The first line goes into the message only for codes whose
 *  text is useful (versions, a permission error), with the password scrubbed anyway. */
export function classifyPgDumpError(stderr: string, password: string): IntrospectError {
  const scrub = (s: string) => (password === '' ? s : s.split(password).join('***'));
  const line = scrub(
    stderr
      .split('\n')
      .map((l) => l.replace(/^pg_dump:\s*(error:\s*)?/, '').trim())
      .find((l) => l !== '') ?? '',
  ).slice(0, 300);
  const code: IntrospectErrorCode =
    /server version mismatch/i.test(stderr)
      ? 'server_too_new'
      : /password authentication failed|no password supplied|role .* does not exist/i.test(stderr)
        ? 'auth_failed'
        : /SSL|certificate/i.test(stderr)
          ? 'tls_failed'
          : /could not connect|connection refused|could not translate|timeout expired|no route to host/i.test(
                stderr,
              )
            ? 'unreachable'
            : 'failed';
  const detail = code === 'server_too_new' || code === 'failed' ? line : '';
  return new IntrospectError(code, detail === '' ? MESSAGES[code] : `${MESSAGES[code]} ${detail}`);
}

/** `-- Dumped from database version 16.4 (Debian 16.4-1.pgdg120+1)` */
export function dumpedServerVersion(source: string): string {
  return /^-- Dumped from database version (\S+)/m.exec(source)?.[1] ?? 'unknown';
}

export const INTROSPECTOR: Introspector = {
  introspect(req: IntrospectRequest): Promise<IntrospectResult> {
    const { args, env } = pgDumpInvocation(req);
    const command = process.env.PG_DUMP_PATH ?? 'pg_dump';
    const password = env.PGPASSWORD ?? '';

    return new Promise<IntrospectResult>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let stderr = '';
      let failure: IntrospectError | null = null;

      const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const stop = (error: IntrospectError) => {
        failure ??= error;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => {
        stop(new IntrospectError('timeout', MESSAGES.timeout));
      }, TOTAL_TIMEOUT_MS);
      const onAbort = () => {
        stop(new IntrospectError('timeout', MESSAGES.timeout));
      };
      req.signal.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > req.maxBytes) {
          stop(new IntrospectError('too_large', MESSAGES.too_large));
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < STDERR_CAP) stderr += chunk.toString('utf8');
      });
      let settled = false;
      const settle = () => {
        settled = true;
        clearTimeout(timer);
        req.signal.removeEventListener('abort', onAbort);
      };
      child.on('error', (error: NodeJS.ErrnoException) => {
        const mapped =
          error.code === 'ENOENT'
            ? new IntrospectError('not_available', MESSAGES.not_available)
            : new IntrospectError('failed', MESSAGES.failed);
        // A spawn failure has no process, so `close` may never follow.
        if (child.pid === undefined) {
          if (settled) return;
          settle();
          reject(mapped);
          return;
        }
        stop(mapped);
      });
      child.on('close', (exitCode) => {
        if (settled) return;
        settle();
        if (failure !== null) {
          reject(failure);
          return;
        }
        if (exitCode !== 0) {
          reject(classifyPgDumpError(stderr, password));
          return;
        }
        const source = Buffer.concat(chunks).toString('utf8');
        resolve({ source, format: 'ddl', serverVersion: dumpedServerVersion(source) });
      });
    });
  },
};
