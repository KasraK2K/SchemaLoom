# Phase 14b–14c: directory sync and sign-in from the IdP

Status: **14b built 2026-10-06** (§1, §2, §4, §6; every default approved). 14c (§3) is still
proposed. Builds on SSO (`DESIGN.md` §1); the audit log stream is `AUDIT-STREAMING.md` (row 14d).

**As built (14b)**, where it differs from or adds to the text below:

- Ids are `cuid` text like every other table, not `uuid`. The migration is
  `20261006100000_directory_sync`; a partial unique index keeps one live token per connection.
- `JwtAuthGuard` resolves `@RequireScimToken()` routes to a SCIM principal (`req.scim`) and
  never to a user; a cookie or an `slt_` token on a SCIM route is 401, and an `slscim_` token
  anywhere else is 401. The sweep also refuses the marker outside `/api/scim/` and any other
  marker inside it.
- The connection's groups claim is a column (`groups_claim`); the mappings and the SCIM token
  are managed on the SSO page under each connection ("Directory sync").
- A SCIM `GET /Users/:id` sees members and people this org's SCIM deprovisioned (so Okta can
  reactivate them); anyone else is 404, so a token can't pull arbitrary accounts in by id.
  `DELETE` marks them gone, and a later `GET` is 404.
- SCIM `POST /Users` with `active: false` is refused (400): create, then deactivate.
- Deleting the SSO connection hands its claim groups back to people, and its SCIM groups too
  when no other connection of the org still has a live token. Members and grants stay.
- Name changes are audited as `org_member.updated`; API tokens revoked by deprovisioning as
  `api_token.revoked` (`via: 'scim'`, with the count).
- The PATCH fixtures (`apps/api/src/scim/fixtures/`) are transcribed from Okta's and Microsoft's
  published SCIM request examples, not captured from a live tenant.

Today SSO signs people in, but the company directory (Okta, Microsoft Entra, Google,
Keycloak) can't tell SchemaLoom who joined, who left, or who is in which team. When someone
leaves, their account keeps access until an admin removes them by hand.

## 0. The decisions

| #   | Question                         | Decision                                                                                                                                                                  |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Provisioning protocol            | **SCIM 2.0** (RFC 7643/7644), Users and Groups. What Okta and Entra speak.                                                                                                |
| D2  | What "deprovision" does          | **Removes the org membership and cuts access at once.** The account itself is never deleted; it may belong to other orgs.                                                 |
| D3  | Org roles from the IdP           | **No.** SCIM members join with the connection's `defaultOrgRole` (`member` or `guest`). Owners and admins stay manual.                                                    |
| D4  | Groups                           | **SCIM Groups become SchemaLoom groups**, marked "managed by the IdP". For IdPs without SCIM, **a groups claim** at sign-in can fill mapped groups. One source per group. |
| D5  | Sign-in from the IdP's dashboard | **Bounced, never trusted.** An unrequested SAML response starts a normal SP-initiated sign-in; the IdP answers it at once because the user is already signed in there.    |

## 1. SCIM

### 1.1 Setup (owner)

Settings → SSO → a connection → **Directory sync**: **Generate SCIM token** shows the base URL
(`https://<host>/api/scim/v2`) and the token once. Revoke and regenerate are on the same
screen. There is one active token per connection.

```prisma
model ScimToken {
  id              String    @id @default(uuid()) @db.Uuid
  ssoConnectionId String    @map("sso_connection_id") @db.Uuid   // org comes from the connection
  tokenHash       String    @unique @map("token_hash")            // sha256, as ApiToken
  prefix          String                                          // "slscim_ab12cd34"
  createdById     String?   @map("created_by_id") @db.Uuid
  lastUsedAt      DateTime? @map("last_used_at") @db.Timestamptz(6)
  revokedAt       DateTime? @map("revoked_at") @db.Timestamptz(6)
  createdAt       DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
}
```

Plus `scimExternalId String?` on `OrgMember` and on `UserGroup`, and `managedBy String?` on
`UserGroup` (`scim` | `claim`).

### 1.2 Routes

All under `/api/scim/v2`, authenticated by `Authorization: Bearer slscim_…` and a new marker,
**`@RequireScimToken()`**. The boot sweep and `route-markers.ts` learn it; the token's
connection fixes the org, so no route takes an org id. Errors use the SCIM error shape.

| Route                                                   | Does                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET ServiceProviderConfig`, `ResourceTypes`, `Schemas` | Static discovery documents.                                                                                                          |
| `GET/POST /Users`, `GET/PUT/PATCH/DELETE /Users/:id`    | Org members (`:id` is the SchemaLoom user id). `filter=userName eq "…"` is supported, because Okta and Entra look users up that way. |
| `GET/POST /Groups`, `GET/PUT/PATCH/DELETE /Groups/:id`  | Groups with `managedBy: 'scim'`.                                                                                                     |

Per-token rate limit, failing closed like API tokens. Every write is audited with
`actorUserId: null` and `metadata.via: 'scim'`.

### 1.3 Users

- **Create** (`userName` = email): if no account has the email, create one (email verified,
  no password) through `SignupPolicy.createUser` with proof `{ scimOrgId }`, then the
  `OrgMember`. If an account exists, add only the membership. **SCIM never links an SSO
  identity**; linking keeps rule 1.2.2, which lets a SCIM-created user (in this org only) link
  on their first SSO sign-in.
- **`active: false`, or `DELETE`:** `MembersService.remove` (groups dropped, grants inert,
  `permGeneration` bumped), then revoke this user's API tokens on the org's projects. If the
  user is in no other org, also `revokeAllForUser` (every session ends). Otherwise sessions
  stay, because they also serve the other orgs; access to this org is already gone, since the
  resolver re-reads membership.
- **`active: true` again:** re-add the membership with `defaultOrgRole`. Old grants come back
  to life, as they do for any re-added member (R12.2).
- **Owners are protected:** deprovisioning an org owner answers 409 with "remove the owner role
  in SchemaLoom first". It's the same break-glass rule as SSO enforcement (§1.3).
- **Name changes** update `User.name`. **Email changes** are refused (409): an email change is
  an account change, and the IdP isn't the only owner of the account.

### 1.4 Groups

- **Create** makes a `UserGroup` with `managedBy: 'scim'`. **Members** go through
  `GroupsService.addMember`/`removeMember`, so `permGeneration` and the audit rows work as now.
  A member who isn't in the org yet is skipped.
- **In SchemaLoom a managed group is read-only**: no renaming, no member edits, and a badge
  saying "Managed by your identity provider". It can still be **granted access** to projects
  and workspaces, which is the point.
- **`DELETE` from the IdP** empties the group and turns it into a normal group. It isn't
  deleted, because its grants would go with it: unassigning a group in Okta shouldn't
  silently wipe a project's sharing.

## 2. Groups from a sign-in claim (IdPs without SCIM)

- The connection gets **Groups claim** (e.g. `groups`, empty = off) and a mapping table:

```prisma
model SsoGroupMapping {
  id              String @id @default(uuid()) @db.Uuid
  ssoConnectionId String @map("sso_connection_id") @db.Uuid
  claimValue      String @map("claim_value")          // "data-team"
  groupId         String @map("group_id") @db.Uuid     // a UserGroup, managedBy 'claim'
  @@unique([ssoConnectionId, claimValue])
}
```

- **On every SSO sign-in**, for mapped groups only: add the user when their claim lists the
  value, and remove them when it doesn't. Groups that aren't mapped are never touched. Changes
  go through `GroupsService` and are audited `via: 'sso'`.
- A group can't be mapped to both a claim and SCIM (D4). Mapped groups are read-only like SCIM
  ones.
- Membership is only as fresh as the user's last sign-in. That's the known ceiling; SCIM is
  the real-time answer.

## 3. Sign-in from the IdP's dashboard (14c)

- **Settings show an "App tile URL"**: the existing SP-initiated start route for the
  connection. Okta's "bookmark app" and Entra's "Sign-on URL" take it, and nothing else is
  needed.
- **For IdPs that post straight to the ACS anyway:** a SAML response with no matching
  `sl_sso` cookie or `InResponseTo` is **not processed**. The ACS answers with a redirect to
  the same start route (`?bounce=1`), so a normal sign-in runs; the IdP returns at once
  because the user is signed in there. A second unrequested response with `bounce=1` gets the
  existing error page, so it can't loop.
- **No unrequested assertion is ever trusted**, so `InResponseTo`, single use and RelayState
  keep working exactly as in `DESIGN.md` §1.

## 4. Tests

- Unit: SCIM filter parsing (`userName eq`), PATCH op handling (Okta's and Entra's shapes, both
  recorded as fixtures), the owner refusal, and the claim sync (add, remove, unmapped groups
  untouched).
- Api integration: deprovisioning removes membership, bumps `permGeneration`, revokes API
  tokens, and ends sessions only for a single-org user. A revoked SCIM token answers 401.
  Deleting a managed group keeps its grants.
- Routes spec for the SCIM controller; the boot sweep accepts `@RequireScimToken`.
- E2E (workflow 18, Keycloak): a groups claim fills a mapped group at sign-in. An unrequested
  SAML response bounces into a successful sign-in. SCIM is covered by a scripted client in the
  test, since Keycloak has no SCIM client.

## 5. Out of scope

- Org roles from the IdP (D3), and custom SCIM schema extensions.
- SCIM for orgs without an SSO connection.
- Bulk (`/Bulk`) and `/Me` endpoints. Okta and Entra don't need them.
- DNS TXT domain verification (still `DESIGN.md` §4).

## 6. Open questions (defaults are the recommendation)

| #   | Question                                   | Default                                                                                                 |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Q1  | New route marker or `@Public` with a guard | **New marker** `@RequireScimToken`. `@Public` would describe these routes wrongly in every routes spec. |
| Q2  | Who manages SCIM tokens                    | **Owners**, like SSO connections (`DESIGN.md` Q2).                                                      |
| Q3  | Deprovisioning an owner                    | **Refuse** (409).                                                                                       |
| Q4  | IdP deletes a group                        | **Keep it as a normal empty group**, so its grants survive.                                             |
| Q5  | Sessions of a multi-org user               | **Keep them**; membership removal already cuts this org.                                                |
