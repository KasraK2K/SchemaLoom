import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from './mcp';

/** Phase 11 §5. CI scripts can tell "the database moved" (1) from "the token expired" (3). */
export const EXIT = { ok: 0, drift: 1, usage: 2, server: 3 } as const;

export interface Io {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (text: string | Uint8Array) => void;
  readonly err: (text: string) => void;
  readonly writeFile: (path: string, data: string | Uint8Array) => Promise<void>;
  /** Between export polls; tests pass a no-op. */
  readonly sleep: (ms: number) => Promise<void>;
}

export const defaultIo: Io = {
  env: process.env,
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  writeFile: (path, data) => writeFile(path, data),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const HELP = `Usage: schemaloom <command> [options]

Commands:
  whoami                         The token's name, project, scopes and expiry
  pull --format <id> [--out f]   Export the design (ir, ddl, prisma, markdown, ...).
                                 Writes to stdout without --out
  diff [--fail-on-drift] [--sql f] [--json] [--allow-destructive]
                                 Compare the project's saved connection with the design
  mcp                            Serve the design to an AI agent over MCP (stdio).
                                 Needs a token with the agent scope

Configuration:
  SCHEMALOOM_URL    e.g. https://schemaloom.example.com   (or --url)
  SCHEMALOOM_TOKEN  an slt_... API token                  (or --token; the variable is
                    better, a flag ends up in shell history)

Exit codes: 0 ok or in sync, 1 drift with --fail-on-drift, 2 usage, 3 server refused or failed.
`;

class UsageError extends Error {}

class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** The api's `error.details`, e.g. the statements a proposal failed on. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(`${String(status)} ${code}`);
  }
}

const POLL_MS = 1000;
const POLL_LIMIT = 300;

interface Token {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string;
}

interface DriftEntry {
  readonly change: 'added' | 'removed' | 'changed';
  readonly objectType: string;
  readonly logicalKey: string;
}

interface Drift {
  readonly diff: {
    readonly entries: readonly DriftEntry[];
    readonly counts: { readonly added: number; readonly removed: number; readonly changed: number };
  };
  readonly migration: { readonly script: string };
}

export async function run(argv: readonly string[], io: Io = defaultIo): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`schemaloom: ${error.message}\n\n${HELP}`);
      return EXIT.usage;
    }
    if (error instanceof ServerError) {
      io.err(`schemaloom: the server refused: ${error.message}\n`);
      return EXIT.server;
    }
    io.err(`schemaloom: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.server;
  }
}

async function dispatch(argv: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    io.out(HELP);
    return command === undefined ? EXIT.usage : EXIT.ok;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: [...rest],
      strict: true,
      options: {
        url: { type: 'string' },
        token: { type: 'string' },
        format: { type: 'string' },
        out: { type: 'string' },
        sql: { type: 'string' },
        json: { type: 'boolean', default: false },
        'fail-on-drift': { type: 'boolean', default: false },
        'allow-destructive': { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const opts = parsed.values;
  const api = client(opts.url ?? io.env.SCHEMALOOM_URL, opts.token ?? io.env.SCHEMALOOM_TOKEN);
  const base = (opts.url ?? io.env.SCHEMALOOM_URL ?? '').replace(/\/+$/, '');

  switch (command) {
    case 'whoami': {
      const token = await api.json<Token>('GET', '/api/token');
      const project = await api.json<{ name: string; engineId: string }>(
        'GET',
        `/api/projects/${encodeURIComponent(token.projectId)}`,
      );
      io.out(
        `token    ${token.name}\nproject  ${project.name} (${token.projectId}, ${project.engineId})\n` +
          `scopes   ${token.scopes.join(', ')}\nexpires  ${token.expiresAt}\n`,
      );
      return EXIT.ok;
    }
    case 'pull': {
      if (opts.format === undefined) throw new UsageError('pull needs --format <id>');
      const data = await pull(api, opts.format, io);
      if (opts.out === undefined) io.out(data);
      else {
        await io.writeFile(opts.out, data);
        io.err(`wrote ${opts.out}\n`);
      }
      return EXIT.ok;
    }
    case 'diff': {
      const { projectId } = await api.json<Token>('GET', '/api/token');
      const drift = await fetchDrift(api, projectId, opts['allow-destructive']);
      const inSync = drift.diff.entries.length === 0;
      if (opts.json) io.out(`${JSON.stringify(drift, null, 2)}\n`);
      else io.out(summary(drift));
      if (opts.sql !== undefined && !inSync) {
        await io.writeFile(opts.sql, drift.migration.script);
        io.err(`wrote ${opts.sql}\n`);
      }
      return !inSync && opts['fail-on-drift'] ? EXIT.drift : EXIT.ok;
    }
    case 'mcp': {
      // stdout is the protocol from here on: errors go to stderr only.
      const token = await api.json<Token>('GET', '/api/token');
      if (!token.scopes.includes('agent')) {
        io.err('schemaloom: this token has no agent scope\n');
        return EXIT.usage;
      }
      const server = buildMcpServer(
        api,
        token,
        async () => summary(await fetchDrift(api, token.projectId, false)),
        base,
      );
      await server.connect(new StdioServerTransport());
      await new Promise<void>((resolve) => {
        server.server.onclose = resolve;
        process.stdin.once('end', resolve);
      });
      return EXIT.ok;
    }
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

function fetchDrift(api: Client, projectId: string, allowDestructive: boolean): Promise<Drift> {
  return api.json<Drift>(
    'POST',
    `/api/projects/${encodeURIComponent(projectId)}/introspect/drift`,
    {
      saved: true,
      allowDestructive,
    },
  );
}

async function pull(api: Client, format: string, io: Io): Promise<string | Uint8Array> {
  const { projectId } = await api.json<Token>('GET', '/api/token');
  const project = `/api/projects/${encodeURIComponent(projectId)}`;
  if (format === 'ir') {
    return `${JSON.stringify(await api.json<unknown>('GET', `${project}/ir`), null, 2)}\n`;
  }
  let job = await api.json<{
    id: string;
    status: string;
    error: string | null;
    downloadUrl?: string;
  }>('POST', `${project}/exports`, { format });
  for (let i = 0; job.status !== 'done' && job.status !== 'failed'; i++) {
    if (i >= POLL_LIMIT) throw new Error(`export ${job.id} did not finish in time`);
    await io.sleep(POLL_MS);
    job = await api.json('GET', `/api/exports/${encodeURIComponent(job.id)}`);
  }
  if (job.status === 'failed' || job.downloadUrl === undefined) {
    throw new Error(`export failed: ${job.error ?? 'no file'}`);
  }
  // A presigned storage URL: the token is never sent there.
  const file = await fetch(job.downloadUrl);
  if (!file.ok) throw new Error(`download failed: ${String(file.status)}`);
  return new Uint8Array(await file.arrayBuffer());
}

const SIGN = { added: '+', removed: '-', changed: '~' } as const;

function summary(drift: Drift): string {
  const { entries, counts } = drift.diff;
  if (entries.length === 0) return 'In sync: the database matches the design.\n';
  const lines = entries.map((e) => `  ${SIGN[e.change]} ${e.objectType} ${e.logicalKey}`);
  return (
    `Drift: ${String(counts.added)} in the design only, ${String(counts.removed)} in the ` +
    `database only, ${String(counts.changed)} different.\n${lines.join('\n')}\n`
  );
}

interface Client {
  json<T>(method: string, path: string, body?: unknown): Promise<T>;
}

function client(url: string | undefined, token: string | undefined): Client {
  if (url === undefined || url === '') throw new UsageError('set SCHEMALOOM_URL (or --url)');
  if (token === undefined || token === '')
    throw new UsageError('set SCHEMALOOM_TOKEN (or --token)');
  const base = url.replace(/\/+$/, '');
  return {
    async json<T>(method: string, path: string, body?: unknown): Promise<T> {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      if (!response.ok) {
        const { code, details } = errorOf(text);
        throw new ServerError(response.status, code, details);
      }
      return JSON.parse(text) as T;
    },
  };
}

function errorOf(text: string): { code: string; details: Record<string, unknown> } {
  try {
    // The api's one error shape: `{ error: { code, message, details? } }`.
    const parsed = JSON.parse(text) as { error?: { code?: unknown; details?: unknown } };
    const details = parsed.error?.details;
    return {
      code: typeof parsed.error?.code === 'string' ? parsed.error.code : 'error',
      details:
        typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : {},
    };
  } catch {
    return { code: 'error', details: {} };
  }
}
