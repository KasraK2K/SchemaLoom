# SchemaLoom in CI

The `schemaloom` CLI (`packages/cli`) lets a pipeline pull the design into the repository
and fail the build when the database no longer matches the design. The design is in
`docs/phase11/DESIGN.md`.

## 1. Create a token

In the project, open **Settings → API tokens**:

- Give the token a name, such as `GitHub Actions`.
- Tick **Can also check drift** if the job runs `diff`. This needs edit access to the project.
- Choose an expiry. The longest is a year.
- **AI agents (MCP)** is for a developer's own AI agent, not for CI. See
  [`docs/mcp.md`](mcp.md).

The token is shown once. Store it as a CI secret named `SCHEMALOOM_TOKEN`.

A token acts as the person who created it, on that one project. It loses access when they
do, so create CI tokens from an account the team owns, not a person's.

`diff` checks the project's **saved connection** (set it up once in the app, under
**Sync** or **Compare now**). A token can't send other connection details.

## 2. Install the CLI

Until `@schemaloom/cli` is published to npm, build it from this repository:

```bash
pnpm install --frozen-lockfile
pnpm --filter @schemaloom/cli build
node packages/cli/dist/index.js --help
```

It needs Node 22 and has no runtime dependencies, so `packages/cli/dist/index.js` can also
be copied on its own.

## 3. Commands

```bash
export SCHEMALOOM_URL=https://schemaloom.example.com
export SCHEMALOOM_TOKEN=slt_...

schemaloom whoami
schemaloom pull --format ddl --out schema.sql
schemaloom pull --format prisma --out prisma/schema.prisma
schemaloom diff --fail-on-drift --sql drift.sql
```

| Exit code | Meaning                                                            |
| --------- | ------------------------------------------------------------------ |
| 0         | Success, or the database matches the design                        |
| 1         | Drift found, with `--fail-on-drift`                                |
| 2         | Usage or configuration error                                       |
| 3         | The server refused or failed: expired token, no access, rate limit |

`diff --json` prints the whole response, including `diff.counts`, so a script can apply its
own rules, such as failing only on removed objects.

## 4. GitHub Actions

```yaml
name: schema-drift
on:
  schedule: [{ cron: '0 6 * * 1-5' }]
  workflow_dispatch:

jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { repository: your-org/schemaloom, path: schemaloom }
      - uses: pnpm/action-setup@v4
        with: { package_json_file: schemaloom/package.json }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: pnpm install --frozen-lockfile && pnpm --filter @schemaloom/cli build
        working-directory: schemaloom
      - run: node schemaloom/packages/cli/dist/index.js diff --fail-on-drift --sql drift.sql
        env:
          SCHEMALOOM_URL: https://schemaloom.example.com
          SCHEMALOOM_TOKEN: ${{ secrets.SCHEMALOOM_TOKEN }}
      - if: failure()
        uses: actions/upload-artifact@v4
        with: { name: drift-sql, path: drift.sql, if-no-files-found: ignore }
```

## 5. GitLab CI

```yaml
schema-drift:
  image: node:22
  variables:
    SCHEMALOOM_URL: https://schemaloom.example.com
    # SCHEMALOOM_TOKEN: set as a masked CI/CD variable
  before_script:
    - git clone --depth 1 https://gitlab.example.com/your-org/schemaloom.git
    - corepack enable
    - cd schemaloom && pnpm install --frozen-lockfile && pnpm --filter @schemaloom/cli build && cd ..
  script:
    - node schemaloom/packages/cli/dist/index.js diff --fail-on-drift --sql drift.sql
  artifacts:
    when: on_failure
    paths: [drift.sql]
```
