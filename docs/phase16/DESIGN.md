# Invite-only sign-up and member invites (roadmap 16)

Status: **built** (approved and built 2026-10-02). Notes on where the build differs from
the proposal are marked _Built:_.

## Problem

Anyone who can reach a SchemaLoom install can create an account, and every account can
create its own organisation. On a self-hosted install that is wrong: the operator wants
one owner, who then decides who gets in. Today the only way to bring someone in is to
share a project with their email, and even that relies on open sign-up for the invitee to
create an account.

## Decisions (agreed 2026-10-02)

1. **An operator setting, default closed.** `SIGNUP_MODE=invite|open` in `.env`, default
   `invite`. A hosted (SaaS) deploy sets `open` and keeps today's behaviour.
2. **The invitee sets their own password.** An owner never types or sees someone else's
   password. "Adding a user manually" is an invite: owner enters email and role, the
   person gets a link, chooses a name and password, and is in.
3. **Org-level invites from Settings → Members**, with a role, next to the existing
   project-share invite.

## What changes

### 1. Who may create an account

One check, `SignupPolicy.createUser(email, proof, create)` (`apps/api/src/auth/signup-policy.ts`),
which every path that creates a `User` row goes through. There are exactly three today, all in `auth.service.ts`:
`register`, the magic-link consume (an address with no account), and `upsertOAuthUser`.

| `SIGNUP_MODE` | No users yet  | Live invite token for this email | Otherwise           |
| ------------- | ------------- | -------------------------------- | ------------------- |
| `open`        | allowed       | allowed                          | allowed             |
| `invite`      | allowed (1st) | allowed                          | 403 `signup_closed` |

- **The first account.** "No users yet" is checked inside the insert's transaction under
  a Postgres advisory lock, so two people racing to be first cannot both win.
- **The token, not just the email.** Registering with an invite needs the token from
  the link, not merely an address that happens to have a pending invite. Otherwise a
  person who learns an invited address could register it first and lock the real
  invitee out (`EMAIL_TAKEN`). Because the token arrived in that inbox, registering with
  it also **marks the email verified**: one step fewer for the invitee.
- **Magic link and Google/GitHub** keep signing in existing accounts in every mode. In
  `invite` mode they create a new account only for an address with a live invitation.
  _Built:_ this goes one step further than proposed. Both already prove the address (the
  link reached the inbox; the provider verified the email), which is the same proof the
  token gives, so an invitee can accept with Google too. Without a live invitation they
  are refused like a password sign-up. A refused OAuth callback answers 403
  `signup_closed` as JSON, as its other refusals already do.
- Existing accounts are untouched. Turning the setting on never locks anyone out.

### 2. Org invites (Settings → Members)

New routes, each in `organizations.routes.spec.ts`. _Built:_ they carry `@Authenticated()`
like every other org route, because `@RequireOrgRole` admits only the session's active org;
`MemberInvitesService` applies the owner/admin rule, as `MembersService` does.

| Route                                                | Does                                   |
| ---------------------------------------------------- | -------------------------------------- |
| `POST   /organizations/:slug/invitations`            | `{ email, role }`; creates and emails  |
| `GET    /organizations/:slug/invitations`            | Pending invites (not accepted/revoked) |
| `POST   /organizations/:slug/invitations/:id/resend` | New token, new 7-day expiry, re-emails |
| `DELETE /organizations/:slug/invitations/:id`        | Revokes                                |

- Reuses the `Invitation` table as is: an org invite is a row with `accessGrantId = null`
  and the chosen `orgRole`. **No migration.**
- Same rules as role changes (`assertMemberChange`): only owners invite owners; admins
  invite admins, members and guests.
- An address that is already a member is 409 `already_member`. An address with an
  account in another org is a normal invite; they accept by signing in.
- Accepting uses the existing `POST /invitations/:token/accept` and `/invite/[token]`
  page unchanged.
- Audited as `org_invitation.created / resent / revoked`.

### 3. Web

- `GET /auth/signup-policy` (`@Public`) → `{ open: boolean }`, where `open` is true when
  the mode is `open` or there are no users yet.
- `/login`: "No account yet? Create one" only when `open`.
- `/signup` without an invite and not `open`: "Sign-up is by invitation. Ask an owner of
  your organisation to invite you." No form.
- `/invite/[token]` → "Create an account" passes the token through
  (`/signup?invite=…`); the sign-up form pre-fills and locks the invited email.
- Settings → Members: an **Invite people** form (email + role) for owners/admins, and a
  pending list with Resend and Revoke. The page text drops "share a project to invite
  someone". The invite page shows the org role ("with the Admin role").
- _Built, alongside:_ nobody changes their own org role (403 `own_role`), and the members
  list locks your own row.

## Rollout and compatibility

- **The default changes behaviour for existing self-hosted installs** that rely on open
  sign-up. `docs/deploy.md`, `docs/self-host-ubuntu.md` and `.env.example` say so, and
  name `SIGNUP_MODE=open` as the way back.
- e2e: the e2e api runs with `SIGNUP_MODE=open`, because workflow 1 signs up strangers
  (and skips those tests against a dev server where sign-up is closed). Workflow 13 runs in
  either mode: org invite, sign-up from the link with the email locked, accept, revoke, and
  the closed `/signup` page when the api reports sign-up closed.
- Seeded databases already have users, so `pnpm db:seed` + `invite` mode means sign-up
  is closed straight away, as intended.

## Out of scope

- Owner-set passwords and accounts without email (rejected in decision 2).
- A per-org "who may create organisations" setting. In `invite` mode every user arrives
  through an invite, which is enough for one-team installs.

## Tests

- `signup-policy.spec.ts`: each mode × first account × valid/wrong token × proven address.
- `member-invites.service.spec.ts`: role rules, `already_member`, a repeat invite updates
  the pending one, resend rotates the token, revoke, unknown ids 404.
- Routes specs for the new routes; e2e workflow 13.
