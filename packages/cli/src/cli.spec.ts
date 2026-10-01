import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EXIT, run, type Io } from './cli';

/** A stub api on `node:http`: the CLI talks real HTTP to it, as it would in CI. */
interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

let server: Server;
let base = '';
let seen: Seen[] = [];
let driftEntries: unknown[] = [];
let tokenStatus = 200;

const TOKEN = {
  id: 't1',
  name: 'CI',
  projectId: 'p1',
  scopes: ['read', 'drift'],
  expiresAt: '2027-01-01T00:00:00.000Z',
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of req) text += String(chunk);
  return text === '' ? undefined : (JSON.parse(text) as unknown);
}

beforeAll(async () => {
  let polls = 0;
  server = createServer((req, res) => {
    void readBody(req).then((body) => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        body,
      });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const route = `${req.method ?? ''} ${req.url ?? ''}`;
      if (route === 'GET /api/token') {
        if (tokenStatus !== 200) send(tokenStatus, { error: { code: 'invalid_token' } });
        else send(200, TOKEN);
      } else if (route === 'GET /api/projects/p1')
        send(200, { name: 'Shop', engineId: 'postgresql' });
      else if (route === 'GET /api/projects/p1/ir') send(200, { entities: {} });
      else if (route === 'POST /api/projects/p1/exports') {
        polls = 0;
        send(201, { id: 'e1', status: 'queued', error: null });
      } else if (route === 'GET /api/exports/e1') {
        polls += 1;
        send(
          200,
          polls < 2
            ? { id: 'e1', status: 'running', error: null }
            : { id: 'e1', status: 'done', error: null, downloadUrl: `${base}/download/e1` },
        );
      } else if (route === 'GET /download/e1') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('CREATE TABLE t ();\n');
      } else if (route === 'POST /api/projects/p1/introspect/drift') {
        const added = driftEntries.length;
        send(200, {
          diff: { entries: driftEntries, counts: { added, removed: 0, changed: 0 } },
          migration: { script: 'ALTER TABLE t ADD COLUMN c int;\n' },
        });
      } else send(404, { error: { code: 'not_found' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  seen = [];
  driftEntries = [];
  tokenStatus = 200;
});

function io(env: Record<string, string> = { SCHEMALOOM_URL: base, SCHEMALOOM_TOKEN: 'slt_x' }) {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  const value: Io = {
    env,
    out: (t) => out.push(typeof t === 'string' ? t : new TextDecoder().decode(t)),
    err: (t) => err.push(t),
    writeFile: (path, data) => {
      files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data));
      return Promise.resolve();
    },
    sleep: () => Promise.resolve(),
  };
  return { io: value, out, err, files };
}

describe('schemaloom CLI (Phase 11 §5)', () => {
  it('whoami prints the token, its project, scopes and expiry, sending the bearer token', async () => {
    const t = io();
    expect(await run(['whoami'], t.io)).toBe(EXIT.ok);
    expect(t.out.join('')).toContain('project  Shop (p1, postgresql)');
    expect(t.out.join('')).toContain('scopes   read, drift');
    expect(seen.every((s) => s.authorization === 'Bearer slt_x')).toBe(true);
  });

  it('pull --format ir reads /ir directly', async () => {
    const t = io();
    expect(await run(['pull', '--format', 'ir'], t.io)).toBe(EXIT.ok);
    expect(JSON.parse(t.out.join(''))).toEqual({ entities: {} });
  });

  it('pull --format ddl runs an export job, polls it, and never sends the token to storage', async () => {
    const t = io();
    expect(await run(['pull', '--format', 'ddl', '--out', 'schema.sql'], t.io)).toBe(EXIT.ok);
    expect(t.files.get('schema.sql')).toBe('CREATE TABLE t ();\n');
    expect(seen.find((s) => s.url.startsWith('/api/projects/p1/exports'))?.body).toEqual({
      format: 'ddl',
    });
    expect(seen.find((s) => s.url === '/download/e1')?.authorization).toBeUndefined();
  });

  it('diff asks for the saved connection and exits 0 when in sync', async () => {
    const t = io();
    expect(await run(['diff', '--fail-on-drift'], t.io)).toBe(EXIT.ok);
    expect(t.out.join('')).toContain('In sync');
    expect(seen.find((s) => s.url.endsWith('/introspect/drift'))?.body).toEqual({
      saved: true,
      allowDestructive: false,
    });
  });

  it('diff --fail-on-drift exits 1 on drift and writes the migration with --sql', async () => {
    driftEntries = [{ change: 'added', objectType: 'column', logicalKey: 'public.t.c' }];
    const t = io();
    expect(await run(['diff', '--fail-on-drift', '--sql', 'drift.sql'], t.io)).toBe(EXIT.drift);
    expect(t.out.join('')).toContain('+ column public.t.c');
    expect(t.files.get('drift.sql')).toContain('ALTER TABLE');

    const lenient = io();
    expect(await run(['diff'], lenient.io)).toBe(EXIT.ok);
  });

  it('exits 3 with the server code when the token is refused', async () => {
    tokenStatus = 401;
    const t = io();
    expect(await run(['whoami'], t.io)).toBe(EXIT.server);
    expect(t.err.join('')).toContain('401 invalid_token');
  });

  it('exits 2 on a usage or configuration error', async () => {
    expect(await run(['whoami'], io({}).io)).toBe(EXIT.usage);
    expect(await run(['pull'], io().io)).toBe(EXIT.usage);
    expect(await run(['nope'], io().io)).toBe(EXIT.usage);
    expect(await run(['diff', '--bogus'], io().io)).toBe(EXIT.usage);
  });
});
