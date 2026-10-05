# Phase 14d: streaming the audit log to a SIEM

Status: **proposed 2026-10-05**. Roadmap row 14d. Builds on the audit log (`DESIGN.md` §2).

A security team wants SchemaLoom's audit events in their own tool (Splunk, Datadog, Elastic,
Sumo Logic, or a log pipeline), next to everything else they watch, as they happen. Today
they can only read the viewer or download a CSV.

## 0. The decisions

| #   | Question            | Decision                                                                                                                                      |
| --- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Transport           | **HTTPS POST of JSON batches.** Every SIEM listed takes it. No syslog, no agents.                                                             |
| D2  | How events reach it | **A poller reads `audit_log` after a cursor.** There is no central audit writer (16 call sites), and a poller needs no change to any of them. |
| D3  | Delivery            | **At least once, in order, per destination.** Every event carries its stable id, so the SIEM can drop repeats.                                |
| D4  | Who sets it up      | **Org owners**, and the stream carries **every** org row, the same rows an owner sees in the viewer.                                          |
| D5  | Formats             | **`json`** (one generic shape), **`splunk_hec`** and **`datadog`** (their envelopes). Anything else takes `json`.                             |

## 1. What the owner sees

Settings → Audit log → **Stream to a SIEM**:

- **Endpoint URL** (https), **Format**, an optional **auth header** (name and value, e.g.
  `Authorization: Splunk <token>` or `DD-API-KEY: …`), and **Send test event**.
- A **signing secret** is shown once. Every request carries
  `X-SchemaLoom-Signature: sha256=<hmac of the body>` and `X-SchemaLoom-Timestamp`, so a
  receiver can check that a batch really came from this install.
- **Status:** "Delivering, last batch 12 s ago", "Retrying since 10:42: 503 from the
  endpoint", or "Paused". **Pause** and **Resume** keep the cursor; **Delete** forgets it.
- When delivery starts failing, owners get one notification and email, and one more when it
  recovers. That's the scheduled-drift pattern (`docs/phase6/SCHEDULED-DRIFT.md` D4).

## 2. Data

```prisma
model AuditStream {
  id              String    @id @default(uuid()) @db.Uuid
  organizationId  String    @unique @map("organization_id") @db.Uuid  // one per org (Q1)
  url             String
  format          String    // json | splunk_hec | datadog
  authHeaderName  String?   @map("auth_header_name")
  authHeaderEnc   String?   @map("auth_header_enc")      // encryptSecret, as SSO secrets
  signingSecretEnc String   @map("signing_secret_enc")
  cursorAt        DateTime  @map("cursor_at") @db.Timestamptz(6)  // starts at "now" on create
  cursorId        String?   @map("cursor_id")               // audit_log ids are cuids
  paused          Boolean   @default(false)
  status          String    @default("ok")               // ok | failing
  lastError       String?   @map("last_error")
  lastDeliveredAt DateTime? @map("last_delivered_at") @db.Timestamptz(6)
  failingSince    DateTime? @map("failing_since") @db.Timestamptz(6)
}
```

The stream starts at the moment it's created. History before that is in the CSV export (Q2).

## 3. The job

- **Its own `audit-stream` queue and worker**, scheduled every 30 s with `upsertJobScheduler`.
  The maintenance queue's worker treats every job as the retention sweep (the 6d lesson).
- **Each run:** for every unpaused stream that's due, read up to 500 rows with
  `(createdAt, id) > cursor` and `createdAt < now − 2 min`, oldest first, then POST them as one
  batch. On a 2xx, advance the cursor to the last row; anything else leaves it.
  - _ponytail:_ the 2-minute lag covers transactions that commit after a later row's
    timestamp. A transaction open longer than that would be skipped; a commit-ordered sequence
    column is the upgrade if that ever shows up.
- **Failure:** retry with backoff (30 s, doubling, at most 1 h), with no cap on attempts.
  Retention still sweeps rows at 24 months, so a stream failing for that long loses them, and
  the status says so.
- **Egress:** every POST goes through `resolveCheckedAddress` (`introspect/address-guard`).
  Private addresses are refused unless `AUDIT_STREAM_ALLOW_PRIVATE_HOSTS=true`, because a
  self-hosted install's Splunk is usually on the internal network (Q3). Timeout 10 s, no
  redirects.
- **Payload (`json`):** `{ "events": [ { id, time, action, actor: { id, email }, organization:
{ id, name }, projectId, resource: { type, id }, ip, userAgent, metadata } ] }`. The other formats wrap the
  same event, one HEC event per row for Splunk and the logs-API array for Datadog.

## 4. API and web

| Route                                            | Marker / check                     | Does                                                              |
| ------------------------------------------------ | ---------------------------------- | ----------------------------------------------------------------- |
| `GET /organizations/:orgSlug/audit-stream`       | `@Authenticated`, owner in service | Settings and status, no secrets.                                  |
| `PUT /organizations/:orgSlug/audit-stream`       | same                               | Create or update; the first save returns the signing secret once. |
| `POST /organizations/:orgSlug/audit-stream/test` | same                               | One synthetic event, its result.                                  |
| `DELETE /organizations/:orgSlug/audit-stream`    | same                               | Forget it.                                                        |

These match the other org routes (role checked in the service, since they're addressed by
slug). Changes are audited (`audit_stream.created|updated|deleted|paused|resumed`), so the
stream itself shows who changed it.

Web: a section on the existing audit-log settings page.

## 5. Tests

- Unit: batch selection (cursor, lag window, 500 cap, ordering ties on `id`), the three
  envelopes, HMAC signature, backoff schedule, the failing/recovered state machine.
- Api integration: a fake receiver gets every row exactly in order; a 500 response leaves the
  cursor and the next run resends the same ids; a private URL is refused without the flag.
- Routes spec for the new routes; a non-owner admin gets 404 on all four.

## 6. Open questions (defaults are the recommendation)

| #   | Question                     | Default                                                                 |
| --- | ---------------------------- | ----------------------------------------------------------------------- |
| Q1  | More than one stream per org | **One.** Most teams send to one pipeline that fans out.                 |
| Q2  | Backfill history on create   | **No**; the CSV covers the past. A "start from" date is a later option. |
| Q3  | Private hosts                | **Off by default**, opt in with `AUDIT_STREAM_ALLOW_PRIVATE_HOSTS`.     |
| Q4  | Admins configure it          | **No, owners only** (D4): the stream carries rows admins can't see.     |
