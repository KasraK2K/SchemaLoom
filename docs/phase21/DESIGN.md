# Phase 21: MCP server for AI agents (roadmap 21)

Status: **proposed** 2026-10-05. Waiting for approval; every §10 question has a default.

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

## 9. Follow-up (21b): agents propose changes

Status: **proposed** 2026-10-05, to build after v1 (Q9). This answers Q4: an agent can add
tables to the design, but **only as a change request a person reviews**, never as a direct
write.

**Why not direct writes.** An agent working on one task guesses: it creates `user_profiles`
when `users` already has those columns, or names things against the team's conventions, on a
canvas the whole team shares. It also reads untrusted text (issues, web pages, READMEs), so a
direct write would let a prompt injection change the schema. Change requests (row 10) already
give every change a diff, a migration preview, a review and a merge through `SchemaWriter`.
An agent's change goes through the same gate as a person's.

### 9.1 What the user sees

1. The developer asks their agent for a feature. The agent sees it needs an `invoice_lines`
   table, calls `propose_change`, and answers: "I proposed _Add invoice lines_ for review:
   <link>."
2. The link opens the normal change request page with an **Agent** badge and the token's
   name ("proposed by Kasra's agent via token _laptop_"). The diff, migration SQL, reviews and
   merge work as they do today.
3. Someone with `schema:edit` approves and merges it, or requests changes or closes it. The
   agent can't do any of that.

### 9.2 The tool

| Tool             | Input                                               | Route (scope)                                          | Returns                                                                    |
| ---------------- | --------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `propose_change` | `title`, `description?`, `sql` (the change, as DDL) | `POST /projects/:id/agent/proposals` (`propose`) — new | `{ changeRequestId, url, created, skipped }`, or a refusal with the reason |

- **The change is DDL in the project's engine** (`CREATE TABLE …`, `CREATE INDEX …`,
  `ALTER TABLE … ADD CONSTRAINT …`). Agents write DDL well, and the SQL importer already reads
  it, validates it and reports every statement. No new operation format.
- **It merges additively, as the SQL import does** (existing objects win, nothing is deleted).
  So in this row an agent can add tables, columns, indexes and keys, but not rename, change
  or drop anything (Q10).
- **The tool's description tells the agent** to call `list_objects` and `describe_objects`
  first and reuse existing tables, so it doesn't propose duplicates.

### 9.3 The route

One new route in `src/ai`, next to §5's routes, so a token gets one narrow write and never
the general change request, import or submit routes.

```
POST /api/projects/:projectId/agent/proposals   { title, description?, sql }
```

It goes through these steps in order:

1. §5 steps 1–2: the redacted view, then `ai:use` and the AI switch (403 `forbidden` /
   `ai_disabled`).
2. **The change request rules** (row 10 §3): a complete view of the project and
   `comment:create`. Otherwise 403 `forbidden`, as the canvas's **Propose a change** would be.
3. **Limits:** `sql` at most 100 KB, and at most **5 open agent proposals per token**
   (409 `too_many_proposals`), so a looping agent can't flood the review queue.
4. **Preview first**, with the existing import preview against the main project. Nothing is
   created when:
   - a statement fails (422, with the report rows), or
   - nothing would change (422 `nothing_to_propose`).
5. **Name collisions with hidden objects.** A `CREATE` whose name exists but isn't in the
   agent's view (§5 step 3) gets the same `skipped` message as a visible collision: "already
   exists". It never says "hidden", and the hidden object's shape is never returned.
6. **Create, import, submit**, through the existing `ChangeRequestsService`: fork the draft,
   import the SQL into the draft (through `SchemaWriter`, as every draft write is), and submit
   it with the title and description. If any step fails, the draft is deleted, so a failed
   proposal leaves nothing behind.
7. The change request is **authored by the token's user** and stores `viaTokenId` (§9.4).
   The usual `change_request.created` audit row carries the token id.

No AI provider is involved, as in §5.

### 9.4 Data and permissions

- **Scope:** `API_TOKEN_SCOPES` adds `propose`, separate from `agent`, so a read-only agent
  token stays read-only. Creating one needs everything `agent` needs, plus a complete view
  and `comment:create`. Every call checks all of them again.
- **`ChangeRequest.viaTokenId`** (nullable, `onDelete: SetNull`): one migration. The badge
  reads it, and so does the per-token cap. Revoking the token leaves its proposals open; they
  are ordinary change requests by then.
- **The token's user may approve their own agent's proposal** (Q11). Row 10 §3 stops an
  author approving their own request, which would leave a solo developer unable to merge
  anything an agent proposed. For a request with `viaTokenId`, that rule is lifted for the
  author only:
  - The review is still a person checking the agent's work, which is what the gate is for.
  - **It grants no new power.** Approving needs `schema:edit` on the project, and anyone with
    `schema:edit` can already make the same change on the canvas. An author without it still
    needs an editor to approve.
  - The page labels it "Approved by the author", so a team can see it. The merge check
    (row 10 §3) is unchanged.
  - Where it lives: the three author checks in `ChangeRequestsService` (`canReview`, the
    `change_request_own_review` refusal, and the approval count in the merge check) skip
    the author when `viaTokenId` is set.
- **Never through a token:** review, merge, update from main, close, edit the draft, or write
  to the main project. §3's "tokens never reach a route that writes" becomes "tokens reach one
  write route, and it only creates a change request".

### 9.5 Build order

1. `propose` in `API_TOKEN_SCOPES`, its creation rule, the allowlist entry, and the
   `viaTokenId` migration.
2. `POST agent/proposals` with a routes spec. Unit tests:
   - no `propose` scope, or the AI switch off, is refused;
   - a failing statement creates nothing;
   - an empty change returns `nothing_to_propose`;
   - a hidden-name collision reads exactly like a visible one;
   - the sixth open proposal is refused;
   - a failure after the fork deletes the draft;
   - the main project is unchanged until a person merges.
3. `propose_change` in `schemaloom mcp`, listed only when the token has `propose`.
4. Web: the scope checkbox, and the Agent badge on the change request list and page.
5. `docs/mcp.md`, and e2e: an agent proposes a table over stdio, the token's own user
   approves and merges it, and the table appears on the canvas. A unit test checks that a
   person's own (non-agent) request still can't be self-approved.

## 10. Open questions

| #   | Question                                                                  | Default                                                                                                                                                             |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | What may an agent see: the user's view, or the built-in assistant's view? | **The assistant's view** (`ai:use` plus the kill switch). An agent sends schema to an AI provider just as the assistant does, so the same switch must stop it       |
| Q2  | Remote MCP over HTTP (claude.ai connectors, no local install)?            | **Later row.** It needs OAuth 2.1 and dynamic client registration. Stdio covers Claude Code, Cursor and Claude Desktop today                                        |
| Q3  | MCP SDK or hand-written JSON-RPC?                                         | **The SDK, bundled by tsup.** The protocol changes version often; the SDK tracks it. The installed CLI still has no runtime dependencies                            |
| Q4  | Write tools (an agent proposes a schema change as a change request)?      | **Not in v1.** Read-only first. §9 (21b) adds `propose_change` through row 10's change requests, never a direct write                                               |
| Q5  | An audit row for every tool call?                                         | **No.** `lastUsedAt` and revoke cover it. If customers ask, add one `agent.context_read` row per call naming the token, not the content                             |
| Q6  | One token for several projects?                                           | **No**, as Phase 11 Q1. An agent working across two projects registers two servers (`schemaloom-billing`, `schemaloom-core`)                                        |
| Q7  | Export tools (`get_prisma_models`, DDL)?                                  | **No.** Exports aren't cut by `ai:use`, so they would break Q1. `describe_objects` gives the agent what it needs; `schemaloom pull` exists for files                |
| Q8  | Expose docs pages and comments as MCP resources?                          | **No.** Docs ride in `describe_objects` when the project allows it. Comments are conversation, not schema                                                           |
| Q9  | Build 21b with v1, or after it?                                           | **After.** Ship read-only, see how agents use it, then add proposals. Nothing in v1 has to change for 21b                                                           |
| Q10 | Should proposals be able to rename, change or drop?                       | **Not in 21b.** The import is additive (CLAUDE.md: changing that is a product decision). A later row could take ops instead of DDL                                  |
| Q11 | Let the developer approve their own agent's proposal?                     | **Yes** (§9.4). It needs `schema:edit`, which already allows the change directly, so a solo developer isn't stuck. Requests by people keep the second-reviewer rule |
