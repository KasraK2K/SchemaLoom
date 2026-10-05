# SchemaLoom for AI agents (MCP)

`schemaloom mcp` lets your own AI agent (Claude Code, Cursor, Claude Desktop or any MCP
client) read a project's design while it writes code: which tables exist, their columns and
keys, how they join, and whether a query matches the design. With the **propose** scope it
can also propose schema changes, as change requests a person reviews.

Your agent's own model does the thinking. SchemaLoom never calls an AI provider for this, so
the server needs no AI key, and nothing counts against the built-in assistant's limits. The
design is in `docs/phase21/DESIGN.md`.

## 1. Create a token

In the project, open **Settings → API tokens**:

- Give the token a name, such as `laptop`.
- Tick **AI agents (MCP)**. This needs the project's AI switch on and AI access to the
  project.
- To let the agent propose changes, also tick **…and propose schema changes**. This also
  needs access to every table and column in the project, and permission to comment, as
  **Propose a change** on the canvas does.

The token is shown once, with a setup command filled in. Until `@schemaloom/cli` is on npm,
build the CLI from this repository (`pnpm --filter @schemaloom/cli build`) and point the
command at `packages/cli/dist/index.js`.

## 2. Add it to your agent

**Claude Code:**

```bash
claude mcp add schemaloom -e SCHEMALOOM_URL=https://schemaloom.example.com -e SCHEMALOOM_TOKEN=slt_... -- node /path/to/schemaloom/packages/cli/dist/index.js mcp
```

**Cursor, Claude Desktop and other clients with a config file:**

```json
{
  "mcpServers": {
    "schemaloom": {
      "command": "node",
      "args": ["/path/to/schemaloom/packages/cli/dist/index.js", "mcp"],
      "env": {
        "SCHEMALOOM_URL": "https://schemaloom.example.com",
        "SCHEMALOOM_TOKEN": "slt_..."
      }
    }
  }
}
```

One token is for one project. For two projects, add two servers (`schemaloom-billing`,
`schemaloom-core`).

## 3. Tools

| Tool                 | What it does                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `get_project`        | The project's name, engine and version                                                               |
| `list_objects`       | One line per table, view and enum, filtered by kind, area or a name pattern such as `order*`         |
| `describe_objects`   | Columns, types, keys, foreign keys, indexes and docs of named tables, and the tables they point at   |
| `validate_query`     | Whether SQL parses, and which tables and columns don't exist in the design                           |
| `list_saved_queries` | The team's saved queries                                                                             |
| `check_drift`        | Only with the **drift** scope: the saved connection compared with the design                         |
| `propose_change`     | Only with the **propose** scope: DDL that adds tables, columns, indexes or keys, as a change request |

## 4. What an agent sees

An agent sees what the built-in AI assistant would see for the token's user, never more than
that user sees on the canvas:

- Tables you can't see, and tables without AI access, are left out. Asking for one by name
  answers "not found", the same as a table that doesn't exist.
- Restricted columns stay masked.
- Docs are included only when the project includes docs in AI context.
- If someone turns the project's AI switch off, every tool answers `ai_disabled` from the
  next call on. The token keeps working for `schemaloom pull`.
- `validate_query` checks against the token user's view of the design. A table that user can
  see but has no AI access to still resolves there.

## 5. Proposals

`propose_change` never writes to the design. It opens a change request with an **Agent**
badge, authored by the token's user, and a person reviews and merges it as usual:

- It only adds. Existing tables, columns and keys are never renamed, changed or dropped, as
  with the SQL import. A table that already exists is reported as "already exists" and left
  unchanged.
- SQL with a statement that can't be read, or that changes nothing, creates nothing.
- A token can have at most 5 open proposals.
- The token's own user may approve their agent's request (it takes edit access to the
  project, which already allows the same change on the canvas). A person's own request still
  needs a second reviewer.
- Revoking the token leaves its open proposals as ordinary change requests.
