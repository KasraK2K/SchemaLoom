# Phase 21: MCP server for AI agents (roadmap 21)

Status: **proposed** 2026-10-05. Waiting for approval; every §9 question has a default.

The goal: a developer's own AI agent (Claude Code, Cursor, Claude Desktop, any MCP client)
can ask SchemaLoom about a project's schema, such as "what columns does `orders` have", "how
does `invoices` join to `customers`", or "is this query valid against the design?", while it
writes code. The agent's own model does the thinking. **SchemaLoom never calls an AI
provider for this**, so `ANTHROPIC_API_KEY` is not needed and not used, and no request counts
against the built-in assistant's rate limits.

The rule that governs everything else: **an agent sees exactly what the built-in assistant
would see for the same user**. That is the redacted model, cut further by `ai:use` and the
project's AI kill switch. It is never more than the user sees on the canvas.

## 1. What the user sees

1. **Project settings → API tokens → Create token** gets a third choice next to **Read** and
   **Check drift**: **AI agents (MCP)**. It is offered only when the project's AI switch is
   on and the user has `ai:use` on the project.
2. After creating a token with that scope, the dialog shows a ready-to-paste setup snippet
   with the token filled in, once, like the token itself:

   ```bash
   claude mcp add schemaloom \
     -e SCHEMALOOM_URL=https://schemaloom.example.com \
     -e SCHEMALOOM_TOKEN=slt_... \
     -- npx -y @schemaloom/cli mcp
   ```

   It also shows a JSON block for clients that use a config file (Cursor, Claude Desktop).
   Until the CLI is on npm (Phase 11 Q5), the snippet runs `node <path>/dist/index.js mcp`.

3. **In the agent**, the tools in §4 appear under `schemaloom`. The agent calls them when it
   needs to; the user does nothing else.
4. **`docs/mcp.md`** has setup steps for Claude Code, Cursor and Claude Desktop, and says what
   an agent can and can't see.

## 2. Shape: a local stdio server inside the CLI

`schemaloom mcp` is a new CLI command. It speaks MCP over stdio to the agent and calls the
SchemaLoom REST API with the token, like `pull` and `diff` do.

- **Why stdio in the CLI and not an endpoint on the api?** The token model from Phase 11
  already does everything an MCP connection needs: one user, one project, a route
  allowlist, expiry, revoke, rate limit and `lastUsedAt`. A local server reuses all of it.
  Every access decision stays on the api side, in routes we already test. The CLI only turns
  tool calls into HTTP calls and formats the answers.
- **Remote MCP over HTTP** (`/api/mcp`, which claude.ai connectors need) means OAuth 2.1 and
  dynamic client registration. That is a second auth system. It is a later row (Q2).
- **The MCP SDK** (`@modelcontextprotocol/sdk`) handles the protocol: version negotiation,
  `initialize`, `tools/list`, `tools/call`. tsup bundles it into `dist`, so the published CLI
  still installs with no runtime dependencies (Q3).

## 3. Tokens: a new `agent` scope

`API_TOKEN_SCOPES` becomes `['read', 'drift', 'agent']`. As in Phase 11, every token has
`read`, and `agent` is added on top of it.

- **Creating** a token with `agent` requires `ai:use` on the project and
  `settings.ai.enabled`, so a token is never created for something it could not do. This is
  the same rule Phase 11 §3 applies to `drift`.
- **Every call checks both again.** If someone turns the project's AI switch off, every
  agent tool answers `ai_disabled` from then on. The token itself keeps working for `pull`.
  The switch means "no schema goes to an AI", and an agent is an AI.
- Tokens still never reach the socket, and never reach any route that writes.

## 4. Tools

Each tool is one call to an api route. All of them are read-only.

| Tool                 | Input                            | Route (scope)                                      | Returns                                                                                                                      |
| -------------------- | -------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `get_project`        | —                                | `GET /projects/:id` (`read`)                       | Name, engine and version, namespaces, areas, object counts                                                                   |
| `list_objects`       | `kind?`, `area?`, `namePattern?` | `GET /projects/:id/agent/outline` (`agent`) — new  | One line per table, view or enum: qualified name, kind, column count, the first line of its doc. Compact on purpose          |
| `describe_objects`   | `names` (1–50), `includeDocs?`   | `POST /projects/:id/agent/context` (`agent`) — new | `aiProfile.serializeContext` for those entities: columns, types, keys, foreign keys, indexes, and docs if the project allows |
| `validate_query`     | `query`                          | `POST /projects/:id/queries/validate` (`agent`)    | Whether it parses, which tables and columns it uses, and the ones that don't exist in the design                             |
| `list_saved_queries` | —                                | `GET /projects/:id/saved-queries` (`agent`)        | Name, description and SQL of the team's saved queries                                                                        |
| `check_drift`        | —                                | `POST /projects/:id/introspect/drift` (`drift`)    | Only listed when the token also has `drift`: the drift summary against the saved connection, as `schemaloom diff` prints it  |

`describe_objects` is the important one. It returns **the same text the built-in assistant
puts in its prompt**, made by the same engine function from the same redacted model, so the
two can't drift apart. An agent that wants the whole schema calls `list_objects`, then
describes what it needs, so a large project never arrives in one answer.

`validate_query` matters as much: the agent writes SQL from the description, then checks it
against the real design before showing it to the user.

## 5. The two new api routes

Both live in `AiService`, next to the context code they reuse, behind one new controller in
`src/ai`. Both are `@RequireProjectAccess('projectId')` and on `API_TOKEN_ROUTES` with
`agent`. A cookie session can call them too (they are harmless, and that keeps them testable).

```
GET  /api/projects/:projectId/agent/outline   ?kind=&area=&namePattern=
POST /api/projects/:projectId/agent/context   { names: string[], includeDocs?: boolean }
```

Each route goes through these steps in order:

1. `view(subject, projectId)` builds the caller's redacted model, exactly as for a thread.
   A share-link subject or an invisible project gets 404.
2. **`ai:use` at the project, then the kill switch.** The order and codes match `AiService`
   today: 403 `forbidden` with `atom: 'ai:use'`, then 403 `ai_disabled`.
3. Entities are filtered the way `contextEntities` already filters them: visible, not
   restricted, and with `ai:use` at the entity. **An entity that fails the check is left out,
   not refused.** The agent asked about the project, not about that entity. Masked columns
   are already masked in the redacted model.
4. `context` resolves each name against the filtered set (`schema.table`, or a bare
   `table` when only one namespace has it). It serializes the matches with
   `includeDocs = request && settings.ai.includeDocsInContext` and returns
   `{ text, approxTokens, omitted, notFound }`. **`notFound` lists every name that didn't
   resolve, whether it doesn't exist or is hidden, with one message for both.** Invisible is
   "not found", never "forbidden".

**No AI provider is involved.** These routes never touch `AiProvider` or its rate limit,
and they work when `ANTHROPIC_API_KEY` is unset. A test pins that. The token's own rate limit
(120 requests a minute) is the only throttle.

`validate_query` reuses the existing route. With a token principal it also runs the step-2
check, so a project with AI off can't be probed through the validator by an agent token.

## 6. The CLI command

- `schemaloom mcp` in `packages/cli/src/mcp.ts`, about 150 lines. It reads the URL and token
  exactly like the other commands, calls `GET /token` once at start, and lists only the tools
  the token's scopes allow. A token without `agent` exits 2 with
  `this token has no agent scope`.
- Errors come back to the agent as tool results (`isError: true`) with the server's error
  code (`ai_disabled`, `invalid_token`, `rate_limited`) and one plain sentence. They never
  crash the server process. An expired or revoked token makes every call say so.
- **Nothing is logged to stdout** (stdout is the protocol), and the token never appears in a
  tool result or an error.

## 7. What stays the same

- `VisibilityFilter` is still the only way schema data leaves. The new routes call
  `redactWith` through `AiService.view`; `LiveIr` stays in `src/snapshots`.
- No new table. The scope is a value in `ApiToken.scopes`, which needs no migration (it is
  `String[]`).
- No audit row per tool call. `lastUsedAt` already shows that a token is in use, and the token
  is the thing to revoke (Q5).

## 8. Build order

1. `agent` in `API_TOKEN_SCOPES`, the creation rule in `ApiTokensService`, the DTO, and the
   allowlist entries. Update `allowlist.spec.ts`.
2. `GET agent/outline` and `POST agent/context` in `src/ai`, with a routes spec. Unit tests:
   - masked column absent;
   - entity without `ai:use` absent;
   - restricted entity absent;
   - hidden name returns `notFound`, the same as a missing name;
   - AI switch off returns 403;
   - no API key still answers 200;
   - `includeDocs` respects the project setting.
3. The token check on `queries/validate`.
4. `schemaloom mcp` with the SDK bundled. A unit test drives it over in-memory streams against
   a `node:http` stub, the way `cli.spec.ts` does.
5. Web: the scope checkbox (disabled with a reason when AI is off or `ai:use` is missing), and
   the setup snippet in the created-token dialog.
6. `docs/mcp.md`, a line in `docs/ci.md`, and the roadmap row.
7. e2e workflow 20:
   - create an `agent` token in the browser;
   - start the built `schemaloom mcp` and call `list_objects`, `describe_objects` and
     `validate_query` over stdio;
   - check that a masked column never appears;
   - turn the AI switch off and check that the next call answers `ai_disabled`;
   - check that the fake Anthropic server received nothing.

## 9. Open questions

| #   | Question                                                                  | Default                                                                                                                                                       |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | What may an agent see: the user's view, or the built-in assistant's view? | **The assistant's view** (`ai:use` plus the kill switch). An agent sends schema to an AI provider just as the assistant does, so the same switch must stop it |
| Q2  | Remote MCP over HTTP (claude.ai connectors, no local install)?            | **Later row.** It needs OAuth 2.1 and dynamic client registration. Stdio covers Claude Code, Cursor and Claude Desktop today                                  |
| Q3  | MCP SDK or hand-written JSON-RPC?                                         | **The SDK, bundled by tsup.** The protocol changes version often; the SDK tracks it. The installed CLI still has no runtime dependencies                      |
| Q4  | Write tools (an agent proposes a schema change as a change request)?      | **Not in v1.** Read-only first. A later row could add `propose_change` through row 10's change requests, never a direct write                                 |
| Q5  | An audit row for every tool call?                                         | **No.** `lastUsedAt` and revoke cover it. If customers ask, add one `agent.context_read` row per call naming the token, not the content                       |
| Q6  | One token for several projects?                                           | **No**, as Phase 11 Q1. An agent working across two projects registers two servers (`schemaloom-billing`, `schemaloom-core`)                                  |
| Q7  | Export tools (`get_prisma_models`, DDL)?                                  | **No.** Exports aren't cut by `ai:use`, so they would break Q1. `describe_objects` gives the agent what it needs; `schemaloom pull` exists for files          |
| Q8  | Expose docs pages and comments as MCP resources?                          | **No.** Docs ride in `describe_objects` when the project allows it. Comments are conversation, not schema                                                     |
