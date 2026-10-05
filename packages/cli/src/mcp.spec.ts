import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { buildMcpServer, type McpApi } from './mcp';

/** A real MCP client over in-memory transports, against a stub of the token's routes. */
async function connect(
  scopes: readonly string[],
  answer: (method: string, path: string, body: unknown) => unknown,
) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const api: McpApi = {
    // eslint-disable-next-line @typescript-eslint/require-await -- a throw becomes a rejection
    async json<T>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      return answer(method, path, body) as T;
    },
  };
  const server = buildMcpServer(api, { projectId: 'p1', scopes }, () =>
    Promise.resolve('In sync: the database matches the design.\n'),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { text: string }[];
    return { text: content.map((c) => c.text).join('\n'), isError: result.isError === true };
  };
  return { client, call, calls };
}

const refusal = (code: string) => Object.assign(new Error(code), { status: 403, code });

describe('schemaloom mcp (Phase 21 §6)', () => {
  it('lists the read tools, and check_drift only with the drift scope', async () => {
    const names = async (scopes: string[]) =>
      (await (await connect(scopes, () => ({}))).client.listTools()).tools.map((t) => t.name);
    expect(await names(['read', 'agent'])).toEqual([
      'get_project',
      'list_objects',
      'describe_objects',
      'validate_query',
      'list_saved_queries',
    ]);
    expect(await names(['read', 'agent', 'drift'])).toContain('check_drift');
    expect(await names(['read', 'agent'])).not.toContain('propose_change');
    expect(await names(['read', 'agent', 'propose'])).toContain('propose_change');
  });

  it('propose_change links the request, and passes failed statements back (21b)', async () => {
    let fail = false;
    const { call, calls } = await connect(['read', 'agent', 'propose'], () => {
      if (fail)
        throw Object.assign(new Error('x'), {
          status: 422,
          code: 'proposal_statements_failed',
          details: { statements: [{ excerpt: 'CREATE TABL x', reason: 'syntax error' }] },
        });
      return {
        path: '/acme/p/p1/changes/cr1',
        created: ['invoice_lines'],
        skipped: ['invoices'],
        notApplied: [],
      };
    });
    const sql = 'CREATE TABLE invoice_lines (id int PRIMARY KEY);';
    expect((await call('propose_change', { title: 'Add invoice lines', sql })).text).toBe(
      'Proposed "Add invoice lines" for review: /acme/p/p1/changes/cr1\n' +
        'New tables: invoice_lines\nAlready exist, left unchanged: invoices',
    );
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/projects/p1/agent/proposals',
      body: { title: 'Add invoice lines', sql },
    });
    fail = true;
    const out = await call('propose_change', { title: 't', sql: 'CREATE TABL x' });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('- CREATE TABL x: syntax error');
  });

  it('turns tool calls into the token routes and answers into text', async () => {
    const { call, calls } = await connect(['read', 'agent'], (method, path) => {
      if (path.includes('/agent/outline')) return { lines: ['public.orders  table  3 columns'] };
      if (path.endsWith('/agent/context'))
        return { text: 'T orders', approxTokens: 3, omitted: [], notFound: ['nope'] };
      if (path.endsWith('/queries/validate'))
        return {
          parsed: true,
          parseErrors: [],
          identifiers: [
            { text: 'orders', status: 'resolved' },
            { text: 'totl', status: 'unknown' },
          ],
          statementKinds: ['SELECT'],
        };
      throw new Error(`${method} ${path}`);
    });
    expect((await call('list_objects', { namePattern: 'ord*' })).text).toBe(
      'public.orders  table  3 columns',
    );
    expect(calls[0]?.path).toBe('/api/projects/p1/agent/outline?namePattern=ord*');
    expect((await call('describe_objects', { names: ['orders', 'nope'] })).text).toBe(
      'T orders\n\nNot found: nope',
    );
    expect((await call('validate_query', { query: 'SELECT totl FROM orders' })).text).toBe(
      'Parses: yes (SELECT)\nNot in the design: totl',
    );
  });

  it('a refusal is a tool error with the code and a sentence, not a crash', async () => {
    const { call } = await connect(['read', 'agent'], () => {
      throw refusal('ai_disabled');
    });
    const out = await call('list_objects');
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/^ai_disabled: AI is turned off/);
    // The server is still alive for the next call.
    expect((await call('get_project')).isError).toBe(true);
  });
});
