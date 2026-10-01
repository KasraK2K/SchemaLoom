# Phase 11: CLI and CI (API tokens, `schemaloom pull`, `schemaloom diff`)

Status: **proposed 2026-10-01**, waiting for approval. Roadmap row 11.

The goal: a deploy pipeline can ask SchemaLoom "does the database still match the design?"
and fail the build when it doesn't, and a developer can pull the design as DDL or Prisma
into the repo. Both need a way to sign in without a browser, which is the new part.

## 1. What the user sees

1. **Account → API tokens.** **Create token** asks for a name, a project, what it may do
   (**Read** and optionally **Check drift**), and an expiry (default 90 days, at most one
   year). The token is shown once, like a share link URL. The list shows each token's
   project, scopes, last use and expiry, with **Revoke**.
2. **Project settings → API tokens.** People who manage sharing on the project see every
   token on it, whose it is and when it was last used, and can revoke any of them.
3. **The CLI**, configured with two environment variables:

   ```bash
   export SCHEMALOOM_URL=https://schemaloom.example.com
   export SCHEMALOOM_TOKEN=slt_...
   schemaloom pull --format prisma --out prisma/schema.prisma
   schemaloom diff --fail-on-drift
   ```

   `diff` compares the project's **saved connection** (Phase 6c) with the design and prints
   the summary, optionally the migration SQL (`--sql drift.sql`), and with
   `--fail-on-drift` exits 1 when they differ.

4. **`docs/ci.md`** has a copy-paste GitHub Actions job and a GitLab CI job.

## 2. Tokens are personal and scoped to one project

A token **acts as the user who created it, on one project, through a short list of routes**.
That is the decision the rest follows from.

- **What it can see is the user's real access, every time.** The resolver runs as usual for
  that user. If the user loses access to the project, or leaves the org, the token stops
  working with no extra code and no extra state.
- **It can never do more than the user, and usually much less.** The guard allows a token only
  on the routes in `API_TOKEN_ROUTES` (§4), and only on its own project. Any other route or
  project returns 404, exactly as share links do today with `SHARE_LINK_ROUTES`. No route
  that writes schema, sharing or settings is on the list.
- **Why not a project "service account"?** It would be a new kind of principal with its own
  grants, and every route that requires a user (exports, drift) would need to learn about it.
  A personal token reuses all of that. The cost is that a token dies with its owner's access,
  which teams handle by creating CI tokens from a dedicated account (Q2).

## 3. Data and the token itself

```prisma
model ApiToken {
  id          String    @id @default(cuid())
  userId      String                      // the owner; cascade on user delete
  projectId   String                      // cascade on project delete
  name        String
  /// sha256 hex of the secret, like `ShareLink.tokenHash`. The secret is never stored.
  tokenHash   String    @unique
  /// The first 8 characters after `slt_`, shown in lists so people can tell tokens apart.
  prefix      String
  scopes      String[]                    // 'read' | 'drift'
  expiresAt   DateTime
  lastUsedAt  DateTime?
  revokedAt   DateTime?
  createdAt   DateTime  @default(now())
  @@index([projectId])
  @@index([userId])
}
```

- The format is `slt_` followed by 32 random bytes in base64url. The prefix lets secret
  scanners (GitHub's, gitleaks) recognise a leaked token.
- **Creating a token** requires that the user can open the project (`canOpenProject`). The
  `drift` scope also requires `schema:edit` there, the same atom the drift route needs, so a
  token is never created for something it could not do. Writes `api_token.created` to
  `AuditLog`.
- **Revoking** is open to the owner, and to anyone with `sharing:manage` on the project. It
  sets `revokedAt` and writes `api_token.revoked`.
- `lastUsedAt` is updated at most once a minute per token, fire-and-forget, like share links'
  `lastAccessedAt`.

## 4. How a request with a token is handled

1. **`JwtAuthGuard`** reads `Authorization: Bearer slt_...`. When that header is present,
   cookies are ignored, so a browser session can't be mixed with a token.
   - The guard looks up the token by hash. A token that is missing, revoked or expired gets
     401 `invalid_token`, with no hint which.
   - Otherwise the request becomes the owner's user principal, in the project's
     organisation, carrying `{ tokenId, projectId, scopes }`.
2. **Rate limit:** 120 requests a minute per token, with Redis `INCR` the way share-link
   redeem does it. Over the limit is 429 `rate_limited`.
3. **CSRF** doesn't apply: the middleware already skips requests that carry no session
   cookie, and a bearer request carries none.
4. **`PermissionGuard`**, for a token principal:
   - the route must be in `API_TOKEN_ROUTES` with a scope the token has;
   - the project the route resolves to must be the token's project.

   Anything else gets 404. After that the normal marker check runs with the owner's map.
   The boot sweep checks that no `API_TOKEN_ROUTES` entry has a write atom marker.

5. **Realtime:** the socket refuses tokens.

`API_TOKEN_ROUTES`:

| Route                                            | Scope   | Why                                                      |
| ------------------------------------------------ | ------- | -------------------------------------------------------- |
| `GET /api/token`                                 | any     | The CLI learns its project, scopes and expiry (§5)       |
| `GET /api/projects/:projectId`                   | `read`  | Project name and engine for the CLI's output             |
| `GET /api/projects/:projectId/ir`                | `read`  | `pull --format ir` without an export job                 |
| `POST /api/projects/:projectId/exports`          | `read`  | `pull` for DDL, Prisma and the other server formats      |
| `GET /api/exports/:id`                           | `read`  | Poll the export and get its download link                |
| `POST /api/projects/:projectId/introspect/drift` | `drift` | `diff`. With a token only `saved: true` is accepted (Q4) |

`GET /api/token` is new, `@Authenticated()`, and answers 404 to a cookie session. Everything
else is an existing route, unchanged except for the one-line "token means saved connection
only" check in the drift DTO path.

## 5. The CLI

- **Package `packages/cli`** (`@schemaloom/cli`, bin `schemaloom`). It needs Node 22, uses
  the built-in `fetch` and `node:util` `parseArgs`, and has **no runtime dependencies**. It's
  bundled with the tsup preset plus a shebang banner.
- **Configuration** comes from `SCHEMALOOM_URL` and `SCHEMALOOM_TOKEN`, or the flags `--url`
  and `--token`. A token on the command line shows up in shell history, so the help text
  says to prefer the variable. The project comes from the token (`GET /api/token`), so
  there's no project flag to get wrong.
- **Commands:**

  | Command                                                                           | Does                                                                                                                                         |
  | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
  | `schemaloom whoami`                                                               | Token name, project, scopes, expiry                                                                                                          |
  | `schemaloom pull --format <id> [--out <file>]`                                    | Export and download. `ir` reads `/ir`; anything else (`ddl`, `prisma`, `markdown`, …) is an export job. Writes to stdout without `--out`     |
  | `schemaloom diff [--fail-on-drift] [--sql <file>] [--json] [--allow-destructive]` | Drift against the saved connection: a summary table by default, the full response with `--json`, the migration script to a file with `--sql` |

- **Exit codes:**
  - `0` means success, or in sync.
  - `1` means drift found with `--fail-on-drift`.
  - `2` means a usage or configuration error.
  - `3` means the server refused or failed: 401, 403, 404, 429 or 5xx, with its error
    code printed.

  CI scripts can tell "the database moved" from "the token expired".

- **Output names no hidden object.** The server already redacts. The CLI prints only what it
  receives, so this needs nothing new.

## 6. Web

- `features/api-tokens/`: an **API tokens** section on the account page (list, create,
  revoke) and an **API tokens** section in the project settings dialog for managers (list and
  revoke). Both read the same new routes:

  | Route                                      | Marker                                                                         |
  | ------------------------------------------ | ------------------------------------------------------------------------------ |
  | `GET /api/me/api-tokens`                   | `@Authenticated()`, the caller's own tokens                                    |
  | `POST /api/projects/:projectId/api-tokens` | `@RequireProjectAccess('projectId')`; the service checks the scope rules in §3 |
  | `GET /api/projects/:projectId/api-tokens`  | `@RequirePermission('sharing:manage', …)`                                      |
  | `DELETE /api/api-tokens/:id`               | `@Authenticated()`; owner or `sharing:manage` on its project, else 404         |

  None of these is on `API_TOKEN_ROUTES`: a token can't mint or list tokens.

## 7. Build order

1. `ApiToken` model and migration; create, list and revoke routes with routes specs and audit.
2. Guard support: bearer parsing, the rate limit, `API_TOKEN_ROUTES` in `PermissionGuard`,
   `GET /api/token`, the drift "saved only" rule, and the socket refusal.
   - Unit tests for every 404 case: wrong route, wrong project, missing scope, revoked,
     expired, owner lost access.
3. `packages/cli` with `whoami`, `pull` and `diff`, plus unit tests against a stub server
   (`node:http`).
4. Web: the account section and the project-settings section.
5. `docs/ci.md` with GitHub Actions and GitLab CI examples, and a `docs/deploy.md` note.
6. e2e workflow 12:
   - create a token in the browser;
   - `pull --format ddl` through the built CLI;
   - prove that the token can't call a write route, can't reach another project, and stops
     working once revoked.

   The drift part runs where `pg_dump` exists (the Docker recipe), like workflow 10.

## 8. Open questions

| #   | Question                                                                | Default                                                                                                                                          |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Tokens per project, or one token for several projects?                  | **One project.** The smallest blast radius. A pipeline that checks two projects uses two tokens                                                  |
| Q2  | Project service accounts that don't belong to a person?                 | **Later.** Personal tokens reuse every existing check; a team uses a dedicated account until a customer needs more                               |
| Q3  | A write scope (`schemaloom push` / import SQL from CI)?                 | **No** in v1. CI reads and checks; changes go through the app and change requests                                                                |
| Q4  | Drift with credentials sent by the CLI instead of the saved connection? | **No.** Saved connection only, so a token can't be used to make the server connect somewhere new. The saved connection is set up once in the app |
| Q5  | Publish `@schemaloom/cli` to npm?                                       | **Yes, as a release step**, not part of this build. Until then `pnpm --filter @schemaloom/cli build` and run `node dist/index.js`                |
| Q6  | A dedicated GitHub Action?                                              | **No.** A documented job that runs the CLI covers it; an Action is a second thing to version                                                     |
| Q7  | Fail CI only on destructive drift (`--fail-on destructive`)?            | **Later.** `--json` exposes the counts, so a script can decide in the meantime                                                                   |
| Q8  | Token expiry                                                            | **Required**, 90 days by default, one year at most. A token that never expires is the one that leaks                                             |
