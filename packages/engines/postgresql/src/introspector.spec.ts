import { spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { describe, expect, it } from 'vitest';
import { IMPORTER, defaultImportOptions } from './importer.js';
import {
  INTROSPECTOR,
  classifyPgDumpError,
  dumpedServerVersion,
  pgDumpInvocation,
} from './introspector.js';

const connection = {
  host: 'db.example.com',
  port: 6543,
  database: 'shop',
  user: 'reader',
  password: 's3cret!',
  sslmode: 'verify-full',
  schemas: ['public', ' billing ', ''],
};

describe('pgDumpInvocation', () => {
  const { args, env } = pgDumpInvocation({ connection, resolvedAddress: '203.0.113.7' });

  it('keeps the password out of argv', () => {
    expect(args.join(' ')).not.toContain('s3cret');
    expect(env.PGPASSWORD).toBe('s3cret!');
  });

  it('connects to the checked address and verifies the name', () => {
    expect(env).toMatchObject({
      PGHOST: 'db.example.com',
      PGHOSTADDR: '203.0.113.7',
      PGPORT: '6543',
      PGSSLMODE: 'verify-full',
    });
  });

  it('passes schemas as --schema= so a value is never read as an option', () => {
    expect(args).toEqual([
      '--schema-only',
      '--no-owner',
      '--no-privileges',
      '--schema=public',
      '--schema=billing',
    ]);
  });

  it('uses the system trust store for verify-full without a CA, and nothing else', () => {
    expect(env.PGSSLROOTCERT).toBe('system');
    const withCa = { ...connection, sslrootcert: '-----BEGIN CERTIFICATE-----' };
    expect(
      pgDumpInvocation({ connection: withCa, resolvedAddress: 'x' }).env.PGSSLROOTCERT,
    ).toBeUndefined();
    const verifyCa = { ...connection, sslmode: 'verify-ca' };
    expect(
      pgDumpInvocation({ connection: verifyCa, resolvedAddress: 'x' }).env.PGSSLROOTCERT,
    ).toBeUndefined();
  });

  it('does not inherit the api’s own database settings', () => {
    process.env.DATABASE_URL = 'postgres://app:pw@localhost/app';
    const fresh = pgDumpInvocation({ connection, resolvedAddress: '203.0.113.7' }).env;
    expect(Object.keys(fresh)).not.toContain('DATABASE_URL');
    expect(Object.values(fresh).join(' ')).not.toContain('app:pw');
  });

  it('defaults port and sslmode, and omits an empty password', () => {
    const minimal = pgDumpInvocation({
      connection: { host: 'h', database: 'd', user: 'u' },
      resolvedAddress: '203.0.113.7',
    }).env;
    expect(minimal.PGPORT).toBe('5432');
    expect(minimal.PGSSLMODE).toBe('require');
    expect(minimal).not.toHaveProperty('PGPASSWORD');
  });
});

describe('classifyPgDumpError', () => {
  const cases: [string, string][] = [
    [
      'pg_dump: error: server version: 18.0; pg_dump version: 17.2\npg_dump: error: aborting because of server version mismatch',
      'server_too_new',
    ],
    [
      'pg_dump: error: connection to server at "x" failed: FATAL:  password authentication failed for user "reader"',
      'auth_failed',
    ],
    [
      'pg_dump: error: connection to server failed: SSL error: certificate verify failed',
      'tls_failed',
    ],
    [
      'pg_dump: error: connection to server at "x", port 5432 failed: Connection refused',
      'unreachable',
    ],
    ['pg_dump: error: query failed: ERROR:  permission denied for schema secret', 'failed'],
  ];
  it.each(cases)('%s → %s', (stderr, code) => {
    expect(classifyPgDumpError(stderr, 's3cret!').code).toBe(code);
  });

  it('never echoes the password', () => {
    const error = classifyPgDumpError('pg_dump: error: weird s3cret! failure', 's3cret!');
    expect(error.message).not.toContain('s3cret!');
  });
});

it('reads the server version from the dump header', () => {
  expect(dumpedServerVersion('--\n-- Dumped from database version 16.4 (Debian)\n')).toBe('16.4');
  expect(dumpedServerVersion('CREATE TABLE t ();')).toBe('unknown');
});

it('reports a missing pg_dump as not_available', async () => {
  const saved = process.env.PG_DUMP_PATH;
  process.env.PG_DUMP_PATH = 'schemaloom-no-such-binary';
  try {
    await expect(
      INTROSPECTOR.introspect({
        connection,
        resolvedAddress: '203.0.113.7',
        signal: new AbortController().signal,
        maxBytes: 1_000,
      }),
    ).rejects.toMatchObject({ code: 'not_available' });
  } finally {
    if (saved === undefined) delete process.env.PG_DUMP_PATH;
    else process.env.PG_DUMP_PATH = saved;
  }
});

/**
 * §9 step 3 — against a real server. Set INTROSPECT_TEST_URL (e.g. the docker-compose
 * Postgres) and have pg_dump on PATH or at PG_DUMP_PATH; otherwise skipped.
 */
const testUrl = process.env.INTROSPECT_TEST_URL;
const hasPgDump = spawnSync(process.env.PG_DUMP_PATH ?? 'pg_dump', ['--version']).status === 0;

describe.skipIf(testUrl === undefined || !hasPgDump)('against a live server', () => {
  it('produces DDL the importer applies without failures', async () => {
    const url = new URL(testUrl ?? '');
    const result = await INTROSPECTOR.introspect({
      connection: {
        host: url.hostname,
        port: Number(url.port || 5432),
        database: url.pathname.slice(1),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        sslmode: 'disable',
      },
      // The api hands over an IP (pg_dump's hostaddr), never a name.
      resolvedAddress: (await lookup(url.hostname)).address,
      signal: new AbortController().signal,
      maxBytes: 50_000_000,
    });
    expect(result.serverVersion).not.toBe('unknown');
    const { report } = await IMPORTER.import(result.source, defaultImportOptions(), {
      projectId: 'p',
      serverVersion: null,
      newId: (() => {
        let n = 0;
        return () => `id${String(++n)}`;
      })(),
    });
    expect(report.statements.filter((s) => s.status === 'failed')).toEqual([]);
  }, 150_000);
});
