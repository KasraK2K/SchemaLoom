# Enterprise: SSO (OIDC and SAML) and the audit log viewer (roadmap 14)

Status: **built** 2026-10-04 (approved the same day with every default in §5). Unparked at
the owner's request.

**As built**, where it differs from the text below:

- **Linking is stricter than Q3.** An existing user is linked to an SSO identity only when
  _every_ org they belong to is the connection's org. A member who also belongs to another org
  is refused (`link_refused`): otherwise an owner could point an IdP at a member's address and
  walk into that member's other organisations. Single-org installs are unaffected.
- **JIT members join as `member` or `guest`**, never admin or owner (a DB CHECK holds it).
- **SAML takes the IdP's sign-in URL and signing certificate**, not pasted metadata XML. Our
  SP metadata is served at the entity ID URL (`/api/auth/sso/:id/saml/metadata`).
- The OIDC issuer must be `https`, except on an install with `INTROSPECT_ALLOW_PRIVATE_HOSTS`
  (dev, e2e), where a local `http` IdP works. Every IdP request passes the private-address guard.
- The flow state lives in a signed `sl_sso` cookie (`SameSite=None; Secure`, path
  `/api/auth/sso`, 10 minutes); SAML's RelayState must match it, and `InResponseTo` is checked
  once through Redis. The ACS is CSRF-exempt for that reason (`csrf.middleware.ts`).
- Google and GitHub callbacks refused by enforcement land on `/login?sso_error=sso_required`.
- **Known ceiling:** an owner can list any domain, so on an install shared by unrelated
  companies a JIT connection could pre-create accounts for addresses of a domain it doesn't
  own (the real owner of the address can still reset its password). Domain verification
  (DNS TXT) stays out of scope (§4); an operator who needs it should keep JIT off.
- Enforcement is covered by unit tests; workflow 18 drives OIDC and SAML end to end against
  Keycloak (`docker compose --profile sso up -d keycloak`), the audit page, and the SSO page.

## Problem

Companies that buy a schema tool want two things before they roll it out:

1. **Sign-in through their identity provider** (Okta, Entra ID, Google Workspace, Keycloak,
   JumpCloud), so joining and leaving the company is joining and leaving SchemaLoom.
2. **An audit trail they can read.** `audit_log` has been written since Phase 1 (grants,
   share links, API tokens, 2FA, protection, engine upgrades, retention sweeps), but nothing
   shows it. Today it's a table only an operator with `psql` can see.

## What changes

### 1. SSO connections (one org, one or more connections)

A new table, `sso_connections`, owned by an organisation:

| Column                                                 | Meaning                                                  |
| ------------------------------------------------------ | -------------------------------------------------------- |
| `protocol`                                             | `oidc` or `saml`                                         |
| `name`                                                 | shown on the sign-in button ("Acme Okta")                |
| `domains` (text[])                                     | email domains this connection signs in (`acme.com`)      |
| OIDC: `issuer`, `client_id`, `client_secret_enc`       | discovery from `issuer/.well-known/openid-configuration` |
| SAML: `idp_metadata_xml` or `idp_sso_url` + `idp_cert` | the IdP's metadata, pasted or uploaded                   |
| `jit`                                                  | create an account and an org membership on first sign-in |
| `default_org_role`                                     | the org role a JIT member gets (`member`; never `owner`) |
| `enforced`                                             | members with these domains must use SSO (§1.3)           |

The secret is encrypted with `SECRETS_ENCRYPTION_KEY`, the same AES-256-GCM helper
`totp.ts` uses for TOTP secrets. Managed under **Settings → Single sign-on**, by org owners
only (`@RequireOrgRole('owner')`), because a connection decides who can become a member.
The page shows the values to paste into the IdP: the OIDC redirect URI, or the SAML ACS
URL and entity ID, plus our SP metadata XML.

Libraries (new dependencies, both widely used and maintained): **`openid-client`** for OIDC
(certified, does discovery, PKCE, nonce and ID-token checks) and **`@node-saml/node-saml`**
for SAML (signature, audience, `NotOnOrAfter`, `InResponseTo` checks). Nothing hand-rolled.

### 1.1 Signing in

- The sign-in page gets **Continue with SSO**: type a work email → `POST /auth/sso/discover`
  → the connection whose `domains` holds that domain → redirect. The answer for an unknown
  domain is the same "no SSO for this address" as for a known one without SSO, so discovery
  is not an oracle for which companies use SchemaLoom beyond what the button would say anyway.
- `GET /auth/sso/:connectionId/start` → IdP. State, nonce and PKCE verifier (OIDC) or the
  request id (SAML) live in a short-lived signed cookie, like the OAuth flows.
- Callbacks: `GET /auth/sso/oidc/callback`, `POST /auth/sso/saml/acs` (form post from the
  IdP; CSRF-exempt like the OAuth callbacks, protected by the signed-state check instead).
  All routes are `@Public()`, listed in `auth.routes.spec.ts`.
- Success ends in `issueSession`, the one login gate, so everything after (org choice,
  cookies) is unchanged.

### 1.2 Which account an SSO identity becomes (the security-relevant part)

The IdP is trusted only **for its own organisation**. An org owner can type any domain, and
on a shared install another org's owner could point a connection at an IdP that asserts
anyone's address. So:

1. A known identity (`accounts` row with provider `sso:<connectionId>` and the subject /
   NameID) signs in as that user.
2. Otherwise, an existing user with that email is linked **only if they are already a member
   of the connection's org**. Anyone else gets "Sign in the usual way, then ask an owner to
   invite you"; the address in another org is never taken over.
3. Otherwise, if `jit` is on and the email's domain is in `domains`, a new user is created
   (email verified, the IdP proved it) and joins the org with `default_org_role`. This goes
   through `SignupPolicy.createUser` with a new proof, `{ ssoOrgId }`, which invite-only
   mode accepts: the org's own IdP vouching for the person is an invitation.
4. Otherwise: refused, audited as `auth.sso_refused` with the reason.

The email must be asserted as verified (OIDC `email_verified`; SAML: we trust the IdP's
NameID/email attribute, because the connection is that org's own IdP and rule 2 limits the
blast radius to that org).

### 1.3 Enforcement

With `enforced` on, a user whose email domain is in that connection's `domains` and who is a
member of its org cannot sign in by password, magic link, Google or GitHub; the sign-in page
sends them to SSO. **Org owners are exempt**, so a broken IdP can't lock everyone out. API
tokens (CLI/CI) keep working; they're revoked through the normal page.

SSO sign-in **skips SchemaLoom's own TOTP challenge** (the IdP owns MFA). A user with 2FA
who signs in by password still gets the challenge as today.

Leaving the company: when the IdP stops letting someone in, they can't start new sessions.
Existing sessions live until their refresh token expires (as for a password change today).
SCIM deprovisioning is out of scope (§4).

### 2. Audit log viewer

`GET /orgs/:orgId/audit-log` with filters `action` (prefix, e.g. `grant.`), `actor`
(user id or email), `projectId`, `from`, `to`, and keyset pagination (`before=<createdAt,id>`,
50 a page) on the existing `(organization_id, created_at desc)` index.

- **Who:** owners and admins (`@RequireOrgRole('owner', 'admin')`). R13 holds: an admin
  sees org-level rows (`project_id` null) and rows of projects they can see; rows of other
  projects are left out, not masked, so the page is no existence oracle.
- **What a row shows:** time, actor (name, or the preserved email if the user is gone),
  action in plain words ("changed a grant"), the target (project / resource name when still
  visible, else its id), IP, and the metadata JSON in a fold.
- `GET /orgs/:orgId/audit-log.csv` with the same filters streams a CSV (capped at 100,000
  rows, said in the file's last line when hit). Same marker and filtering.
- **Web:** Settings → **Audit log**: a filter bar (action group, person, project, date range)
  and a table with "Load more". It reuses the members page's table styles.

New audit events, so the log answers the questions people actually ask:
`auth.login` (method: password, magic_link, google, github, sso), `auth.sso_refused`,
`sso_connection.created|updated|deleted`, and `org_member.added|removed` if not already
written. Login rows have no org until one is chosen; they're written with the org the
session opens in.

## 3. Tests

- **api unit:** account resolution (rules 1–4, including "an existing user in another org is
  never linked" and "JIT never makes an owner"), enforcement (owner exempt, API tokens
  unaffected), SSO skips TOTP, audit filters and R13 for admins, CSV cap.
- **api routes specs:** every new route has its one marker.
- **e2e (workflow 18):** OIDC end to end against a **Keycloak container** started by the
  e2e compose profile (`--profile sso`); the test skips without it, like MariaDB. SAML is
  checked against the same Keycloak realm (it speaks both). The audit page is driven in the
  browser as the owner and as an admin who can't see one project.

## 4. Out of scope

- SCIM provisioning and deprovisioning (a later row if a customer asks).
- Group/role mapping from IdP claims into SchemaLoom groups.
- Domain verification by DNS TXT record (rule 1.2.2 makes it unnecessary for safety).
- IdP-initiated SAML sign-in (only SP-initiated; IdP-initiated has no `InResponseTo` to check).
- Streaming the audit log to a SIEM.

## 5. Open questions

| #   | Question                                 | Default                                                                                |
| --- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| Q1  | Build OIDC and SAML, or OIDC only?       | **Both.** OIDC first in the build order; SAML on the same tables and screens.          |
| Q2  | Who manages SSO connections?             | **Org owners only.** A connection decides who may join.                                |
| Q3  | Link an existing user by email?          | **Only if already a member of the connection's org** (§1.2).                           |
| Q4  | JIT accounts under `SIGNUP_MODE=invite`? | **Yes, when the connection has `jit` on.** The org's own IdP counts as the invitation. |
| Q5  | Does SSO skip SchemaLoom's TOTP?         | **Yes.** The IdP owns MFA.                                                             |
| Q6  | Enforcement exemptions                   | **Org owners**, as the break-glass path. API tokens unaffected.                        |
| Q7  | Who reads the audit log?                 | **Owners and admins**; admins don't see rows of projects they can't see (R13).         |
| Q8  | CSV export                               | **Yes**, same filters, 100,000-row cap.                                                |
| Q9  | New dependencies                         | **`openid-client`, `@node-saml/node-saml`** (api only). No new web dependency.         |
| Q10 | e2e IdP                                  | **Keycloak container** behind a compose profile; the SSO test skips without it.        |

## 6. Build order

1. Audit viewer (api, web, new login/membership events). Useful on its own.
2. `sso_connections` + settings page + OIDC sign-in, account resolution, enforcement.
3. SAML on the same tables.
4. Workflow 18 with Keycloak.
