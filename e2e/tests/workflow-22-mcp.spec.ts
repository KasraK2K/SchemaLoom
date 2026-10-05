import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  API_URL,
  FAKE_ANTHROPIC_URL,
  signIn,
  signedInPage,
  write,
  type Session,
} from '../fixtures/api';
import { entityNames, fetchIr } from '../fixtures/ir';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * Roadmap 21 and 21b — `schemaloom mcp`. The built CLI runs as an agent would start it, and
 * the test speaks MCP to it over stdio (newline-delimited JSON-RPC). Checks: an agent sees
 * the assistant's view (no masked column), AI off means `ai_disabled`, no AI provider is
 * called, and a proposal becomes a change request the token's own user can approve.
 */
test.describe.configure({ mode: 'serial' });

const CLI = fileURLToPath(new URL('../../packages/cli/dist/index.js', import.meta.url));
const tag = String(Date.now());

interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
}

/** One `schemaloom mcp` process, initialised, with `call(tool, args)`. */
async function startMcp(token: string) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [CLI, 'mcp'], {
    env: { ...process.env, SCHEMALOOM_URL: API_URL, SCHEMALOOM_TOKEN: token },
  });
  let buffer = '';
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
      buffer = buffer.slice(end + 1);
      if (typeof message.id === 'number') waiting.get(message.id)?.(message);
    }
  });
  let next = 0;
  const request = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = ++next;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '0' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return {
    tools: async () =>
      ((await request('tools/list', {})).result as { tools: { name: string }[] }).tools.map(
        (t) => t.name,
      ),
    call: async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
      const { result } = (await request('tools/call', { name, arguments: args })) as {
        result: { content: { text: string }[]; isError?: boolean };
      };
      return {
        text: result.content.map((c) => c.text).join('\n'),
        isError: result.isError === true,
      };
    },
    stop: () => {
      child.kill();
    },
  };
}

const calls = async (): Promise<number> =>
  ((await (await fetch(`${FAKE_ANTHROPIC_URL}/calls`)).json()) as unknown[]).length;

const createToken = async (session: Session, projectId: string, scopes: string[]) => {
  const response = await session.api.post(`/api/projects/${projectId}/api-tokens`, {
    headers: write(session),
    data: { name: `mcp ${tag} ${scopes.join('+')}`, scopes },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { secret: string }).secret;
};

test.describe('workflow 22 — an AI agent over MCP', () => {
  test('the analyst creates an agent token; the agent never sees the masked column', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const page = await signedInPage(browser, SEED_EMAILS.analyst);
    await page.goto(`/${SEED.orgSlug}/p/${SEED.projectId}`);
    await page.getByRole('button', { name: 'Project settings' }).click();
    await page.getByLabel('Name').fill(`w22 ${tag}`);
    await page.getByLabel(/AI agents \(MCP\)/).check();
    await page.getByRole('button', { name: 'Create token' }).click();
    const shown = page.getByRole('status').filter({ hasText: 'Copy it now' });
    await expect(shown).toContainText('claude mcp add schemaloom');
    const token = (await shown.locator('code').first().textContent()) ?? '';
    expect(token).toMatch(/^slt_/);

    const before = await calls();
    const mcp = await startMcp(token);
    try {
      expect(await mcp.tools()).not.toContain('propose_change');
      const outline = await mcp.call('list_objects');
      expect(outline.text).toContain('public.employees');
      const described = await mcp.call('describe_objects', { names: ['employees', 'nope'] });
      expect(described.text).toContain('full_name');
      expect(described.text).not.toContain('salary');
      expect(described.text).toContain('Not found: nope');
      const valid = await mcp.call('validate_query', { query: 'SELECT salary FROM employees' });
      expect(valid.text).toContain('Not in the design: salary');
      // The agent's own model did the thinking: SchemaLoom called no AI provider.
      expect(await calls()).toBe(before);
    } finally {
      mcp.stop();
    }
  });

  test('turning the AI switch off answers ai_disabled; an agent proposal is reviewed and merged', async () => {
    test.setTimeout(180_000);
    const olivia = await signIn(SEED_EMAILS.owner);
    const created = await olivia.api.post('/api/projects', {
      headers: write(olivia),
      data: {
        organizationId: SEED.orgId,
        name: `MCP ${tag}`,
        engineId: 'postgresql',
        engineVersion: '16',
      },
    });
    const projectId = ((await created.json()) as { id: string }).id;
    const imported = await olivia.api.post(`/api/projects/${projectId}/import`, {
      headers: write(olivia),
      data: { source: 'CREATE TABLE customers (id uuid PRIMARY KEY, email text NOT NULL);' },
    });
    expect(imported.status(), await imported.text()).toBe(201);
    const token = await createToken(olivia, projectId, ['read', 'agent', 'propose']);
    const mcp = await startMcp(token);
    const requests = async () =>
      (
        (await (await olivia.api.get(`/api/projects/${projectId}/change-requests`)).json()) as {
          id: string;
          viaToken: { name: string } | null;
        }[]
      ).filter((r) => r.viaToken !== null);
    try {
      expect(await mcp.tools()).toContain('propose_change');

      // Refusals create nothing: a bad statement, and SQL that changes nothing.
      const bad = await mcp.call('propose_change', {
        title: 'Bad',
        sql: 'CREATE TABL x (id int);',
      });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain('proposal_statements_failed');
      const same = await mcp.call('propose_change', {
        title: 'Same',
        sql: 'CREATE TABLE customers (id uuid PRIMARY KEY, email text NOT NULL);',
      });
      expect(same.text).toContain('nothing_to_propose');
      expect(await requests()).toEqual([]);

      // A real one: the foreign key points at the existing table.
      const proposed = await mcp.call('propose_change', {
        title: 'Add invoices',
        sql:
          'CREATE TABLE invoices (id uuid PRIMARY KEY, customer_id uuid NOT NULL,\n' +
          '  CONSTRAINT invoices_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id));',
      });
      expect(proposed.isError, proposed.text).toBe(false);
      expect(proposed.text).toContain('New tables: invoices');
      const id = /\/changes\/([^\s/]+)/.exec(proposed.text)?.[1] ?? '';
      expect(entityNames(await fetchIr(olivia, projectId))).toEqual(['customers']);

      // The token's own user approves their agent's request (21b Q11), then merges it.
      const reviewed = await olivia.api.post(`/api/change-requests/${id}/reviews`, {
        headers: write(olivia),
        data: { verdict: 'approved' },
      });
      expect(reviewed.status(), await reviewed.text()).toBe(201);
      const detail = (await (await olivia.api.get(`/api/change-requests/${id}`)).json()) as {
        draftRevision: string;
        mergeBlockedBy: string | null;
      };
      expect(detail.mergeBlockedBy).toBeNull();
      const merged = await olivia.api.post(`/api/change-requests/${id}/merge`, {
        headers: write(olivia),
        data: { expectedDraftRevision: detail.draftRevision },
      });
      expect(merged.status(), await merged.text()).toBe(200);
      const ir = await fetchIr(olivia, projectId);
      expect(entityNames(ir)).toEqual(['customers', 'invoices']);
      const byName = new Map(Object.values(ir.objects.entity).map((e) => [e.name, e.id]));
      const links = Object.values(ir.objects.link) as unknown as {
        from: { entityId: string };
        to: { entityId: string };
      }[];
      expect(
        links.some(
          (l) =>
            l.from.entityId === byName.get('invoices') && l.to.entityId === byName.get('customers'),
        ),
      ).toBe(true);

      // A person's own request still needs a second reviewer.
      const own = await olivia.api.post(`/api/projects/${projectId}/change-requests`, {
        headers: write(olivia),
        data: { title: 'Mine' },
      });
      const ownId = ((await own.json()) as { id: string }).id;
      const selfReview = await olivia.api.post(`/api/change-requests/${ownId}/reviews`, {
        headers: write(olivia),
        data: { verdict: 'approved' },
      });
      expect(selfReview.status()).toBe(403);

      // At most five open proposals per token.
      for (let i = 0; i < 5; i++) {
        const open = await mcp.call('propose_change', {
          title: `T${String(i)}`,
          sql: `CREATE TABLE t${String(i)} (id int PRIMARY KEY);`,
        });
        expect(open.isError, open.text).toBe(false);
      }
      const sixth = await mcp.call('propose_change', {
        title: 'T5',
        sql: 'CREATE TABLE t5 (id int PRIMARY KEY);',
      });
      expect(sixth.text).toContain('too_many_proposals');

      // AI off: no schema reaches an agent, from the next call on.
      const off = await olivia.api.patch(`/api/projects/${projectId}/settings`, {
        headers: write(olivia),
        data: { ai: { enabled: false } },
      });
      expect(off.status(), await off.text()).toBe(200);
      const refused = await mcp.call('list_objects');
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('ai_disabled');
      expect((await mcp.call('validate_query', { query: 'SELECT 1' })).text).toContain(
        'ai_disabled',
      );
    } finally {
      mcp.stop();
    }
  });
});
