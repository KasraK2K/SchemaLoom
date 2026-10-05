import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/**
 * Phase 21 §6 — `schemaloom mcp`: MCP tools over the token's REST routes. Every access
 * decision is the api's (scope, `ai:use`, the AI switch, redaction); this file only turns
 * tool calls into HTTP calls and answers into text. Nothing here writes to stdout: in
 * `run`, stdout is the protocol.
 */

export interface McpApi {
  json<T>(method: string, path: string, body?: unknown): Promise<T>;
}

type ToolResult = CallToolResult;

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });

/** The api's refusals as one plain sentence each. Never the token, never a stack. */
const SENTENCES: Readonly<Record<string, string>> = {
  ai_disabled: "AI is turned off for this project, so its schema can't be shared with an agent.",
  forbidden: "This token's user doesn't have the permission this needs.",
  invalid_token: 'The token is expired, revoked or wrong. Create a new one in SchemaLoom.',
  rate_limited: 'Too many requests. Wait a minute and try again.',
  too_many_proposals:
    'This token already has 5 proposals waiting for review. Ask the user to review them first.',
  nothing_to_propose: 'Everything in this SQL already exists in the design: nothing to propose.',
  proposal_statements_failed: "Some statements couldn't be read. Fix them and propose again:",
  agent_token_required: 'Proposals need an API token with the propose scope.',
  not_found: "SchemaLoom doesn't know this project, or this token can't reach it.",
};

async function guarded(call: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await call();
  } catch (error) {
    const code =
      typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'error';
    const sentence = SENTENCES[code] ?? 'The SchemaLoom server refused or failed.';
    const statements = (error as { details?: { statements?: unknown } }).details?.statements;
    const lines = Array.isArray(statements)
      ? (statements as { excerpt: string; reason: string | null }[]).map(
          (s) => `- ${s.excerpt}: ${s.reason ?? 'not read'}`,
        )
      : [];
    return { ...text([`${code}: ${sentence}`, ...lines].join('\n')), isError: true };
  }
}

export function buildMcpServer(
  api: McpApi,
  token: { readonly projectId: string; readonly scopes: readonly string[] },
  drift: () => Promise<string>,
  /** The SchemaLoom URL, for links to proposals. */
  baseUrl = '',
): McpServer {
  const project = `/api/projects/${encodeURIComponent(token.projectId)}`;
  const server = new McpServer({ name: 'schemaloom', version: '0.0.0' });
  const read = { readOnlyHint: true, openWorldHint: false } as const;

  server.registerTool(
    'get_project',
    {
      description:
        'The SchemaLoom project this token is for: its name, database engine and version.',
      annotations: read,
    },
    () =>
      guarded(async () => {
        const p = await api.json<Record<string, unknown>>('GET', project);
        return text(
          JSON.stringify(
            { name: p.name, engineId: p.engineId, engineVersion: p.engineVersion },
            null,
            2,
          ),
        );
      }),
  );

  server.registerTool(
    'list_objects',
    {
      description:
        'One line per table, view and enum in the database design: qualified name, kind, ' +
        'column count and the first line of its documentation. Start here, then call ' +
        'describe_objects for the tables you need.',
      inputSchema: {
        kind: z.string().optional().describe('table, view, enum, …'),
        area: z.string().optional().describe('only the tables in this area of the canvas'),
        namePattern: z.string().optional().describe('a name with * wildcards, e.g. order*'),
      },
      annotations: read,
    },
    (args) =>
      guarded(async () => {
        const query = new URLSearchParams(
          Object.entries(args).filter((e): e is [string, string] => typeof e[1] === 'string'),
        ).toString();
        const { lines } = await api.json<{ lines: string[] }>(
          'GET',
          `${project}/agent/outline${query === '' ? '' : `?${query}`}`,
        );
        return text(lines.length === 0 ? 'No objects match.' : lines.join('\n'));
      }),
  );

  server.registerTool(
    'describe_objects',
    {
      description:
        'Columns, types, keys, foreign keys, indexes and docs of the named tables, plus the ' +
        'tables their foreign keys point at. Names are schema.table or a bare table name. ' +
        'This is the design the team agreed on; write code and SQL against it.',
      inputSchema: {
        names: z.array(z.string()).min(1).max(50),
        includeDocs: z.boolean().optional(),
      },
      annotations: read,
    },
    (args) =>
      guarded(async () => {
        const out = await api.json<{
          text: string;
          omitted: { what: string; count: number }[];
          notFound: string[];
        }>('POST', `${project}/agent/context`, args);
        const notes = [
          ...(out.notFound.length === 0 ? [] : [`Not found: ${out.notFound.join(', ')}`]),
          ...out.omitted.map((o) => `Trimmed to fit: ${String(o.count)} ${o.what}`),
        ];
        return text([out.text, ...notes].filter((s) => s !== '').join('\n\n'));
      }),
  );

  server.registerTool(
    'validate_query',
    {
      description:
        'Check SQL against the design before showing it: whether it parses, and which ' +
        "tables and columns don't exist.",
      inputSchema: { query: z.string().min(1) },
      annotations: read,
    },
    (args) =>
      guarded(async () => {
        const r = await api.json<{
          parsed: boolean;
          parseErrors: { message: string }[];
          identifiers: { text: string; status: string }[];
          statementKinds: string[];
        }>('POST', `${project}/queries/validate`, { query: args.query });
        const unknown = [
          ...new Set(
            r.identifiers
              .filter((i) => i.status !== 'resolved' && i.status !== 'unchecked')
              .map((i) => i.text),
          ),
        ];
        const lines = r.parsed
          ? [
              `Parses: yes (${r.statementKinds.join(', ') || 'no statements'})`,
              unknown.length === 0
                ? 'Every table and column exists in the design.'
                : `Not in the design: ${unknown.join(', ')}`,
            ]
          : ['Parses: no', ...r.parseErrors.map((e) => `- ${e.message}`)];
        return text(lines.join('\n'));
      }),
  );

  server.registerTool(
    'list_saved_queries',
    {
      description: "The team's saved queries: name, description and SQL.",
      annotations: read,
    },
    () =>
      guarded(async () => {
        const { queries } = await api.json<{
          queries: { name: string; description: string | null; queryText: string }[];
        }>('GET', `${project}/saved-queries`);
        if (queries.length === 0) return text('No saved queries.');
        return text(
          queries
            .map(
              (q) =>
                `## ${q.name}\n${q.description === null ? '' : `${q.description}\n`}${q.queryText}`,
            )
            .join('\n\n'),
        );
      }),
  );

  if (token.scopes.includes('propose')) {
    server.registerTool(
      'propose_change',
      {
        description:
          'Propose a schema change for a person to review in SchemaLoom: new tables, columns, ' +
          "indexes and keys, written as DDL in the project's database dialect. Nothing changes " +
          'until someone approves and merges it, and existing objects are never renamed, changed ' +
          'or dropped. Call list_objects and describe_objects first: reuse existing tables and ' +
          "follow the design's naming, and reference existing tables by their real names.",
        inputSchema: {
          title: z
            .string()
            .min(1)
            .max(200)
            .describe('what the change does, e.g. Add invoice lines'),
          description: z.string().max(10_000).optional().describe('why, for the reviewer'),
          sql: z.string().min(1).describe('CREATE TABLE / ALTER TABLE … ADD … / CREATE INDEX'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      (args) =>
        guarded(async () => {
          const p = await api.json<{
            path: string;
            created: string[];
            skipped: string[];
            notApplied: { excerpt: string; reason: string | null }[];
          }>('POST', `${project}/agent/proposals`, args);
          return text(
            [
              `Proposed "${args.title}" for review: ${baseUrl}${p.path}`,
              p.created.length === 0 ? null : `New tables: ${p.created.join(', ')}`,
              p.skipped.length === 0
                ? null
                : `Already exist, left unchanged: ${p.skipped.join(', ')}`,
              ...p.notApplied.map((s) => `Read with loss: ${s.excerpt} (${s.reason ?? ''})`),
            ]
              .filter((line) => line !== null)
              .join('\n'),
          );
        }),
    );
  }

  if (token.scopes.includes('drift')) {
    server.registerTool(
      'check_drift',
      {
        description:
          "Compare the project's saved database connection with the design: what the " +
          'database has that the design does not, and the other way round.',
        annotations: read,
      },
      () => guarded(async () => text(await drift())),
    );
  }

  return server;
}
