import { renderStatements, type IntrospectRequest, type SchemaModel } from '@schemaloom/engine-sdk';
import { createConnection } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { ECOMMERCE_DDL } from './conformance-ddl.js';
import { EXPORTER } from './exporter.js';
import { fullyVisible } from './fixture-model.js';
import { IMPORTER } from './importer.js';
import {
  INTROSPECTOR,
  classifyMySqlError,
  formatServerVersion,
  mysqlConnectionOptions,
} from './introspector.js';

const connection = {
  host: 'db.example.com',
  port: 3310,
  database: 'shop',
  user: 'reader',
  password: 's3cret!',
  sslmode: 'VERIFY_IDENTITY',
  sslca: '-----BEGIN CERTIFICATE-----',
};

describe('mysqlConnectionOptions', () => {
  it('keeps the typed host name for TLS, and verifies it under VERIFY_IDENTITY', () => {
    expect(mysqlConnectionOptions({ connection })).toMatchObject({
      host: 'db.example.com',
      port: 3310,
      database: 'shop',
      multipleStatements: false,
      ssl: { rejectUnauthorized: true, verifyIdentity: true, ca: '-----BEGIN CERTIFICATE-----' },
    });
  });

  it('maps each SSL mode', () => {
    const ssl = (sslmode: string) =>
      mysqlConnectionOptions({ connection: { ...connection, sslmode } }).ssl;
    expect(ssl('REQUIRED')).toMatchObject({ rejectUnauthorized: false, verifyIdentity: false });
    expect(ssl('VERIFY_CA')).toMatchObject({ rejectUnauthorized: true, verifyIdentity: false });
    expect(ssl('DISABLED')).toBeUndefined();
    // An empty mode reads as the default, REQUIRED: encrypted.
    expect(ssl('')).toMatchObject({ rejectUnauthorized: false });
  });
});

describe('classifyMySqlError', () => {
  it.each([
    [{ code: 'ER_ACCESS_DENIED_ERROR', message: "Access denied for user 'reader'" }, 'auth_failed'],
    [{ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }, 'unreachable'],
    [
      { code: 'HANDSHAKE_NO_SSL_SUPPORT', message: 'Server does not support secure connection' },
      'tls_failed',
    ],
    [{ code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'self-signed certificate' }, 'tls_failed'],
    [{ code: 'ER_SECURE_TRANSPORT_REQUIRED', message: 'insecure transport' }, 'tls_failed'],
    [{ code: 'ER_BAD_DB_ERROR', message: "Unknown database 'shop'" }, 'failed'],
  ])('%o → %s', (error, code) => {
    expect(classifyMySqlError(error, 's3cret!').code).toBe(code);
  });

  it('says what failed, and never echoes the password', () => {
    expect(
      classifyMySqlError({ code: 'ER_BAD_DB_ERROR', message: "Unknown database 'shop'" }, '')
        .message,
    ).toContain("Unknown database 'shop'");
    const error = classifyMySqlError({ code: 'X', message: 'weird s3cret! failure' }, 's3cret!');
    expect(error.message).not.toContain('s3cret!');
  });
});

it('names the product in the server version', () => {
  expect(formatServerVersion('8.4.3')).toBe('MySQL 8.4.3');
  expect(formatServerVersion('11.4.4-MariaDB-ubu2404')).toBe('MariaDB 11.4.4');
});

it('reports a closed port as unreachable', async () => {
  await expect(
    INTROSPECTOR.introspect({
      connection: { ...connection, port: 1, sslmode: 'DISABLED' },
      resolvedAddress: '127.0.0.1',
      signal: new AbortController().signal,
      maxBytes: 1_000,
    }),
  ).rejects.toMatchObject({ code: 'unreachable' });
});

/**
 * Design §7 — the round trip against real servers: export DDL, run it on the server, read it
 * back, import that, and export again. The two exports must match, which is what catches the
 * dialect mistakes the parser alone can't. Set MYSQL_TEST_URL and/or MARIADB_TEST_URL (the
 * compose `mysql` profile: mysql://root:schemaloom@127.0.0.1:3306 and :3307); otherwise
 * skipped. Each run makes and drops its own database.
 */
const servers = [
  ['MySQL', process.env.MYSQL_TEST_URL],
  ['MariaDB', process.env.MARIADB_TEST_URL],
] as const;

const exportOptions = {
  format: 'ddl',
  includeComments: true,
  includeDrops: false,
  includeIfNotExists: false,
  engineOptions: {},
};

async function importModel(source: string, serverVersion: string): Promise<SchemaModel> {
  let n = 0;
  const { model, report } = await IMPORTER.import(
    source,
    { format: 'ddl', defaultNamespace: null, caseFolding: 'preserve', engineOptions: {} },
    { projectId: 'p1', serverVersion, newId: () => `id${String((n += 1)).padStart(4, '0')}` },
  );
  expect(
    report.statements.filter((s) => s.status === 'failed' || s.status === 'unsupported'),
  ).toEqual([]);
  return model;
}

async function exportDdl(model: SchemaModel, serverVersion: string): Promise<string> {
  const result = await EXPORTER.export({
    model: fullyVisible(model),
    options: exportOptions,
    context: { projectId: 'p1', serverVersion },
  });
  return renderStatements(result);
}

describe.each(servers.filter(([, url]) => url !== undefined))(
  'against a live %s server',
  (product, url) => {
    const target = url ?? '';
    const version = product === 'MariaDB' ? 'MariaDB 11.4' : 'MySQL 8.4';
    const parsed = new URL(target);
    const database = `schemaloom_rt_${String(process.pid)}`;
    const request = (overrides: Record<string, string | number> = {}): IntrospectRequest => ({
      connection: {
        host: parsed.hostname,
        port: Number(parsed.port || 3306),
        database,
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
        sslmode: 'REQUIRED',
        ...overrides,
      },
      resolvedAddress: parsed.hostname,
      signal: new AbortController().signal,
      maxBytes: 50_000_000,
    });

    async function admin<T>(
      run: (conn: Awaited<ReturnType<typeof createConnection>>) => Promise<T>,
    ) {
      const conn = await createConnection({
        host: parsed.hostname,
        port: Number(parsed.port || 3306),
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
        multipleStatements: true,
      });
      try {
        return await run(conn);
      } finally {
        await conn.end();
      }
    }

    it('reads back exactly what was exported, over TLS and in plain text', async () => {
      // The fixture is a MySQL dump; MariaDB has no functional key parts (the validator says so).
      const source =
        product === 'MariaDB'
          ? ECOMMERCE_DDL.replace(/^ {2}KEY `idx_lower_email`.*\n/m, '')
          : ECOMMERCE_DDL;
      const designed = await exportDdl(await importModel(source, version), version);
      await admin(async (conn) => {
        await conn.query(
          `DROP DATABASE IF EXISTS ${database}; CREATE DATABASE ${database}; USE ${database};`,
        );
        await conn.query(designed);
      });
      try {
        for (const sslmode of ['REQUIRED', 'DISABLED']) {
          const result = await INTROSPECTOR.introspect(request({ sslmode }));
          expect(result.serverVersion).toMatch(new RegExp(`^${product} \\d+\\.\\d+`));
          // MariaDB rewrites a view's text (drops parentheses); view bodies are kept as written,
          // so there the view is compared up to its body. A known gap, as with pg_dump.
          const loose = (sql: string) =>
            product === 'MariaDB' ? sql.replace(/( VIEW `[^`]+` AS ).*;$/gm, '$1…;') : sql;
          const readBack = await exportDdl(await importModel(result.source, version), version);
          expect(loose(readBack)).toBe(loose(designed));
        }
      } finally {
        await admin((conn) => conn.query(`DROP DATABASE IF EXISTS ${database}`));
      }
    }, 60_000);

    it('maps a wrong password and a missing database', async () => {
      await expect(INTROSPECTOR.introspect(request({ password: 'wrong' }))).rejects.toMatchObject({
        code: 'auth_failed',
      });
      await expect(
        INTROSPECTOR.introspect(request({ database: 'schemaloom_no_such_db' })),
      ).rejects.toMatchObject({ code: 'failed' });
    });

    it('refuses a self-signed server under VERIFY_CA', async () => {
      await expect(
        INTROSPECTOR.introspect(request({ sslmode: 'VERIFY_CA' })),
      ).rejects.toMatchObject({
        code: 'tls_failed',
      });
    });
  },
);
