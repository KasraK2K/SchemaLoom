# SchemaLoom — Prisma schema (application database)

**Status:** design pass. Nothing here is on disk as `prisma/schema.prisma`; this document is
what a human approves before any file is created.

**Target:** PostgreSQL 16, Prisma 6.x. The generator block is **doc 01 §8.2's** (`prisma-client`,
output into `apps/api/src/generated/prisma`, `moduleFormat = "cjs"`); it is restated in §1 so this
document reads on its own, but doc 01 owns it.

**Scope:** the *application* database — the one that stores SchemaLoom's own users, orgs,
projects, and the user-designed schema model. It has nothing to do with the PostgreSQL
databases users are *designing*; those are never connected to in v1.

## Conventions compliance

| Convention | How this schema honours it |
|---|---|
| C1 ids | every model: `String @id @default(cuid())`. No int PKs, no UUIDs. One exception: `SavedQueryEntity`, a pure join table with `@@id([savedQueryId, entityId])` — a surrogate id on a two-column join row buys nothing. |
| C2 naming | `PascalCase` singular models, `@@map("snake_case_plural")`, `camelCase` fields with `@map("snake_case")`. Exceptions below. `activity_log` and `audit_log` keep the singular table names spec §9 gives them. |
| C3 IR derived | the live schema is `namespaces / entities / fields / links / link_endpoints / indexes / index_columns / constraints / constraint_columns / custom_types`. `snapshots.ir` is the only JSON copy and it is frozen. |
| C4 engineProps | `engineProps Json @default("{}")` on all seven IR object kinds plus `index_columns`. Core columns exist only where core must index/sort/filter: `fields.is_restricted`, `fields.type_args` / `type_dimensions`, `fields.position`, `index_columns.direction` / `is_include`, `entities.position_x/y`, `constraints.expression`. Each is named as a core property by doc 04. |
| C5 permissions | Atoms are **strings**, not a database enum: `roles.atoms String[]`, validated on write by the `permissionAtomSchema` zod union in `packages/contracts`. `ResourceType = project\|area\|entity`, `PrincipalType = user\|group\|email_invite\|share_link`, `OrgRole = owner\|admin\|member\|guest`. |
| C6 tenancy | `projectId` on **every** schema-bearing row including child tables (`link_endpoints`, `index_columns`, `constraint_columns`), plus on docs / comments / grants / logs. `organizationId` on `access_grants` and the rows a security query starts from. |
| C7 concurrency | `version Int @default(0)` on every object the user edits — with two stated carve-outs, both in §10.4: the three ordered child tables (`link_endpoints`, `index_columns`, `constraint_columns`) are versioned **by their parent**, and canvas geometry does not bump `version` at all. |
| C8 soft delete | `deletedAt` only on `organizations` and `projects`. |
| C9 timestamps | `createdAt` + `updatedAt`, `@db.Timestamptz(6)`, on every model without exception — including append-only logs. Uniformity is cheaper than an argued exception. |
| C11 ordering | `position Int` on `areas`, `fields`, `workspaces`; `ordinal Int` on `link_endpoints`, `index_columns`, `constraint_columns`, `ai_messages`. |

Two naming exceptions, both deliberate:

- `SchemaIndex` → `@@map("indexes")` and `SchemaIndexColumn` → `@@map("index_columns")`.
  A Prisma model literally named `Index` gives you `prisma.index.findMany()` and collides with
  Prisma's own index vocabulary in every code review. Table names still match spec §9.
- `Doc` → `@@map("docs")` — ordinary C2, called out only because "doc" is an overloaded word here.

### Who owns what, across documents

Five documents are written in parallel and two of them describe the same permission tables.
The split is:

- **This document owns the column list.** Every column, type, default, index, referential
  action and check constraint in the application database is defined here and nowhere else.
  If doc 05 prints a model sketch that differs from this one, this one is the schema.
- **Doc 05 owns the resolution algorithm** — precedence, liveness, caching, ceilings. Where
  this document states a permission *rule* (§4.1, §4.6) it is restating 05's rule so that the
  schema is readable on its own, and it names the rule id (`R12`, `R15`, …) so the two can be
  diffed mechanically.
- **Doc 04 owns the IR** and names which store columns are core properties. Its "deltas doc 02
  must adopt" (D1 `fields.type_args` / `type_dimensions`, D2 `index_columns.is_include`,
  D3 drop `areas.description`) are adopted below.

Three earlier divergences from doc 05's sketches, all resolved in this document's favour and
**now adopted by doc 05** — listed here so nobody has to hunt for them:

| Earlier doc 05 sketch | Here (and now in doc 05 too) | Why |
|---|---|---|
| `Role.scope RoleScope` | `Role.isBuiltIn Boolean` + `organizationId IS NULL` | `scope` is a third spelling of a fact two columns already carry, guarded by `roles_builtin_global_ck`. `scope = organizationId === null ? 'BUILT_IN' : 'ORG'` is a derived getter in the repository, not a column. |
| `ShareLink.resourceType` / `resourceId` | scope lives only on the link's `AccessGrant` | `access_grants_one_per_share_link_uq` makes that grant unique and mandatory, so a second copy is a value that can drift. The landing route reads it from the grant, which the resolver loads anyway. |
| `AccessRequest @@unique([resourceType, resourceId, requesterId, status])` | partial unique `WHERE status = 'pending'` | the four-column unique permits only one *denied* row ever, so a user cannot be denied twice. The partial index expresses the rule that was meant. |

And four the **other** way, where doc 05's semantics won and columns were added or kept here:

| Point | Resolution |
|---|---|
| `AccessGrant.canViewRestricted` (doc 05 R8) | **Added.** No built-in role carries `field:viewRestricted`, so without it every org must author a custom role to unhide one salary column — which fails spec §8's own workflow 2. |
| `perm_generation` on `Organization` / `Project` / `User` (doc 05 R19/§9.2) | **Added**, and they are the revocation mechanism (§3.2.1), not an optimisation. |
| `Project.restrictedFieldMode` as a real enum column rather than a `settings` key | **Real column.** It is read on every resolve and it is security-relevant; C4's JSONB rule is about *engine*-specific props, and C2 explicitly allows a Prisma enum for a closed set the database should enforce. |
| `Role.isArchived` | **Kept**, with doc 05's objection answered by narrowing the semantics: archiving hides a role from the pickers and never changes grant liveness (see the column comment). |

---

## 1. The schema

```prisma
// ---------------------------------------------------------------------------
// SchemaLoom — application database
// PostgreSQL 16 / Prisma 5.x
// ---------------------------------------------------------------------------

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// Doc 01 §8.2 owns this block. Output lives inside the package so Turborepo can cache it;
// `cjs` because apps/api compiles with module: Node16 and has no "type" field.
generator client {
  provider            = "prisma-client"
  output              = "../src/generated/prisma"
  runtime             = "nodejs"
  moduleFormat        = "cjs"
  importFileExtension = ""
}

// ===========================================================================
// ENUMS
// Prisma enums are used only where the set is closed, structural, and the
// database itself should enforce it (C2). Everything an engine plugin defines
// (entity kind, link kind, index method, constraint kind, custom-type kind) is a
// plain String validated by the engine's zod schema — adding an engine must never
// require a migration.
//
// Two sets that LOOK enum-shaped are deliberately String instead, because they
// will grow across phases and `ALTER TYPE … ADD VALUE` cannot be used in the same
// transaction that added the value — a migration that adds an atom and seeds it
// into a role would fail with "unsafe use of new value" and have to be split into
// two deploys:
//   * permission atoms  -> roles.atoms String[],   validated by permissionAtomSchema
//   * notification kinds -> notifications.type String, validated by notificationTypeSchema
// This matches activity_log.action and audit_log.action, which are open dotted-verb
// sets for the same reason.
// ===========================================================================

enum OrgRole {
  owner
  admin
  member
  guest

  @@map("org_role")
}

/// What an access grant / access request / share link can be attached to (C5).
/// Named ResourceType to match doc 05, which uses it on three models.
enum ResourceType {
  project
  area
  entity

  @@map("resource_type")
}

/// Spec section 5: restricted fields are "masked or not at all (project setting)".
/// A real column on projects, not a settings-JSON key: VisibilityFilter reads it on
/// every request and it is security-relevant (doc 05 section 6).
enum RestrictedFieldMode {
  mask
  hide

  @@map("restricted_field_mode")
}

/// Who a grant is for (C5).
enum PrincipalType {
  user
  group
  email_invite @map("email_invite")
  share_link   @map("share_link")

  @@map("principal_type")
}

/// Polymorphic target of a doc, a comment or an activity entry.
/// Superset of ResourceType: docs and comments also attach to a field.
enum TargetType {
  project
  area
  entity
  field

  @@map("target_type")
}

/// Drawing annotation. The IR spells these '1:1' | '1:N' | 'N:1' | 'N:M'; doc 04
/// section 8.1 holds the mapping table and it is restated in section 10.1 here.
enum LinkCardinality {
  one_to_one   @map("one_to_one")
  one_to_many  @map("one_to_many")
  many_to_one  @map("many_to_one")
  many_to_many @map("many_to_many")

  @@map("link_cardinality")
}

/// `withdrawn` (not `cancelled`) to match doc 05.
enum AccessRequestStatus {
  pending
  approved
  denied
  withdrawn

  @@map("access_request_status")
}

enum VerificationPurpose {
  email_verification @map("email_verification")
  password_reset     @map("password_reset")
  magic_link         @map("magic_link")
  email_change       @map("email_change")

  @@map("verification_purpose")
}

enum AiMessageRole {
  user
  assistant
  system

  @@map("ai_message_role")
}

enum SnapshotKind {
  manual
  auto
  import
  restore

  @@map("snapshot_kind")
}

/// Status of an AI-drafted doc suggestion (spec 6.2: "user reviews and accepts or
/// rejects each") and of a background export job (spec 2 / 6.4).
enum DocDraftStatus {
  pending
  accepted
  rejected

  @@map("doc_draft_status")
}

enum JobStatus {
  queued
  running
  done
  failed

  @@map("job_status")
}

enum ThemePreference {
  light
  dark
  system

  @@map("theme_preference")
}

// ===========================================================================
// AUTH  (spec section 4)
// ===========================================================================

model User {
  id                String          @id @default(cuid())
  /// Stored lowercase. Uniqueness is `users_email_uq ON users (lower(email))` in
  /// 0002, NOT a Prisma @unique — see section 2.1. The index is the enforcement;
  /// the application's normalise-on-write is the convenience.
  email             String
  emailVerifiedAt   DateTime?       @map("email_verified_at") @db.Timestamptz(6)
  name              String
  avatarUrl         String?         @map("avatar_url")
  /// argon2id hash. Null for users who only ever used OAuth or magic link.
  passwordHash      String?         @map("password_hash")
  theme             ThemePreference @default(system)
  /// TOTP shared secret, encrypted with the app key before it reaches the DB.
  totpSecret        String?         @map("totp_secret")
  totpConfirmedAt   DateTime?       @map("totp_confirmed_at") @db.Timestamptz(6)
  /// notificationPrefs{Input,Stored}Schema — see section 7
  notificationPrefs Json            @default("{}") @map("notification_prefs")
  /// Permission-cache generation for this subject (doc 05 R19). Bumped in the same
  /// transaction as any write that changes what THIS user can reach but not what
  /// a whole project or org can reach: org role change, group membership change,
  /// deactivation, email_invite -> user grant conversion. See section 3.2.
  permGeneration    Int             @default(0) @map("perm_generation")
  lastSeenAt        DateTime?       @map("last_seen_at") @db.Timestamptz(6)
  createdAt         DateTime        @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt         DateTime        @updatedAt @map("updated_at") @db.Timestamptz(6)

  accounts              Account[]
  sessions              Session[]
  verificationTokens    VerificationToken[]
  recoveryCodes         RecoveryCode[]
  orgMemberships        OrgMember[]
  groupMemberships      GroupMember[]
  createdProjects       Project[]
  updatedDocs           Doc[]
  authoredComments      Comment[]           @relation("CommentAuthor")
  resolvedComments      Comment[]           @relation("CommentResolvedBy")
  savedQueries          SavedQuery[]
  aiThreads             AiThread[]
  snapshots             Snapshot[]
  shareLinks            ShareLink[]
  grantsIssued          AccessGrant[]
  docDraftsCreated      DocDraft[]          @relation("DocDraftCreatedBy")
  docDraftsReviewed     DocDraft[]          @relation("DocDraftReviewedBy")
  exportJobs            ExportJob[]
  accessRequestsMade    AccessRequest[]     @relation("AccessRequestRequestedBy")
  accessRequestsDecided AccessRequest[]     @relation("AccessRequestDecidedBy")
  activityEvents        ActivityLog[]
  auditEvents           AuditLog[]
  notifications         Notification[]      @relation("NotificationRecipient")
  notificationsCaused   Notification[]      @relation("NotificationActor")
  invitationsSent       Invitation[]        @relation("InvitationInvitedBy")
  invitationsAccepted   Invitation[]        @relation("InvitationAcceptedBy")

  @@index([lastSeenAt])
  @@map("users")
}

/// OAuth identities (Google, GitHub). One row per provider per user.
model Account {
  id                String    @id @default(cuid())
  userId            String    @map("user_id")
  provider          String
  providerAccountId String    @map("provider_account_id")
  accessToken       String?   @map("access_token")
  refreshToken      String?   @map("refresh_token")
  idToken           String?   @map("id_token")
  tokenType         String?   @map("token_type")
  scope             String?
  expiresAt         DateTime? @map("expires_at") @db.Timestamptz(6)
  createdAt         DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt         DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([provider, providerAccountId])
  @@index([userId])
  @@map("accounts")
}

/// One row per *issued refresh token*, not one per device. A device is a
/// `family_id`: the first login creates a family, and every rotation inserts a new
/// row with the same `family_id` and stamps `rotated_at` on the old one. Reuse
/// detection: a presented token whose row already has `rotated_at` set means the
/// token leaked -> revoke every row in that family.
///
/// The "log out other devices" list in spec section 4 is therefore a query over
/// FAMILIES, not rows (section 3.5):
///   SELECT DISTINCT ON (family_id) family_id, user_agent, ip, created_at, last_used_at
///     FROM sessions WHERE user_id = $1 AND revoked_at IS NULL
///    ORDER BY family_id, created_at DESC;
/// Rendering the rows directly would show a laptop that refreshed every 15 minutes
/// for a month as ~2,900 devices.
///
/// Retention: the expiry sweep deletes rows where `expires_at < now()`. A rotated
/// row is kept until it expires — that window IS the reuse-detection window — and is
/// swept with everything else afterwards.
///
/// There is no `share_link_id` here. Share-link visitors have no user, so they have
/// no `sessions` row at all: they carry a stateless signed `sl_session` cookie
/// (doc 05 §7.12) holding exactly `{ sub, pid, rid, exp }` — the link id, the project id, the
/// granted resource id for the landing route, and the expiry. There is no `jti`: revoking the
/// link deletes its grant, so the cookie authenticates a principal that resolves to nothing.
/// See Key decision 9.
model Session {
  id               String    @id @default(cuid())
  userId           String    @map("user_id")
  /// sha256 of the refresh token. The raw token never touches the database.
  refreshTokenHash String    @unique @map("refresh_token_hash")
  /// The device. Constant across every rotation of one login.
  familyId         String    @map("family_id")
  userAgent        String?   @map("user_agent")
  ip               String?
  rotatedAt        DateTime? @map("rotated_at") @db.Timestamptz(6)
  revokedAt        DateTime? @map("revoked_at") @db.Timestamptz(6)
  lastUsedAt       DateTime? @map("last_used_at") @db.Timestamptz(6)
  expiresAt        DateTime  @map("expires_at") @db.Timestamptz(6)
  createdAt        DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt        DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  /// Serves the DISTINCT ON device list above.
  @@index([userId, familyId, createdAt])
  @@index([userId, revokedAt])
  @@index([familyId])
  @@index([expiresAt])
  @@map("sessions")
}

/// One table for email verification, password reset, magic link and email change.
/// Four tables with identical columns would be four tables with identical bugs.
model VerificationToken {
  id         String              @id @default(cuid())
  userId     String?             @map("user_id")
  /// Lowercased. Present even when userId is null (magic link to a new address).
  email      String
  purpose    VerificationPurpose
  tokenHash  String              @unique @map("token_hash")
  consumedAt DateTime?           @map("consumed_at") @db.Timestamptz(6)
  expiresAt  DateTime            @map("expires_at") @db.Timestamptz(6)
  createdAt  DateTime            @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt  DateTime            @updatedAt @map("updated_at") @db.Timestamptz(6)

  user User? @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([email, purpose])
  @@index([expiresAt])
  @@map("verification_tokens")
}

/// TOTP recovery codes. Hashed, single use.
model RecoveryCode {
  id        String    @id @default(cuid())
  userId    String    @map("user_id")
  codeHash  String    @map("code_hash")
  usedAt    DateTime? @map("used_at") @db.Timestamptz(6)
  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, usedAt])
  @@map("recovery_codes")
}

// ===========================================================================
// TENANCY  (spec section 5)
// ===========================================================================

model Organization {
  id        String    @id @default(cuid())
  name      String
  /// URL slug. Uniqueness is a partial unique index on lower(slug) that ignores
  /// soft-deleted rows — see the companion SQL migration.
  slug      String
  avatarUrl String?   @map("avatar_url")
  /// orgSettings{Input,Stored}Schema — see section 7
  settings  Json      @default("{}")
  /// Permission-cache generation for everything in this org (doc 05 R19). Bumped by
  /// custom-role edits, group creation/deletion, bulk membership changes and org
  /// soft-delete. See section 3.2 — three counters is what removes the fan-out.
  permGeneration Int  @default(0) @map("perm_generation")
  deletedAt DateTime? @map("deleted_at") @db.Timestamptz(6)
  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  members       OrgMember[]
  groups        UserGroup[]
  workspaces    Workspace[]
  projects      Project[]
  roles         Role[]
  accessGrants  AccessGrant[]
  invitations   Invitation[]
  auditLogs     AuditLog[]
  notifications Notification[]

  @@index([deletedAt])
  @@map("organizations")
}

model OrgMember {
  id             String   @id @default(cuid())
  organizationId String   @map("organization_id")
  userId         String   @map("user_id")
  role           OrgRole  @default(member)
  joinedAt       DateTime @default(now()) @map("joined_at") @db.Timestamptz(6)
  createdAt      DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt      DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  user         User         @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([organizationId, userId])
  @@index([userId])
  @@index([organizationId, role])
  @@map("org_members")
}

model UserGroup {
  id             String   @id @default(cuid())
  organizationId String   @map("organization_id")
  name           String
  description    String?
  createdAt      DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt      DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  organization Organization  @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  members      GroupMember[]

  @@index([organizationId])
  @@map("user_groups")
}

model GroupMember {
  id        String   @id @default(cuid())
  groupId   String   @map("group_id")
  userId    String   @map("user_id")
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  group UserGroup @relation(fields: [groupId], references: [id], onDelete: Cascade)
  user  User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([groupId, userId])
  /// Hot path: the permission resolver needs "which groups is this user in".
  @@index([userId])
  @@map("group_members")
}

model Workspace {
  id             String   @id @default(cuid())
  organizationId String   @map("organization_id")
  name           String
  slug           String
  /// C11 — sidebar ordering.
  position       Int      @default(0)
  createdAt      DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt      DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  projects     Project[]

  @@unique([organizationId, slug])
  @@index([organizationId, position])
  @@map("workspaces")
}

model Project {
  id             String    @id @default(cuid())
  organizationId String    @map("organization_id")
  workspaceId    String    @map("workspace_id")
  name           String
  slug           String
  description    String?
  /// EngineRegistry key, e.g. "postgresql". Never an enum: adding an engine must
  /// not require a migration.
  engineId       String    @map("engine_id")
  /// The TARGET DATABASE version ("16"), not the plugin version. Doc 03 §15, doc 04 §1.3.
  engineVersion  String    @map("engine_version")
  /// The ENGINE PLUGIN contract version the stored `engine_props` were written under
  /// (doc 03 §15, semver of `EngineDefinition.version`). A real column, not a settings key:
  /// `settings` is core-owned and validated by core's zod schema, and "find every project that
  /// needs attention after this deploy" must be an indexed query. `compareEngineVersion` reads
  /// it on open and on every write; a newer-than-engine or older-major value opens the project
  /// read-only.
  enginePluginVersion String @map("engine_plugin_version")
  /// Monotonic revision of the project's SCHEMA CONTENT, incremented once per transaction that
  /// writes or deletes any schema object (doc 03 §8.1). It is the engine-diagnostics cache key.
  /// It cannot be `max(object.version)`: a maximum does not move when a non-maximal object is
  /// edited and FALLS when the holder of the maximum is deleted, so a stale entry is served and
  /// then collides with an older one.
  schemaRevision BigInt    @default(0) @map("schema_revision")
  /// projectSettings{Input,Stored}Schema — see section 7. AI toggles only, now that
  /// restrictedFieldMode is a real column and canvas preferences moved to the
  /// browser.
  settings       Json      @default("{}")
  /// Spec section 5: "masked or not at all (project setting)". A real column
  /// because VisibilityFilter reads it on every single request; a settings-JSON key
  /// would put a zod parse of the whole settings object on the hot path and on the
  /// security path (section 7).
  restrictedFieldMode RestrictedFieldMode @default(mask) @map("restricted_field_mode")
  /// Permission-cache generation for this project (doc 05 R19). Bumped by every
  /// grant write, share-link create/revoke, area create/delete, entity area move,
  /// isRestricted toggle, restrictedFieldMode change and soft-delete. Section 3.2.
  permGeneration Int      @default(0) @map("perm_generation")
  createdById    String?   @map("created_by_id")
  deletedAt      DateTime? @map("deleted_at") @db.Timestamptz(6)
  /// C7 for the project object itself (name, settings, engine version). Canvas
  /// geometry does NOT bump it — section 10.4.
  version        Int       @default(0)
  createdAt      DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt      DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  /// NoAction, made DEFERRABLE INITIALLY DEFERRED in 0002 — see section 8.6. The
  /// product rule ("a workspace with projects cannot be deleted") lives in the
  /// workspace service, which is the only place that can offer "move them first".
  workspace    Workspace    @relation(fields: [workspaceId], references: [id], onDelete: NoAction)
  createdBy    User?        @relation(fields: [createdById], references: [id], onDelete: SetNull)

  namespaces         Namespace[]
  areas              Area[]
  entities           Entity[]
  fields             Field[]
  links              Link[]
  linkEndpoints      LinkEndpoint[]
  indexes            SchemaIndex[]
  indexColumns       SchemaIndexColumn[]
  constraints        Constraint[]
  constraintColumns  ConstraintColumn[]
  customTypes        CustomType[]
  docs               Doc[]
  comments           Comment[]
  savedQueries       SavedQuery[]
  savedQueryEntities SavedQueryEntity[]
  aiThreads          AiThread[]
  aiMessages         AiMessage[]
  snapshots          Snapshot[]
  docDrafts          DocDraft[]
  exportJobs         ExportJob[]
  accessGrants       AccessGrant[]
  shareLinks         ShareLink[]
  accessRequests     AccessRequest[]
  activityLogs       ActivityLog[]
  auditLogs          AuditLog[]
  notifications      Notification[]

  @@index([organizationId, deletedAt])
  @@index([workspaceId, deletedAt])
  @@index([engineId])
  @@map("projects")
}

// ===========================================================================
// SCHEMA MODEL — the live, relational source of truth (C3)
// Every row carries projectId (C6), engineProps (C4) and version (C7).
// ===========================================================================

/// PostgreSQL schema / MySQL database / MongoDB database.
///
/// **Every project has exactly one default namespace, created with the project.**
/// PostgreSQL gets `public`; an engine with `capabilities.supportsNamespaces = false`
/// gets one named `''` that its UI never shows. That guarantee is what lets
/// `entities.namespace_id` and `custom_types.namespace_id` stay nullable in the store
/// while doc 04's assembly resolves `null` to the default namespace's id, making
/// `Entity.namespaceId` non-null in the IR (doc 04 sections 2.4/8.1, resolved there in
/// this document's favour). Store sparse, IR explicit.
model Namespace {
  id          String   @id @default(cuid())
  projectId   String   @map("project_id")
  name        String
  /// Exactly one per project may be true (`namespaces_one_default_uq`). Existence
  /// is guaranteed by the project-creation transaction, not by the database.
  isDefault   Boolean  @default(false) @map("is_default")
  engineProps Json     @default("{}") @map("engine_props")
  /// Doc 04 delta D4 / doc 05 R27. Every IR object this row's engine-owned EXPRESSIONS
  /// textually reference, produced by the engine's `extractReferences` (doc 03 §3.1) on every
  /// write and import. `VisibilityFilter` blanks `engine_props` when any referenced object is
  /// invisible — which is the only way core can redact an expression C4 forbids it to parse.
  /// Validated by `objectRefsSchema`. Server-owned; never accepted from a request body.
  refs        Json     @default("{\"entityIds\":[],\"fieldIds\":[]}")
  version     Int      @default(0)
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  project     Project      @relation(fields: [projectId], references: [id], onDelete: Cascade)
  entities    Entity[]
  customTypes CustomType[]

  @@index([projectId])
  @@map("namespaces")
}

/// A named, coloured region on the canvas ("Billing"). A *core* concept, not an
/// IR object — no engineProps, deliberately (see Key decisions #4).
/// Creating, deleting an Area or moving an entity into one is a SHARING event,
/// not a cosmetic one — see section 4.6.
model Area {
  id          String   @id @default(cuid())
  projectId   String   @map("project_id")
  name        String
  /// Radix Colors scale name, e.g. "indigo", "grass".
  color       String   @default("indigo")
  /// There is deliberately no `collapsed` column (doc 04 delta D3, adopted): collapse is
  /// per-viewer canvas state and lives in the browser, by exactly the argument that moved
  /// snap-to-grid there. Nor is there a `description` — the `Doc` row covers it, and
  /// `TargetType` already admits `area`.
  /// C11 — sidebar / legend ordering. Surfaces as `Area.ordinal` in the IR.
  position    Int      @default(0)
  version     Int      @default(0)
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  project  Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  entities Entity[]

  @@index([projectId, position])
  @@map("areas")
}

/// Table, view, materialised view, collection, node label, key pattern.
/// `kind` is engine-defined (a String, never an enum).
model Entity {
  id          String   @id @default(cuid())
  projectId   String   @map("project_id")
  namespaceId String?  @map("namespace_id")
  areaId      String?  @map("area_id")
  name        String
  kind        String   @default("table")
  /// Canvas geometry. A C4 exception: core lays out, virtualises and hit-tests
  /// with these, so they are real columns, not engineProps. They are ALSO outside
  /// the C7 concurrency contract — writing them does not bump `version` — because
  /// auto-layout rewrites 300 of them at once. See section 10.4.
  positionX   Float    @default(0) @map("position_x")
  positionY   Float    @default(0) @map("position_y")
  width       Float?
  height      Float?
  /// Optional per-entity colour override; otherwise the Area colour wins.
  color       String?
  engineProps Json     @default("{}") @map("engine_props")
  /// D4 — see `namespaces.refs`. A view's `viewDefinition` lives in engineProps and names
  /// other entities and columns, so an entity carries references like everything else.
  refs        Json     @default("{\"entityIds\":[],\"fieldIds\":[]}")
  version     Int      @default(0)
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  project     Project    @relation(fields: [projectId], references: [id], onDelete: Cascade)
  /// NoAction + DEFERRABLE INITIALLY DEFERRED in 0002 (section 8.6). "You cannot
  /// drop a schema that still has tables" is a service-layer rule, not a
  /// referential action — expressed as RESTRICT it breaks every project purge.
  namespace   Namespace? @relation(fields: [namespaceId], references: [id], onDelete: NoAction)
  area        Area?      @relation(fields: [areaId], references: [id], onDelete: SetNull)

  fields             Field[]
  indexes            SchemaIndex[]
  constraints        Constraint[]
  outgoingLinks      Link[]             @relation("LinkSource")
  incomingLinks      Link[]             @relation("LinkTarget")
  savedQueryEntities SavedQueryEntity[]

  @@index([projectId])
  @@index([projectId, areaId])
  @@index([namespaceId])
  @@index([projectId, name])
  @@map("entities")
}

/// Column, document field, property. Nests through parentFieldId (section 9).
model Field {
  id            String   @id @default(cuid())
  projectId     String   @map("project_id")
  entityId      String   @map("entity_id")
  /// Self-relation for nested/document fields. Null = top-level.
  parentFieldId String?  @map("parent_field_id")
  name          String
  /// Engine type name as the engine's typeCatalog spells it ("varchar",
  /// "timestamptz", "jsonb"). For a user-defined type this is the CustomType's
  /// name and `customTypeId` points at the row.
  ///
  /// DENORMALISED when `customTypeId IS NOT NULL`. The rule that keeps it honest:
  /// **renaming a CustomType rewrites `data_type` on every dependent field row in
  /// the same transaction** (`UPDATE fields SET data_type = $new WHERE custom_type_id
  /// = $id`, one index scan on `fields(custom_type_id)`). Without that rule the
  /// exporter emits DDL naming a type that no longer exists, and the round-trip test
  /// cannot catch it because import and export both read the same stale string.
  /// See section 8.3 and the invariant test in section 11.
  dataType      String   @map("data_type")
  customTypeId  String?  @map("custom_type_id")
  /// Doc 04 delta D1: `TypeRef.args` and `TypeRef.dimensions` are CORE, not
  /// engineProps. `varchar(255)` -> `varchar(64)` must surface as ONE structural
  /// change in the diff; with the length in engineProps it surfaces twice and the
  /// migration generator sees two unrelated edits. Array dimensions likewise.
  /// e.g. numeric(10,2) -> typeArgs = [10, 2]; text[][] -> typeDimensions = 2.
  typeArgs      Json     @default("[]") @map("type_args")
  typeDimensions Int     @default(0) @map("type_dimensions")
  /// C11 — order within (entityId, parentFieldId).
  position      Int      @default(0)
  isNullable    Boolean  @default(true) @map("is_nullable")
  /// C4 exception: the permission layer filters on this on every read.
  isRestricted  Boolean  @default(false) @map("is_restricted")
  isPii         Boolean  @default(false) @map("is_pii")
  isDeprecated  Boolean  @default(false) @map("is_deprecated")
  engineProps   Json     @default("{}") @map("engine_props")
  /// D4 — see `namespaces.refs`. This is the row that carries the leak: `engineProps.default`
  /// (`DEFAULT nextval('employee_salary_seq')`) and `engineProps.generatedExpression`
  /// (`GENERATED ALWAYS AS (base + bonus)`) name restricted columns in plain text.
  refs          Json     @default("{\"entityIds\":[],\"fieldIds\":[]}")
  version       Int      @default(0)
  createdAt     DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt     DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  project    Project     @relation(fields: [projectId], references: [id], onDelete: Cascade)
  entity     Entity      @relation(fields: [entityId], references: [id], onDelete: Cascade)
  parent     Field?      @relation("FieldNesting", fields: [parentFieldId], references: [id], onDelete: Cascade)
  children   Field[]     @relation("FieldNesting")
  /// NoAction + DEFERRABLE INITIALLY DEFERRED in 0002 (section 8.6). "You cannot
  /// drop an enum columns still use" is enforced in the custom-type service.
  customType CustomType? @relation(fields: [customTypeId], references: [id], onDelete: NoAction)

  linkSourceEndpoints LinkEndpoint[]      @relation("LinkEndpointSourceField")
  linkTargetEndpoints LinkEndpoint[]      @relation("LinkEndpointTargetField")
  indexColumns        SchemaIndexColumn[]
  constraintColumns   ConstraintColumn[]

  /// Target of the composite FK (parent_field_id, entity_id) -> (id, entity_id)
  /// that keeps a nested field inside its parent's entity. See section 2.
  @@unique([id, entityId])
  @@index([projectId])
  @@index([entityId, position])
  @@index([parentFieldId, position])
  /// Serves the custom-type rename rewrite above, and the "is this enum in use"
  /// probe before a drop. There is deliberately NO (project_id, is_restricted)
  /// index: the loader already selects every field in the project, so
  /// VisibilityFilter has them in memory and a seventh index on the largest table
  /// costs a write on every row of a 10,000-row DDL import for nothing.
  @@index([customTypeId])
  @@map("fields")
}

/// Foreign key, reference, embedding, graph edge. `kind` is engine-defined.
/// The field pairs live in LinkEndpoint so composite FKs work (section 10).
///
/// A link with ZERO endpoints is legal and is not swept. It is an entity-level
/// link: a graph edge with no key columns (spec section 1 names Neo4j), a link the
/// user drew before choosing columns, or a composite FK that lost its columns to a
/// cascade. Doc 04 section 2.7 requires this and section 8.6 rules on it. Deleting
/// the relationship line a human drew because someone dropped a column is the more
/// destructive of the two readings.
model Link {
  id             String          @id @default(cuid())
  projectId      String          @map("project_id")
  /// Nullable: an unnamed FK is legal; the exporter generates a name.
  name           String?
  kind           String          @default("foreign_key")
  cardinality    LinkCardinality @default(many_to_one)
  /// Denormalised so the canvas can draw every edge without touching endpoints.
  /// Kept consistent with the endpoints by the engine validator.
  sourceEntityId String          @map("source_entity_id")
  targetEntityId String          @map("target_entity_id")
  /// ON DELETE / ON UPDATE actions, deferrability, MATCH FULL: all PostgreSQL
  /// vocabulary, so all engineProps (C4).
  engineProps    Json            @default("{}") @map("engine_props")
  /// D4 — see `namespaces.refs`.
  refs           Json            @default("{\"entityIds\":[],\"fieldIds\":[]}")
  version        Int             @default(0)
  createdAt      DateTime        @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt      DateTime        @updatedAt @map("updated_at") @db.Timestamptz(6)

  project      Project        @relation(fields: [projectId], references: [id], onDelete: Cascade)
  sourceEntity Entity         @relation("LinkSource", fields: [sourceEntityId], references: [id], onDelete: Cascade)
  targetEntity Entity         @relation("LinkTarget", fields: [targetEntityId], references: [id], onDelete: Cascade)
  endpoints    LinkEndpoint[]

  @@index([projectId])
  @@index([sourceEntityId])
  @@index([targetEntityId])
  @@map("links")
}

/// One (sourceField -> targetField) pair of a link. A simple FK has one row; a
/// composite FK over (tenant_id, customer_id) has two, ordinal 0 and 1.
///
/// No `version` column: this table is edited only as part of its `Link`, and the
/// C7 check is performed against `links.version` (section 10.4). Same for
/// `index_columns` and `constraint_columns`.
model LinkEndpoint {
  id            String   @id @default(cuid())
  projectId     String   @map("project_id")
  linkId        String   @map("link_id")
  /// C11 — column order inside the FK. Significant: it decides which source
  /// column pairs with which target column in the generated DDL.
  ordinal       Int
  sourceFieldId String   @map("source_field_id")
  targetFieldId String   @map("target_field_id")
  createdAt     DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt     DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  project     Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  link        Link    @relation(fields: [linkId], references: [id], onDelete: Cascade)
  sourceField Field   @relation("LinkEndpointSourceField", fields: [sourceFieldId], references: [id], onDelete: Cascade)
  targetField Field   @relation("LinkEndpointTargetField", fields: [targetFieldId], references: [id], onDelete: Cascade)

  @@unique([linkId, ordinal])
  @@unique([linkId, sourceFieldId])
  @@index([sourceFieldId])
  @@index([targetFieldId])
  @@index([projectId])
  @@map("link_endpoints")
}

/// @@map("indexes"). Model renamed to avoid `prisma.index`.
model SchemaIndex {
  id          String   @id @default(cuid())
  projectId   String   @map("project_id")
  entityId    String   @map("entity_id")
  name        String
  /// Engine-defined access method: btree, hash, gin, gist, brin, ...
  method      String   @default("btree")
  /// Reserved for a bare `CREATE UNIQUE INDEX` with no backing constraint —
  /// partial or expression uniqueness. A table-level UNIQUE is ALWAYS a
  /// `Constraint` with `kind = 'unique'`. See section 10.5 for why that rule has
  /// to be written down.
  isUnique    Boolean  @default(false) @map("is_unique")
  /// Partial-index predicate, storage parameters, NULLS NOT DISTINCT: all
  /// PostgreSQL vocabulary -> engineProps (C4). INCLUDE columns are NOT here —
  /// they are `index_columns` rows with `is_include = true`, because a field id
  /// inside a JSON bag would not cascade when the field is deleted.
  engineProps Json     @default("{}") @map("engine_props")
  /// D4 — see `namespaces.refs`. Covers BOTH the index's own `engineProps.where` (the partial
  /// predicate) and every `index_columns.expression` beneath it: `index_columns` is edited only
  /// as part of its index (§10.4), so one `refs` bag per index is the whole story and
  /// `index_columns` needs no column of its own.
  refs        Json     @default("{\"entityIds\":[],\"fieldIds\":[]}")
  version     Int      @default(0)
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  project Project             @relation(fields: [projectId], references: [id], onDelete: Cascade)
  entity  Entity              @relation(fields: [entityId], references: [id], onDelete: Cascade)
  columns SchemaIndexColumn[]

  @@index([projectId])
  @@index([entityId])
  @@map("indexes")
}

/// One column (or one expression) of an index. Exactly one of fieldId /
/// expression is non-null — enforced by a CHECK.
model SchemaIndexColumn {
  id          String   @id @default(cuid())
  projectId   String   @map("project_id")
  indexId     String   @map("index_id")
  /// C11.
  ordinal     Int
  fieldId     String?  @map("field_id")
  /// Expression index, e.g. lower(email).
  expression  String?
  /// "asc" | "desc". A core column because doc 04 makes `IndexColumn.direction` a
  /// core IR property that the diff and the index badge both read.
  direction   String   @default("asc")
  /// Doc 04 delta D2: an INCLUDE column is a row here, not an id buried in
  /// `indexes.engineProps`, so deleting the field cascades it out of the list.
  /// `IndexColumn.role = isInclude ? 'include' : 'key'` in the IR.
  isInclude   Boolean  @default(false) @map("is_include")
  /// Operator class, collation, NULLS FIRST/LAST — engine vocabulary.
  engineProps Json     @default("{}") @map("engine_props")
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  project Project     @relation(fields: [projectId], references: [id], onDelete: Cascade)
  index   SchemaIndex @relation(fields: [indexId], references: [id], onDelete: Cascade)
  field   Field?      @relation(fields: [fieldId], references: [id], onDelete: Cascade)

  @@unique([indexId, ordinal])
  @@index([fieldId])
  @@index([projectId])
  @@map("index_columns")
}

/// Primary key, unique, check, exclusion. `kind` is engine-defined.
/// Foreign keys are NOT constraints here — they are Links, because the canvas
/// draws them. The PostgreSQL exporter emits both from the same model.
model Constraint {
  id          String   @id @default(cuid())
  projectId   String   @map("project_id")
  entityId    String   @map("entity_id")
  name        String?
  kind        String
  /// CHECK / EXCLUDE body. Engines that have no expression constraints leave it null.
  expression  String?
  engineProps Json     @default("{}") @map("engine_props")
  /// D4 — see `namespaces.refs`. `CHECK (discount < employees.salary * 0.1)` names a restricted
  /// column with no field id anywhere in the row.
  refs        Json     @default("{\"entityIds\":[],\"fieldIds\":[]}")
  version     Int      @default(0)
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  project Project            @relation(fields: [projectId], references: [id], onDelete: Cascade)
  entity  Entity             @relation(fields: [entityId], references: [id], onDelete: Cascade)
  columns ConstraintColumn[]

  @@index([projectId])
  @@index([entityId])
  @@index([entityId, kind])
  @@map("constraints")
}

model ConstraintColumn {
  id           String   @id @default(cuid())
  projectId    String   @map("project_id")
  constraintId String   @map("constraint_id")
  /// C11 — PK column order is semantically significant.
  ordinal      Int
  fieldId      String   @map("field_id")
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt    DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  project    Project    @relation(fields: [projectId], references: [id], onDelete: Cascade)
  constraint Constraint @relation(fields: [constraintId], references: [id], onDelete: Cascade)
  field      Field      @relation(fields: [fieldId], references: [id], onDelete: Cascade)

  @@unique([constraintId, ordinal])
  @@unique([constraintId, fieldId])
  @@index([fieldId])
  @@index([projectId])
  @@map("constraint_columns")
}

/// Enum, domain, composite type. Labels/attributes/base type live in
/// engineProps — core never queries an individual enum label.
model CustomType {
  id          String   @id @default(cuid())
  projectId   String   @map("project_id")
  namespaceId String?  @map("namespace_id")
  name        String
  /// "enum" | "domain" | "composite" for PostgreSQL; engine-defined.
  kind        String
  engineProps Json     @default("{}") @map("engine_props")
  /// D4 — see `namespaces.refs`. A domain's CHECK body lives in engineProps.
  refs        Json     @default("{\"entityIds\":[],\"fieldIds\":[]}")
  version     Int      @default(0)
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  project   Project    @relation(fields: [projectId], references: [id], onDelete: Cascade)
  /// NoAction + DEFERRABLE INITIALLY DEFERRED in 0002 (section 8.6).
  namespace Namespace? @relation(fields: [namespaceId], references: [id], onDelete: NoAction)
  fields    Field[]

  @@index([projectId])
  @@index([namespaceId])
  @@map("custom_types")
}

// ===========================================================================
// DOCUMENTATION, COMMENTS, QUERIES, AI, HISTORY
// ===========================================================================

/// One doc per target. Polymorphic by (targetType, targetId) — see section 5.
model Doc {
  id          String     @id @default(cuid())
  projectId   String     @map("project_id")
  targetType  TargetType @map("target_type")
  targetId    String     @map("target_id")
  /// TipTap JSON document. The default is an EMPTY TIPTAP DOC, not `{}` — every
  /// Json default must itself satisfy the column's zod schema, and `richTextSchema`
  /// requires `{ type: 'doc' }`. Section 7.
  content     Json       @default("{\"type\":\"doc\"}")
  /// Structured field docs: business meaning, allowed values, examples, unit,
  /// owner. Shape differs per targetType; guarded by a discriminated zod union.
  /// NULLABLE with no default: project- and area-level docs have no structured
  /// payload at all, and `{}` cannot carry the union's discriminator.
  structured  Json?
  /// Flattened text for full-text search and for the AI context serializer.
  /// Derived from content on every write; never edited directly.
  plainText   String?    @map("plain_text")
  updatedById String?    @map("updated_by_id")
  version     Int        @default(0)
  createdAt   DateTime   @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime   @updatedAt @map("updated_at") @db.Timestamptz(6)

  project   Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  updatedBy User?   @relation(fields: [updatedById], references: [id], onDelete: SetNull)

  @@unique([targetType, targetId])
  @@index([projectId, targetType])
  @@map("docs")
}

/// Threaded comments on entities and fields (project/area allowed for symmetry).
/// `project_id` is DERIVED from the target row by the write path, never accepted
/// from the request body — see section 6.
model Comment {
  id           String     @id @default(cuid())
  projectId    String     @map("project_id")
  targetType   TargetType @map("target_type")
  targetId     String     @map("target_id")
  /// Null for a thread root.
  parentId     String?    @map("parent_id")
  /// Denormalised thread root id (equals id for a root) so one indexed query
  /// fetches a whole thread. Intentionally not a FK — see section 6.
  rootId       String     @map("root_id")
  authorId     String?    @map("author_id")
  /// Same empty-TipTap-doc default as `docs.content`, for the same reason.
  content      Json       @default("{\"type\":\"doc\"}")
  plainText    String?    @map("plain_text")
  /// User ids extracted from the @mention marks on write. Drives notifications
  /// and "comments mentioning me" without a join table. BEST-EFFORT: nothing
  /// sweeps this when a user is deleted; readers filter out ids that no longer
  /// resolve and render them as "Deleted user". See Open question 5.
  mentionedIds String[]   @default([]) @map("mentioned_ids")
  resolvedAt   DateTime?  @map("resolved_at") @db.Timestamptz(6)
  resolvedById String?    @map("resolved_by_id")
  version      Int        @default(0)
  createdAt    DateTime   @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt    DateTime   @updatedAt @map("updated_at") @db.Timestamptz(6)

  project    Project   @relation(fields: [projectId], references: [id], onDelete: Cascade)
  parent     Comment?  @relation("CommentThread", fields: [parentId], references: [id], onDelete: Cascade)
  replies    Comment[] @relation("CommentThread")
  author     User?     @relation("CommentAuthor", fields: [authorId], references: [id], onDelete: SetNull)
  resolvedBy User?     @relation("CommentResolvedBy", fields: [resolvedById], references: [id], onDelete: SetNull)

  @@index([targetType, targetId, createdAt])
  @@index([rootId, createdAt])
  @@index([projectId, resolvedAt, createdAt])
  @@index([parentId])
  @@map("comments")
}

model SavedQuery {
  id          String   @id @default(cuid())
  projectId   String   @map("project_id")
  createdById String?  @map("created_by_id")
  aiThreadId  String?  @map("ai_thread_id")
  name        String
  description String?
  queryText   String   @map("query_text")
  /// Engine queryLanguage id: "sql", "mongo-aggregation", "cypher".
  language    String   @default("sql")
  tags        String[] @default([])
  /// FAIL-CLOSED flag for the visibility filter. True only when the engine's
  /// `queryValidator` resolved EVERY identifier in `queryText` and the
  /// `saved_query_entities` rows below were written from that resolution, in the
  /// same transaction. A hand-edited query, or one the validator could not parse,
  /// has zero join rows — and zero join rows passes any "does this query touch a
  /// hidden entity" filter, which would then render the query text (table names,
  /// restricted column names) to someone who may not see them.
  ///
  /// Rule: a query with `identifiersResolved = false` is visible only to principals
  /// holding `schema:view` at PROJECT scope. Reset to false for every saved query
  /// in the project whenever an entity or field is renamed or deleted (one UPDATE
  /// by `project_id`); the next validation run sets it back.
  identifiersResolved Boolean @default(false) @map("identifiers_resolved")
  /// Doc 05 L25. Written in the same transaction as `identifiersResolved = true`, from the
  /// engine `queryValidator`'s `touchedEntityIds` / `touchedFieldIds` (doc 03 §12). These are
  /// REAL COLUMNS rather than a re-parse or a join, because the library listing filters a page
  /// of rows with an in-memory set test on every read, and because the filter is a security
  /// control (same argument as `projects.restricted_field_mode`).
  ///
  /// The read rule, combining L25 with the fail-closed flag above:
  ///   * `identifiersResolved = true`  -> the row is visible iff every `touched_entity_ids` id
  ///     is visible AND no `touched_field_ids` id is masked or hidden for the subject;
  ///   * `identifiersResolved = false` -> the arrays mean nothing (an empty array would pass the
  ///     test above trivially), so the row is visible only to a subject whose view of the
  ///     project is COMPLETE — doc 05's R21' predicate, `visibleEntityIds.size ===
  ///     totalEntityCount && entitiesWithRestrictedFields ⊆ restrictedOkEntityIds`.
  /// A failing row is omitted entirely and 404s on read; it is never stubbed, because the query
  /// text IS the payload and SQL cannot be partially redacted.
  touchedEntityIds String[] @default([]) @map("touched_entity_ids")
  touchedFieldIds  String[] @default([]) @map("touched_field_ids")
  version     Int      @default(0)
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  project   Project            @relation(fields: [projectId], references: [id], onDelete: Cascade)
  createdBy User?              @relation(fields: [createdById], references: [id], onDelete: SetNull)
  aiThread  AiThread?          @relation(fields: [aiThreadId], references: [id], onDelete: SetNull)
  entities  SavedQueryEntity[]

  @@index([projectId, updatedAt])
  @@index([createdById])
  @@index([tags(ops: ArrayOps)], type: Gin)
  @@map("saved_queries")
}

/// "Saved queries linked to the entities they use" — needed so that hiding an
/// entity from a user also hides the queries that touch it.
model SavedQueryEntity {
  savedQueryId String   @map("saved_query_id")
  entityId     String   @map("entity_id")
  projectId    String   @map("project_id")
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt    DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  savedQuery SavedQuery @relation(fields: [savedQueryId], references: [id], onDelete: Cascade)
  entity     Entity     @relation(fields: [entityId], references: [id], onDelete: Cascade)
  project    Project    @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@id([savedQueryId, entityId])
  @@index([entityId])
  @@index([projectId])
  @@map("saved_query_entities")
}

/// **A thread is private to its creator.** `ai_messages.content` and `.query_text`
/// hold schema identifiers in plain text, written by someone who could see them; a
/// shared thread list would hand a Viewer without `field:viewRestricted` the text of
/// a query over `salary`. There is no shared thread list in any phase. The
/// `(project_id, last_message_at)` index below exists for usage accounting, rate
/// limiting and retention sweeps — not for a UI list. Making threads shareable later
/// requires re-validating every identifier in `content` at read time; that is a
/// deliberate design decision, not a feature flag.
model AiThread {
  id            String    @id @default(cuid())
  projectId     String    @map("project_id")
  userId        String?   @map("user_id")
  title         String    @default("Untitled")
  /// The canvas selection the thread started from: { entityIds, fieldIds,
  /// linkIds, areaIds }. Guarded by selectionSchema. BEST-EFFORT ids: objects can
  /// be deleted between turns. The context serializer drops ids that no longer
  /// resolve AND tells the user in the next turn ("3 selected tables no longer
  /// exist"), because silently answering about a smaller schema than the user
  /// selected is the worse failure. See Open question 5.
  selection     Json      @default("{}")
  lastMessageAt DateTime? @map("last_message_at") @db.Timestamptz(6)
  createdAt     DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt     DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  project      Project      @relation(fields: [projectId], references: [id], onDelete: Cascade)
  user         User?        @relation(fields: [userId], references: [id], onDelete: SetNull)
  messages     AiMessage[]
  savedQueries SavedQuery[]

  @@index([projectId, lastMessageAt])
  @@index([userId, lastMessageAt])
  @@map("ai_threads")
}

model AiMessage {
  id        String        @id @default(cuid())
  /// C6: denormalised so per-project AI usage and rate-limit reporting never
  /// joins through ai_threads.
  projectId String        @map("project_id")
  threadId  String        @map("thread_id")
  role      AiMessageRole
  /// C11 — turn order within the thread.
  ordinal   Int
  content   String
  /// The extracted query, if the assistant produced one.
  queryText String?       @map("query_text")
  model     String?
  tokensIn  Int?          @map("tokens_in")
  tokensOut Int?          @map("tokens_out")
  /// Doc 05 L25, same shape and same read rule as `saved_queries`. Real columns, not a key in
  /// `metadata`: a thread is replayed to the AI provider on every follow-up, so turn 1's SQL is
  /// re-sent under the subject's CURRENT permissions, and the filter must be a cheap set test on
  /// the row rather than a parse of `content`. A thread with any failing message is omitted
  /// whole and 404s — a transcript with holes replays nonsense.
  touchedEntityIds String[]  @default([]) @map("touched_entity_ids")
  touchedFieldIds  String[]  @default([]) @map("touched_field_ids")
  /// Assumptions, queryValidator result, suggested join-path additions.
  /// aiMessageMetaSchema. The id arrays inside it are best-effort and unswept, like
  /// `ai_threads.selection` (Open question 5); the two columns above are not — they are the
  /// visibility filter's input and are written from the validator result.
  metadata  Json          @default("{}")
  createdAt DateTime      @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt DateTime      @updatedAt @map("updated_at") @db.Timestamptz(6)

  project Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  thread  AiThread @relation(fields: [threadId], references: [id], onDelete: Cascade)

  @@unique([threadId, ordinal])
  @@index([projectId, createdAt])
  @@map("ai_messages")
}

/// Frozen IR JSON (C3). Never the source of truth — only history and diffing.
///
/// **Snapshots are project-scoped objects and carry a project-scoped access rule.**
/// `ir` is one opaque blob of the whole project, so `VisibilityFilter` has nothing
/// to filter: an area-scoped Editor who could list snapshots would read every entity
/// they cannot see and every restricted field name. Therefore:
///   * reading or diffing a snapshot requires `history:view` **at project scope**;
///   * restoring one additionally requires `schema:edit` **at project scope**.
/// An area- or entity-scoped principal gets 403 on both, whatever their role
/// contains. This is the one place where an atom is not evaluated at the resource
/// the request names, and it is stated here and in doc 05 rather than discovered.
///
/// **Restore concurrency.** A restore is a whole-project rewrite: it takes
/// `SELECT id FROM projects WHERE id = $1 FOR UPDATE`, rewrites rows, bumps
/// `projects.version` and every touched object's `version`, and broadcasts a
/// `project:reloaded` event. Concurrent writers get 409 with
/// `code = 'project_restored'` (not `'stale_version'`) so the client reloads instead
/// of retrying, and the editor shows "this project was restored from a snapshot"
/// rather than a conflict dialog it cannot resolve.
model Snapshot {
  id              String       @id @default(cuid())
  projectId       String       @map("project_id")
  createdById     String?      @map("created_by_id")
  name            String
  description     String?
  kind            SnapshotKind @default(manual)
  /// The full IR blob produced by packages/schema-model.
  ir              Json
  /// IR format version, so an old snapshot can be up-converted on read.
  irSchemaVersion Int          @default(1) @map("ir_schema_version")
  /// The engine PLUGIN version the blob's `engineProps` were written under (doc 03 §15.2).
  /// Restore, diff-against-live and migration generation compare it with the registered engine
  /// and REFUSE across a major difference. Without it, restoring a March snapshot after a June
  /// major bump writes rows that no subsequent edit can save, because every write re-parses
  /// `engineProps` through a `.strict()` schema that no longer models those keys.
  enginePluginVersion String   @map("engine_plugin_version")
  createdAt       DateTime     @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt       DateTime     @updatedAt @map("updated_at") @db.Timestamptz(6)

  project   Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  createdBy User?   @relation(fields: [createdById], references: [id], onDelete: SetNull)

  @@index([projectId, createdAt(sort: Desc)])
  @@map("snapshots")
}

// ===========================================================================
// PERMISSIONS  (spec section 5, conventions C5)
// ===========================================================================

/// Built-in roles (organizationId = null) and org-defined custom roles live in
/// one table so the resolver has exactly one code path.
model Role {
  /// Built-in roles have FIXED ids, constant across dev, CI, staging and
  /// production — see migration 0003. `access_grants.role_id` is a real FK to
  /// them, so environment-varying ids would make seed data, fixtures and any
  /// exported grant set non-portable.
  id             String           @id @default(cuid())
  /// Null = built-in, visible to every org.
  organizationId String?          @map("organization_id")
  /// Stable machine key. Built-ins: manager | editor | documenter | commenter |
  /// viewer. Custom roles get a slug generated from the name.
  key            String
  name           String
  description    String?
  /// C5 atoms as strings, validated on write by `permissionAtomSchema` in
  /// packages/contracts, with `closeAtoms()` (doc 05 R1) applied first. NOT a
  /// PostgreSQL enum array: `ALTER TYPE … ADD VALUE` cannot be used in the
  /// transaction that added the value, so adding an atom and seeding it into a role
  /// would need two deploys. One source of truth, in contracts, where the API
  /// payload type already lives.
  atoms          String[]         @default([])
  isBuiltIn      Boolean          @default(false) @map("is_built_in")
  /// Retirement, not revocation. An archived role is **hidden from every role picker** and
  /// cannot be attached to a new or updated grant; grants that already use it keep working
  /// unchanged. It is deliberately NOT a liveness predicate (doc 05 R12 does not read it):
  /// making a checkbox silently revoke access for everyone holding the role is a mass
  /// permission change with no audit trail per affected subject and no way to preview it, and
  /// it would put a third join predicate on the resolver's hot query. To remove access, remove
  /// the grants — which is also what the delete path forces, since `access_grants.role_id` is
  /// `NO ACTION DEFERRABLE` (§8.6) and the role service refuses to delete a role while grants
  /// reference it, offering Archive instead.
  isArchived     Boolean          @default(false) @map("is_archived")
  createdAt      DateTime         @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt      DateTime         @updatedAt @map("updated_at") @db.Timestamptz(6)

  organization   Organization?   @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  grants         AccessGrant[]
  accessRequests AccessRequest[] @relation("AccessRequestRequestedRole")

  @@index([organizationId])
  @@map("roles")
}

/// The single sharing primitive. No real FKs on resourceId / principalId —
/// see section 4 for exactly what integrity that costs and how it is bought back.
model AccessGrant {
  id            String            @id @default(cuid())
  /// C6 — denormalised tenancy so a resolve never needs a join, and so the
  /// offboarding delete in section 4.3 is one indexed statement.
  organizationId String           @map("organization_id")
  /// C6. For resourceType = project this equals resourceId (CHECK enforced).
  projectId     String            @map("project_id")
  resourceType  ResourceType      @map("resource_type")
  resourceId    String            @map("resource_id")
  principalType PrincipalType     @map("principal_type")
  /// users.id | user_groups.id | lowercased email | share_links.id
  principalId   String            @map("principal_id")
  roleId        String            @map("role_id")
  /// Grant modifiers. Doc 05 R7: ADDITIVE ONLY. The effective atom set of a grant
  /// is `role.atoms ∪ { 'ai:use' if canUseAi } ∪ { 'field:viewRestricted' if
  /// canViewRestricted }`. A toggle can add an atom, never remove one — so a custom
  /// role containing `ai:use` grants AI whatever the toggle says, and the UI renders
  /// the toggle checked-and-disabled in that case. No built-in role contains either
  /// atom (migration 0003), so for the normal case the toggle IS the source.
  ///
  /// `ai:use` is further ANDed with the project kill switch
  /// `projects.settings.ai.enabled` at the call site; permission does not override
  /// a project with AI turned off.
  canUseAi          Boolean       @default(false) @map("can_use_ai")
  /// Doc 05 R8. Symmetric with canUseAi, and the only way to see restricted fields:
  /// no built-in role carries `field:viewRestricted`, and forcing every org to author
  /// a custom role to unhide one salary column fails spec section 8's own workflow 2.
  canViewRestricted Boolean       @default(false) @map("can_view_restricted")
  /// Free text shown in the "Who has access" dialog ("contractor until Q3").
  note          String?
  createdById   String?           @map("created_by_id")
  /// Enforced in SQL on every resolve (`expires_at IS NULL OR expires_at > now()`),
  /// NOT by the sweep job — see section 3.2.1.
  expiresAt     DateTime?         @map("expires_at") @db.Timestamptz(6)
  createdAt     DateTime          @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt     DateTime          @updatedAt @map("updated_at") @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  project    Project      @relation(fields: [projectId], references: [id], onDelete: Cascade)
  /// NoAction + DEFERRABLE INITIALLY DEFERRED in 0002 (§8.6), for the same reason as
  /// the other four: deleting an organization cascades `roles` AND (through
  /// `projects`) `access_grants`, and `roles` is created first, so a plain Restrict
  /// here fires mid-cascade. "A custom role in use cannot be deleted" is enforced in
  /// the role service — which is also where `isArchived` lives, and archiving is what
  /// the UI should offer instead of deleting.
  role       Role         @relation(fields: [roleId], references: [id], onDelete: NoAction)
  /// Doc 05 calls this principal "the grantor" and it is the `granted_by` of the audit row.
  /// One name, this one.
  createdBy  User?        @relation(fields: [createdById], references: [id], onDelete: SetNull)
  invitation Invitation?

  @@unique([resourceType, resourceId, principalType, principalId])
  /// THE permission hot path: every grant that can apply inside one project.
  @@index([projectId, principalType, principalId])
  /// "What has this user/group/link been given, anywhere" — the projects list, and
  /// the offboarding delete narrowed by organization_id.
  @@index([principalType, principalId])
  /// "Who has access to this resource" — the sharing dialog.
  @@index([projectId, resourceType, resourceId])
  @@index([roleId])
  @@map("access_grants")
}

/// View-only, expiring, password-protected, revocable link. The link itself is a
/// *principal*: its scope and role live in the AccessGrant whose principalId is this
/// row's id, so share-link sessions go through the same resolver (spec section 5).
/// There is no second copy of the scope here — `access_grants_one_per_share_link_uq`
/// makes that grant unique and mandatory.
///
/// **Revocation**, in one transaction: set `revoked_at`, **delete the grant**, write an
/// audit row with the grant's before-image, bump `projects.perm_generation`. Two
/// independent reasons the link stops working, because one of them failing silently is
/// how a revoked link keeps working: doc 05 R12.3 makes link liveness
/// `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())` — checked on
/// every request, not by a sweep — and the deleted grant means the resolver finds
/// nothing even if that predicate were ever bypassed. The history of who was given
/// what lives in `audit_log`, which is where a compliance reader looks anyway.
///
/// The visitor's stateless `sl_session` cookie is not revoked and does not need to be:
/// it authenticates a principal whose grant no longer resolves, so the next request
/// 404s. **Expiry** needs no sweep for the same reason — it is a SQL predicate, and it
/// caps the cached permission map's `validUntil`.
model ShareLink {
  id           String    @id @default(cuid())
  projectId    String    @map("project_id")
  /// Human label shown in the "Who has access" dialog.
  label        String?
  /// sha256 of the URL token.
  tokenHash    String    @unique @map("token_hash")
  /// argon2id hash of the optional password.
  passwordHash String?   @map("password_hash")
  createdById  String?   @map("created_by_id")
  expiresAt    DateTime? @map("expires_at") @db.Timestamptz(6)
  revokedAt    DateTime? @map("revoked_at") @db.Timestamptz(6)
  /// Written fire-and-forget AFTER the response, never inside the request's
  /// transaction (doc 05 section 7.12 step 3). A share link is a single hot row; an
  /// in-transaction counter bump would serialise every visitor behind one row lock.
  lastAccessedAt DateTime? @map("last_accessed_at") @db.Timestamptz(6)
  accessCount    Int       @default(0) @map("access_count")
  createdAt    DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt    DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  project   Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  createdBy User?   @relation(fields: [createdById], references: [id], onDelete: SetNull)

  @@index([projectId, revokedAt])
  @@map("share_links")
}

/// "Request access" from a user who hit a 403.
model AccessRequest {
  id              String              @id @default(cuid())
  projectId       String              @map("project_id")
  resourceType    ResourceType        @map("resource_type")
  resourceId      String              @map("resource_id")
  requesterId     String              @map("requester_id")
  /// Role the requester asked for; the approver may override. A real FK, so the
  /// role picker and the request carry the same value.
  requestedRoleId String?             @map("requested_role_id")
  message         String?
  status          AccessRequestStatus @default(pending)
  decidedById     String?             @map("decided_by_id")
  decidedAt       DateTime?           @map("decided_at") @db.Timestamptz(6)
  denyReason      String?             @map("deny_reason")
  createdAt       DateTime            @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt       DateTime            @updatedAt @map("updated_at") @db.Timestamptz(6)

  project       Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  requester     User    @relation("AccessRequestRequestedBy", fields: [requesterId], references: [id], onDelete: Cascade)
  decidedBy     User?   @relation("AccessRequestDecidedBy", fields: [decidedById], references: [id], onDelete: SetNull)
  requestedRole Role?   @relation("AccessRequestRequestedRole", fields: [requestedRoleId], references: [id], onDelete: SetNull)

  @@index([projectId, status, createdAt])
  @@index([requesterId, status])
  /// Serves `purge_polymorphic_refs`, which deletes requests for a deleted area or
  /// entity. Without it that DELETE is a sequential scan once per deleted row, since
  /// the pending partial unique does not cover approved/denied/withdrawn rows.
  @@index([resourceType, resourceId])
  @@map("access_requests")
}

/// Org invite and/or resource invite in one row. If accessGrantId is set, the
/// invite carries a pending email_invite grant that is rewritten to a user grant
/// on acceptance.
model Invitation {
  id               String    @id @default(cuid())
  organizationId   String    @map("organization_id")
  /// Lowercased.
  email            String
  orgRole          OrgRole   @default(member) @map("org_role")
  accessGrantId    String?   @unique @map("access_grant_id")
  invitedById      String?   @map("invited_by_id")
  tokenHash        String    @unique @map("token_hash")
  expiresAt        DateTime  @map("expires_at") @db.Timestamptz(6)
  acceptedAt       DateTime? @map("accepted_at") @db.Timestamptz(6)
  acceptedByUserId String?   @map("accepted_by_user_id")
  revokedAt        DateTime? @map("revoked_at") @db.Timestamptz(6)
  createdAt        DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt        DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  accessGrant  AccessGrant? @relation(fields: [accessGrantId], references: [id], onDelete: Cascade)
  invitedBy    User?        @relation("InvitationInvitedBy", fields: [invitedById], references: [id], onDelete: SetNull)
  acceptedBy   User?        @relation("InvitationAcceptedBy", fields: [acceptedByUserId], references: [id], onDelete: SetNull)

  @@index([organizationId, acceptedAt])
  @@index([email])
  @@map("invitations")
}

// ===========================================================================
// LOGS AND NOTIFICATIONS
// ===========================================================================

/// Product-facing "what happened in this project" feed. Lossy by design,
/// prunable, denormalised so it renders without joining anything.
model ActivityLog {
  id          String      @id @default(cuid())
  projectId   String      @map("project_id")
  actorUserId String?     @map("actor_user_id")
  /// Snapshot of the actor's display name at event time, so a deleted user still
  /// reads as "Ada Lovelace" instead of "someone".
  actorName   String?     @map("actor_name")
  /// Dotted verb, open set: "entity.created", "field.renamed", "snapshot.restored".
  action      String
  targetType  TargetType? @map("target_type")
  targetId    String?     @map("target_id")
  targetName  String?     @map("target_name")
  metadata    Json        @default("{}")
  createdAt   DateTime    @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime    @updatedAt @map("updated_at") @db.Timestamptz(6)

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  actor   User?   @relation(fields: [actorUserId], references: [id], onDelete: SetNull)

  @@index([projectId, createdAt(sort: Desc)])
  @@index([projectId, targetType, targetId, createdAt(sort: Desc)])
  @@index([actorUserId, createdAt(sort: Desc)])
  @@map("activity_log")
}

/// Security/compliance trail. Append-only, longer retention, never pruned by a
/// project OR an organization deletion — both FKs are SetNull and both names are
/// denormalised. Key decision 12 says a trail that a deletion can erase is not a
/// trail; a cascade on `organization_id` would let a background purge job destroy
/// every grant change, every 2FA change and the record of the deletion itself with
/// nobody in the room. Erasure is a retention policy, not a referential action: a
/// separate job deletes `audit_log WHERE organization_id IS NULL AND created_at <
/// now() - :retention`, and that job is reviewable.
model AuditLog {
  id             String   @id @default(cuid())
  organizationId String?  @map("organization_id")
  /// Preserved after the org row is gone, the way actorEmail is after the user.
  organizationName String? @map("organization_name")
  projectId      String?  @map("project_id")
  actorUserId    String?  @map("actor_user_id")
  /// Preserved even after the user row is gone.
  actorEmail     String?  @map("actor_email")
  action         String
  resourceType   String?  @map("resource_type")
  resourceId     String?  @map("resource_id")
  ip             String?
  userAgent      String?  @map("user_agent")
  metadata       Json     @default("{}")
  createdAt      DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt      DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  organization Organization? @relation(fields: [organizationId], references: [id], onDelete: SetNull)
  project      Project?      @relation(fields: [projectId], references: [id], onDelete: SetNull)
  actor        User?         @relation(fields: [actorUserId], references: [id], onDelete: SetNull)

  @@index([organizationId, createdAt(sort: Desc)])
  @@index([organizationId, action, createdAt(sort: Desc)])
  @@index([resourceType, resourceId, createdAt(sort: Desc)])
  @@map("audit_log")
}

model Notification {
  id             String           @id @default(cuid())
  userId         String           @map("user_id")
  actorUserId    String?          @map("actor_user_id")
  organizationId String?          @map("organization_id")
  projectId      String?          @map("project_id")
  /// Dotted verb, open set, exactly like `activity_log.action`: "org.invited",
  /// "resource.shared", "comment.mentioned", "comment.replied",
  /// "access.requested", "access.decided", "ai.job_finished", "export.ready".
  /// Validated by `notificationTypeSchema` (a zod union) in packages/contracts.
  /// A String because the set grows in every phase and each addition would
  /// otherwise be an `ALTER TYPE … ADD VALUE` with a two-deploy constraint.
  type           String
  title          String
  body           String?
  /// Relative in-app URL to open.
  url            String?
  data           Json             @default("{}")
  readAt         DateTime?        @map("read_at") @db.Timestamptz(6)
  createdAt      DateTime         @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt      DateTime         @updatedAt @map("updated_at") @db.Timestamptz(6)

  user         User          @relation("NotificationRecipient", fields: [userId], references: [id], onDelete: Cascade)
  actor        User?         @relation("NotificationActor", fields: [actorUserId], references: [id], onDelete: SetNull)
  organization Organization? @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  project      Project?      @relation(fields: [projectId], references: [id], onDelete: SetNull)

  @@index([userId, createdAt(sort: Desc)])
  @@map("notifications")
}

// ===========================================================================
// BACKGROUND WORK  (spec section 2, 6.2, 6.4)
// Two small tables that exist because two spec requirements have no other home.
// Both are created in 0001 and stay empty until their phase.
// ===========================================================================

/// Spec 6.2: "Draft docs for undocumented fields (runs as a background job; user
/// reviews and accepts or rejects each suggestion)." A job that wrote `docs`
/// directly would have already accepted them. This is the queue the reviewer drains:
/// accepting copies `content` / `structured` onto the `docs` row, rejecting just
/// stamps the status.
model DocDraft {
  id           String         @id @default(cuid())
  projectId    String         @map("project_id")
  targetType   TargetType     @map("target_type")
  targetId     String         @map("target_id")
  /// Same TipTap envelope as `docs.content`, same default, same zod schema.
  content      Json           @default("{\"type\":\"doc\"}")
  structured   Json?
  status       DocDraftStatus @default(pending)
  /// BullMQ job id, for "which run produced this".
  jobId        String?        @map("job_id")
  createdById  String?        @map("created_by_id")
  reviewedById String?        @map("reviewed_by_id")
  reviewedAt   DateTime?      @map("reviewed_at") @db.Timestamptz(6)
  createdAt    DateTime       @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt    DateTime       @updatedAt @map("updated_at") @db.Timestamptz(6)

  project    Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  createdBy  User?   @relation("DocDraftCreatedBy", fields: [createdById], references: [id], onDelete: SetNull)
  reviewedBy User?   @relation("DocDraftReviewedBy", fields: [reviewedById], references: [id], onDelete: SetNull)

  /// The review queue: "pending drafts in this project".
  @@index([projectId, status])
  /// One draft per target at a time, so a re-run replaces rather than piles up.
  @@unique([targetType, targetId, status])
  @@map("doc_drafts")
}

/// Spec section 2 (exports are BullMQ jobs against S3) and 6.4 (DDL, JSON, PNG/SVG,
/// Markdown/PDF). Without this row `export.ready` has nothing to link to and
/// `notifications.url` has nothing to resolve.
///
/// DDL **import** has no table on purpose: it is stateless. Parse-and-preview is one
/// request that returns the preview and the unsupported-statement report to the
/// client; applying it is a second request carrying the same DDL. Nothing needs to
/// survive between them, so nothing is stored.
model ExportJob {
  id            String    @id @default(cuid())
  projectId     String    @map("project_id")
  requestedById String?   @map("requested_by_id")
  /// "ddl" | "ir-json" | "png" | "svg" | "markdown" | "pdf" — an open set, since a
  /// future engine's exporter adds its own.
  format        String
  status        JobStatus @default(queued)
  /// S3 object key. Null until the job finishes.
  storageKey    String?   @map("storage_key")
  sizeBytes     Int?      @map("size_bytes")
  error         String?
  /// The object-storage lifecycle rule deletes the file at this time; the row is
  /// swept with it.
  expiresAt     DateTime? @map("expires_at") @db.Timestamptz(6)
  createdAt     DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt     DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  project     Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  requestedBy User?   @relation(fields: [requestedById], references: [id], onDelete: SetNull)

  @@index([projectId, createdAt(sort: Desc)])
  @@index([expiresAt])
  @@map("export_jobs")
}
```

---

## 2. What Prisma cannot express — the companion SQL migration

Everything below goes in **one** hand-written migration,
`prisma/migrations/0002_constraints_and_partial_indexes/migration.sql`, applied
immediately after the generated `0001_init`. Nothing here is optional: several of these
are the only thing standing between the app and corrupt data.

```sql
-- =========================================================================
-- 0002_constraints_and_partial_indexes
-- =========================================================================

-- -------------------------------------------------------------------------
-- 2.1 Case-insensitive, soft-delete-aware uniqueness
-- -------------------------------------------------------------------------

-- Email identity. The database, not a convention, owns the normalisation: an
-- OAuth callback that hands us Bob@Example.com must not be able to create a
-- second account for the same human, and the invitation lookup must find the
-- same row the login found. This replaces the Prisma @unique on users.email.
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

ALTER TABLE invitations
  ADD CONSTRAINT invitations_email_lower_ck CHECK (email = lower(email));
ALTER TABLE verification_tokens
  ADD CONSTRAINT verification_tokens_email_lower_ck CHECK (email = lower(email));

CREATE UNIQUE INDEX organizations_slug_uq
  ON organizations (lower(slug)) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX projects_slug_uq
  ON projects (workspace_id, lower(slug)) WHERE deleted_at IS NULL;

-- Live projects of an org, newest first. Partial so the soft-deleted tail never
-- enters the index.
CREATE INDEX projects_live_org_idx
  ON projects (organization_id, updated_at DESC) WHERE deleted_at IS NULL;

-- -------------------------------------------------------------------------
-- 2.2 Schema-object naming rules (case-insensitive, nullable-parent aware)
-- coalesce(<nullable text>, '') is IMMUTABLE, so one index replaces the usual
-- pair of partial indexes.
-- -------------------------------------------------------------------------
CREATE UNIQUE INDEX namespaces_name_uq
  ON namespaces (project_id, lower(name));

CREATE UNIQUE INDEX namespaces_one_default_uq
  ON namespaces (project_id) WHERE is_default;

CREATE UNIQUE INDEX entities_name_uq
  ON entities (project_id, coalesce(namespace_id, ''), lower(name));

CREATE UNIQUE INDEX custom_types_name_uq
  ON custom_types (project_id, coalesce(namespace_id, ''), lower(name));

-- A field name is unique among its siblings: among the entity's top-level
-- fields when parent_field_id IS NULL, among the parent's children otherwise.
CREATE UNIQUE INDEX fields_name_uq
  ON fields (entity_id, coalesce(parent_field_id, ''), lower(name));

-- Index and constraint names are unique per namespace in PostgreSQL, but the
-- IR is engine-neutral, so we enforce the weaker per-project rule and let the
-- engine validator enforce the stricter one.
CREATE UNIQUE INDEX indexes_name_uq
  ON indexes (project_id, lower(name));

CREATE UNIQUE INDEX constraints_name_uq
  ON constraints (project_id, lower(name)) WHERE name IS NOT NULL;

-- -------------------------------------------------------------------------
-- 2.3 Field nesting integrity (section 9)
-- -------------------------------------------------------------------------
-- There is no `depth` column and no depth CHECK. See section 9.2: a materialised
-- depth is a derived value the application has to maintain correctly, and it was
-- the single point of failure for the cycle argument. The ceiling is enforced in
-- createField / reparentField by the descendant check those paths already run.
ALTER TABLE fields
  ADD CONSTRAINT fields_not_self_ck     CHECK (parent_field_id IS DISTINCT FROM id),
  ADD CONSTRAINT fields_position_ck     CHECK (position >= 0);

-- A nested field must live in the same entity as its parent. Prisma's generated
-- single-column FK cannot say this; a composite FK can. Target is the
-- @@unique([id, entityId]) index Prisma already created on fields.
ALTER TABLE fields
  ADD CONSTRAINT fields_parent_same_entity_fk
  FOREIGN KEY (parent_field_id, entity_id)
  REFERENCES fields (id, entity_id)
  ON DELETE CASCADE;

-- -------------------------------------------------------------------------
-- 2.4 Index / constraint column integrity
-- -------------------------------------------------------------------------
ALTER TABLE index_columns
  ADD CONSTRAINT index_columns_target_ck CHECK (num_nonnulls(field_id, expression) = 1),
  ADD CONSTRAINT index_columns_dir_ck    CHECK (direction IN ('asc', 'desc')),
  ADD CONSTRAINT index_columns_ordinal_ck CHECK (ordinal >= 0);

ALTER TABLE constraint_columns
  ADD CONSTRAINT constraint_columns_ordinal_ck CHECK (ordinal >= 0);

ALTER TABLE link_endpoints
  ADD CONSTRAINT link_endpoints_ordinal_ck CHECK (ordinal >= 0),
  ADD CONSTRAINT link_endpoints_distinct_ck CHECK (source_field_id <> target_field_id);

-- -------------------------------------------------------------------------
-- 2.5 access_grants — the polymorphism guard rails (section 4)
-- -------------------------------------------------------------------------
-- A project-scoped grant must point at its own project.
ALTER TABLE access_grants
  ADD CONSTRAINT access_grants_project_self_ck
  CHECK (resource_type <> 'project' OR resource_id = project_id);

-- An email_invite principal is a normalised email address, never an id.
ALTER TABLE access_grants
  ADD CONSTRAINT access_grants_email_shape_ck
  CHECK (
    principal_type <> 'email_invite'
    OR (principal_id = lower(principal_id)
        AND principal_id ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
  );

-- A cuid principal is a cuid, not an email typed into the wrong box. This is a
-- shape smoke-test, NOT an integrity constraint: a user grant carrying a group id
-- passes it and still fails closed at lookup. Widened past cuid()'s exact alphabet
-- and length so that switching the id generator does not start rejecting every new
-- grant with an error message that points at a regex instead of at the generator.
ALTER TABLE access_grants
  ADD CONSTRAINT access_grants_id_shape_ck
  CHECK (
    principal_type NOT IN ('user', 'group', 'share_link')
    OR principal_id ~ '^[A-Za-z0-9_-]{16,64}$'
  );

-- A share link is one link to one resource. Without this you can hand the same
-- token two different scopes.
CREATE UNIQUE INDEX access_grants_one_per_share_link_uq
  ON access_grants (principal_id) WHERE principal_type = 'share_link';

-- Expiring grants are swept by a job; index the tail it scans.
CREATE INDEX access_grants_expiring_idx
  ON access_grants (expires_at) WHERE expires_at IS NOT NULL;

-- -------------------------------------------------------------------------
-- 2.6 docs / comments / access_requests
-- -------------------------------------------------------------------------
-- The project case only. For area/entity/field targets the writer DERIVES
-- project_id from the target row (sections 5 and 6) — the database cannot check a
-- polymorphic parent without a trigger per target type.
ALTER TABLE docs
  ADD CONSTRAINT docs_project_self_ck
  CHECK (target_type <> 'project' OR target_id = project_id);

ALTER TABLE comments
  ADD CONSTRAINT comments_project_self_ck
  CHECK (target_type <> 'project' OR target_id = project_id),
  ADD CONSTRAINT comments_resolved_pair_ck
  CHECK ((resolved_at IS NULL) = (resolved_by_id IS NULL)),
  ADD CONSTRAINT comments_root_not_child_ck
  CHECK (parent_id IS NOT NULL OR root_id = id);

-- One open request per (resource, requester). Re-requesting after a denial is
-- allowed; spamming a manager with five pending rows is not.
CREATE UNIQUE INDEX access_requests_pending_uq
  ON access_requests (resource_type, resource_id, requester_id)
  WHERE status = 'pending';

-- Unread badge + notification centre.
CREATE INDEX notifications_unread_idx
  ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;

-- Open threads on a target: what the comment sidebar actually asks for.
CREATE INDEX comments_open_target_idx
  ON comments (target_type, target_id, created_at) WHERE resolved_at IS NULL;

-- -------------------------------------------------------------------------
-- 2.7 roles — built-in vs custom uniqueness
-- -------------------------------------------------------------------------
CREATE UNIQUE INDEX roles_builtin_key_uq
  ON roles (key) WHERE organization_id IS NULL;

CREATE UNIQUE INDEX roles_custom_key_uq
  ON roles (organization_id, key) WHERE organization_id IS NOT NULL;

CREATE UNIQUE INDEX roles_custom_name_uq
  ON roles (organization_id, lower(name)) WHERE organization_id IS NOT NULL;

-- A built-in role is not editable per-org; belt and braces.
ALTER TABLE roles
  ADD CONSTRAINT roles_builtin_global_ck
  CHECK (is_built_in = (organization_id IS NULL));

-- -------------------------------------------------------------------------
-- 2.8 Orphan sweeping for the polymorphic tables (section 4/5/6)
-- One trigger function, three triggers. This is the price of (targetType,
-- targetId) and it is paid here, in the database, not in every service that
-- happens to delete an area.
-- -------------------------------------------------------------------------
CREATE FUNCTION purge_polymorphic_refs() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM docs
    WHERE target_type::text = TG_ARGV[0] AND target_id = OLD.id;
  DELETE FROM comments
    WHERE target_type::text = TG_ARGV[0] AND target_id = OLD.id;
  DELETE FROM access_grants
    WHERE resource_type::text = TG_ARGV[0] AND resource_id = OLD.id;
  DELETE FROM access_requests
    WHERE resource_type::text = TG_ARGV[0] AND resource_id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER areas_purge_refs    AFTER DELETE ON areas
  FOR EACH ROW EXECUTE FUNCTION purge_polymorphic_refs('area');
CREATE TRIGGER entities_purge_refs AFTER DELETE ON entities
  FOR EACH ROW EXECUTE FUNCTION purge_polymorphic_refs('entity');
CREATE TRIGGER fields_purge_refs   AFTER DELETE ON fields
  FOR EACH ROW EXECUTE FUNCTION purge_polymorphic_refs('field');

-- A share link is a PRINCIPAL, not a resource, so purge_polymorphic_refs (which
-- keys on resource_type) does not cover it. Hard-deleting a share_links row would
-- otherwise leave a grant whose principal does not exist.
CREATE FUNCTION purge_share_link_grants() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM access_grants
    WHERE principal_type = 'share_link' AND principal_id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER share_links_purge_grants AFTER DELETE ON share_links
  FOR EACH ROW EXECUTE FUNCTION purge_share_link_grants();

-- -------------------------------------------------------------------------
-- 2.9 Parents that stop making sense when their last child dies
-- An index with zero columns is not an index; a keyed constraint with no columns
-- and no expression is not a constraint. Deleting a field must take them with it.
--
-- Two plain functions, four lines each, no dynamic SQL. The earlier version was a
-- generic format()/EXECUTE/TG_ARGV[0..2] function serving three call sites of three
-- different shapes: no cached plan, the hardest thing in the file to read at 3am,
-- and TG_ARGV[2] was a raw SQL-fragment escape hatch. Same total line count, and
-- each function now reads as exactly what it does.
--
-- There is deliberately NO purge trigger on link_endpoints. A link with zero
-- endpoints is a legal entity-level link (see the Link model comment and doc 04
-- section 8.6), not an edge to nowhere.
-- -------------------------------------------------------------------------
CREATE FUNCTION purge_empty_index() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM indexes i
    WHERE i.id = OLD.index_id
      AND NOT EXISTS (SELECT 1 FROM index_columns c WHERE c.index_id = i.id);
  RETURN OLD;
END;
$$;

CREATE TRIGGER index_columns_purge_index AFTER DELETE ON index_columns
  FOR EACH ROW EXECUTE FUNCTION purge_empty_index();

-- The predicate is ENGINE-NEUTRAL: `expression IS NULL`, not a list of PostgreSQL
-- constraint kinds. A constraint with no columns and no expression is meaningless in
-- any paradigm, and the constraints that legitimately have no columns (CHECK,
-- EXCLUDE) are exactly the ones carrying an expression. Enumerating
-- ('primary_key','unique','exclusion') here would put engine vocabulary in a core
-- migration, which is the thing C4 exists to prevent, and a future engine that spells
-- its keyed kind differently would silently leave zero-column constraints behind.
CREATE FUNCTION purge_empty_keyed_constraint() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM constraints p
    WHERE p.id = OLD.constraint_id
      AND p.expression IS NULL
      AND NOT EXISTS (SELECT 1 FROM constraint_columns c WHERE c.constraint_id = p.id);
  RETURN OLD;
END;
$$;

CREATE TRIGGER constraint_columns_purge_constraint AFTER DELETE ON constraint_columns
  FOR EACH ROW EXECUTE FUNCTION purge_empty_keyed_constraint();

-- -------------------------------------------------------------------------
-- 2.10 Deferred referential actions (section 8.6)
-- Five FKs must not fire while a cascade above them is still running. Prisma
-- declares them `NoAction`; Prisma cannot express DEFERRABLE, so the deferral is
-- added here. Without this, whether `DELETE FROM organizations` or a project purge
-- succeeds depends on the order Prisma happened to emit ADD CONSTRAINT in 0001 —
-- and for namespaces vs entities that order is against us.
-- -------------------------------------------------------------------------
ALTER TABLE projects
  DROP CONSTRAINT projects_workspace_id_fkey,
  ADD CONSTRAINT projects_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE entities
  DROP CONSTRAINT entities_namespace_id_fkey,
  ADD CONSTRAINT entities_namespace_id_fkey
    FOREIGN KEY (namespace_id) REFERENCES namespaces(id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE custom_types
  DROP CONSTRAINT custom_types_namespace_id_fkey,
  ADD CONSTRAINT custom_types_namespace_id_fkey
    FOREIGN KEY (namespace_id) REFERENCES namespaces(id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE fields
  DROP CONSTRAINT fields_custom_type_id_fkey,
  ADD CONSTRAINT fields_custom_type_id_fkey
    FOREIGN KEY (custom_type_id) REFERENCES custom_types(id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- Deleting an organization cascades `roles` and, through `projects`,
-- `access_grants`. `roles` is created first, so its cascade fires first.
ALTER TABLE access_grants
  DROP CONSTRAINT access_grants_role_id_fkey,
  ADD CONSTRAINT access_grants_role_id_fkey
    FOREIGN KEY (role_id) REFERENCES roles(id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
```

Four notes on this migration:

1. **`prisma migrate dev` will try to drop all of it.** Prisma diffs the database
   against `schema.prisma`; anything it cannot see there is "extra" and gets a
   `DROP`. The rule for this repo: **always `prisma migrate dev --create-only`**, read
   the generated SQL, delete any `DROP INDEX` / `DROP CONSTRAINT` / `DROP TRIGGER`
   touching the objects above, then apply. Back it with a cheap guard test
   (`pnpm db:verify`) that asserts every named object in 0002 exists in
   `pg_indexes` / `pg_constraint` / `pg_trigger`. Without that test, someone deletes
   the field-name uniqueness rule in month three and nobody notices.
2. There is deliberately no per-workspace ordering index: `projects_live_org_idx` plus
   the Prisma `@@index([workspaceId, deletedAt])` cover every list query we issue.
3. Row-level triggers fire once per deleted row, so purging a 300-table project would
   run `purge_polymorphic_refs` once per area, entity and field, and
   `purge_empty_index` / `purge_empty_keyed_constraint` once per deleted child row —
   tens of thousands of statements inside one transaction, for tables that are about
   to be deleted anyway. Project purge therefore deletes the trigger-bearing tables
   **by `project_id` first**, in dependency order, so every trigger finds nothing.
   The full statement list is in §8.5 and it is not optional.
4. `db:verify` must assert the **deferrability** of the five constraints in §2.10, not
   just their existence — a `prisma migrate dev` that recreates them as plain
   `NO ACTION` leaves a database that passes an existence check and fails the first
   org deletion.

---

## 3. Indexing strategy

Every index, the query it exists for, and nothing else. An index without a named query
is an index nobody maintains.

### 3.1 Hot path: load a whole project's schema

This is the request that must never get slow — opening a 300-table project. The loader
does **no joins**. It issues eleven flat `WHERE project_id = $1` selects in parallel and
assembles the IR in memory (C3, C6). That is the entire reason `project_id` is
denormalised onto the grandchild tables.

| Index | Query |
|---|---|
| `namespaces(project_id)` | `SELECT … FROM namespaces WHERE project_id = $1` |
| `areas(project_id, position)` | areas in sidebar/legend order, no sort node |
| `entities(project_id)` | all entity cards |
| `fields(project_id)` | all fields, regrouped client-side by `entity_id` |
| `links(project_id)` | all edges |
| `link_endpoints(project_id)` | all FK column pairs |
| `indexes(project_id)`, `index_columns(project_id)` | index badges |
| `constraints(project_id)`, `constraint_columns(project_id)` | PK/unique badges |
| `custom_types(project_id)` | type picker + enum badges |
| `docs(project_id, target_type)` | `SELECT id, target_type, target_id, plain_text FROM docs WHERE project_id = $1` — populates `doc` on `Area`, `Entity` and `Field`, the only three IR types that carry one (doc 04 §2.2; `doc` is deliberately *not* on `IrBase`, because `TargetType` admits only those three plus `project`, and a project doc has no IR object to hang on). The rich `content` JSON is deliberately **not** selected: `DocRef` is `{ id, excerpt }` with the excerpt capped at `DOC_EXCERPT_CHARS` (200), and the full TipTap document is fetched when the docs panel opens |

**The load is a projection, not `SELECT *`.** A 300-entity project is 10,000–15,000
`fields` rows plus several thousand index and constraint columns, each carrying an
`engine_props` JSONB the canvas never renders, hydrated into JS objects and then walked
row by row by `VisibilityFilter` on every request and (Phase 4) per connected socket. The
initial load selects only what the canvas and the IR need:

```sql
-- fields: the whole table's worth of rows, none of the wide columns
SELECT id, entity_id, parent_field_id, name, data_type, custom_type_id, type_args,
       type_dimensions, position, is_nullable, is_restricted, is_pii, is_deprecated,
       version
  FROM fields WHERE project_id = $1;
```

`engine_props`, `created_at` and `updated_at` are fetched per object when the property
panel opens one. That roughly halves the payload and is the difference between the
300-table target scaling and not. Same rule for `entities`, `indexes`, `constraints` and
`links`.

Secondary, per-object reads (right panel, lazy loads):

| Index | Query |
|---|---|
| `entities(project_id, area_id)` | "show only the Billing area" and area-scoped visibility filtering |
| `entities(namespace_id)` | namespace tree; also the FK-restrict check when dropping a namespace |
| `entities(project_id, name)` | command palette jump-to-entity, canvas search |
| `fields(entity_id, position)` | one entity's columns in display order |
| `fields(parent_field_id, position)` | one nesting level's children |
| `fields(custom_type_id)` | "is this enum in use" before allowing a drop, and the rename rewrite that keeps `fields.data_type` honest (§8.3) |
| `indexes(entity_id)`, `constraints(entity_id)`, `constraints(entity_id, kind)` | entity detail panel; `kind` for "find this table's PK" |
| `index_columns(field_id)`, `constraint_columns(field_id)`, `link_endpoints(source_field_id)`, `link_endpoints(target_field_id)` | "what breaks if I delete this column" impact preview |
| `links(source_entity_id)`, `links(target_entity_id)` | highlight-connected-entities on hover; restricted-stub resolution |
| `fields(id, entity_id)` unique | composite FK target (section 9), not a query index |
| `link_endpoints(link_id, ordinal)` unique | composite FK column order |
| `link_endpoints(link_id, source_field_id)` unique | stops a column appearing twice in one FK |

### 3.2 Hot path: resolving permissions for a user

`PermissionResolver` needs, for one `(user, project)`: the user's org role, the user's
group ids, and every grant in that project addressed to the user, to one of those groups,
or (for a link session) to the share link. Three indexed queries, no joins:

```sql
-- 1. org role
SELECT role FROM org_members WHERE organization_id = $org AND user_id = $user;
--    -> org_members(organization_id, user_id) UNIQUE

-- 2. group ids
SELECT group_id FROM group_members WHERE user_id = $user;
--    -> group_members(user_id)

-- 3. every LIVE grant that can apply, in one index range scan per principal
SELECT * FROM access_grants
WHERE project_id = $project
  AND (principal_type, principal_id) IN (('user',$user), ('group',$g1), ('group',$g2), ...)
  AND (expires_at IS NULL OR expires_at > now());
--    -> access_grants(project_id, principal_type, principal_id)
```

Step 1 is not optional and it is not a formality: **a `user` grant is live only if the
user is still an `OrgMember` of the grant's organization** (doc 05 R12.3). If step 1
returns no row, the subject has no access to anything in that org, grants included. That
is what closes the offboarding hole — see §4.3.

| Index | Query |
|---|---|
| `access_grants(project_id, principal_type, principal_id)` | **the** resolver query above |
| `access_grants(principal_type, principal_id)` | "everything this principal was given", used to build the projects list and to invalidate the Redis cache when a group's membership changes |
| `access_grants(role_id)` | "which grants use this custom role" before editing/deleting it; also the `Restrict` FK probe |
| `access_grants(principal_id) WHERE principal_type='share_link'` | token -> grant, one row, for share-link sessions |
| `group_members(user_id)` | step 2 |
| `org_members(organization_id, user_id)` unique | step 1 |
| `org_members(organization_id, role)` | members page, "who are the admins to notify about this access request" |
| `roles(organization_id)` | role picker in the sharing dialog |

### 3.2.1 The cache generation columns

The Redis permission cache is invalidated by **generation counters that live in
PostgreSQL**, not in Redis. Three real columns, added above:

| Column | Bumped by |
|---|---|
| `projects.perm_generation` | every grant write on that project, share-link create/revoke, area create/delete, entity moved between areas, `field.is_restricted` toggled, `restricted_field_mode` changed, project soft-delete/restore |
| `organizations.perm_generation` | custom-role atoms edited or archived, group created/deleted or its grants changed, bulk group-membership change (> 20 users), org soft-delete |
| `users.perm_generation` | that user's org role changed, their group membership changed, deactivation, removal from the org, `email_invite` → `user` grant conversion |

Three counters instead of one is what removes the fan-out problem. A role edit has no
project in scope, and a group membership change touches every project that group can
reach; with a single per-project epoch an implementer reading this section literally would
bump only the project in request scope, and **demoting an admin would leave them admin
indefinitely** on any project quiet enough that no unrelated grant write ever happened.
With three counters, each write bumps exactly one row at the scope where the change
applies, and the key is composed from all three:

```
perm:3:{projectId}:{subjectKey}:{orgGen}.{projectGen}.{subjectGen}
  subjectKey = u:{userId}  |  sl:{shareLinkId}
```

(Doc 05 §9.1 owns the key format and the two siblings, `skel:3:{projectId}:{pg}` and
`orgmem:3:{orgId}:{userId}:{og}.{sg}`; all three are written under doc 01 §4.4's
`${REDIS_KEY_PREFIX}cache:` client prefix.)

**The three counters are read from PostgreSQL on every resolve**, in one round trip returning
three integers, and there is deliberately **no Redis mirror of them**. A mirrored counter with a
short TTL races the revoke: request A misses the mirror and reads generation 42 from Postgres,
the revoke transaction commits 43 and issues a `DEL` that is a no-op because the key is already
absent, then A writes 42 back — and for the length of that TTL every process builds the
pre-revoke cache key and hits the still-present pre-revoke map. A revoked grant that keeps
working is the worst failure this system can have, so the mirror is not worth its saving. The
write path is **mutate + audit row + `perm_generation++` in one transaction → commit → `DEL` the
dependent keys**. Because the counter is committed with the change, a crash or a Redis flush
cannot leave a cached entry reachable: the key it was stored under no longer exists. A Redis
flush therefore *narrows* access (everything recomputes) instead of widening it.

Two rules that follow, both stated because an implementer will otherwise get them wrong:

- **Expiry is a SQL predicate, never a sweep.** The resolver's grant query always carries
  `AND (expires_at IS NULL OR expires_at > now())`, and share-link liveness is
  `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, evaluated on every
  request. `access_grants_expiring_idx` serves a housekeeping job that deletes dead rows;
  it is **not** the enforcement mechanism. Enforcement that depends on a cron means access
  outlives expiry by up to one sweep interval.
- **A cached entry is capped at `min(TTL, nearest expires_at in the resolved set)`.**
  Generation-based invalidation cannot see a clock, so a grant that expires at 10:05
  would otherwise stay cached until some unrelated write bumped a counter. The permission
  map carries `validUntil` for exactly this.

### 3.3 Hot path: listing a user's projects

Two sources, unioned in the service:

```sql
-- a) org member (owner/admin/member) -> every live project in their orgs
SELECT p.* FROM projects p
JOIN org_members m ON m.organization_id = p.organization_id
WHERE m.user_id = $user AND p.deleted_at IS NULL
ORDER BY p.updated_at DESC;
--    -> org_members(user_id)  then  projects_live_org_idx

-- b) guest / externally shared -> projects reached only through a grant
SELECT DISTINCT project_id FROM access_grants
WHERE (principal_type, principal_id) IN (('user',$user), ('group',...));
--    -> access_grants(principal_type, principal_id)
```

| Index | Query |
|---|---|
| `org_members(user_id)` | (a) |
| `projects_live_org_idx` = `projects(organization_id, updated_at DESC) WHERE deleted_at IS NULL` | (a) ordering, partial so the soft-deleted tail is not in the index |
| `projects(organization_id, deleted_at)`, `projects(workspace_id, deleted_at)` | workspace sidebar counts, purge job |
| `access_grants(principal_type, principal_id)` | (b) |
| `projects(engine_id)` | admin/telemetry: "how many projects per engine"; also the migration probe when an engine version is retired |

### 3.4 Hot path: the activity feed

| Index | Query |
|---|---|
| `activity_log(project_id, created_at DESC)` | the project feed, keyset-paginated on `(created_at, id)` |
| `activity_log(project_id, target_type, target_id, created_at DESC)` | "history of this one table", shown in the entity panel |
| `activity_log(actor_user_id, created_at DESC)` | "my recent changes", and the GDPR export |
| `audit_log(organization_id, created_at DESC)` | org security log |
| `audit_log(organization_id, action, created_at DESC)` | "show me every `sharing.grant_created`" |
| `audit_log(resource_type, resource_id, created_at DESC)` | "who changed permissions on this project" |

### 3.5 Everything else

| Index | Query |
|---|---|
| `users_email_uq` = `users(lower(email))` unique | login, OAuth callback, invite matching. The `lower()` is what stops `Bob@Example.com` becoming a second account |
| `users(last_seen_at)` | inactive-user sweep, presence seeding |
| `accounts(provider, provider_account_id)` unique | OAuth callback -> user |
| `accounts(user_id)` | connected-accounts settings page |
| `sessions(refresh_token_hash)` unique | every token refresh |
| `sessions(user_id, family_id, created_at)` | the device list: `DISTINCT ON (family_id) … ORDER BY family_id, created_at DESC` |
| `sessions(user_id, revoked_at)` | "log out other devices" (revoke by user) |
| `sessions(family_id)` | reuse detection: revoke the whole family |
| `sessions(expires_at)`, `verification_tokens(expires_at)` | expiry sweep jobs; for `sessions` this is also what retires rotated rows |
| `verification_tokens(token_hash)` unique | verify / reset / magic-link redemption |
| `verification_tokens(email, purpose)` | rate-limit "how many resets has this address asked for" |
| `recovery_codes(user_id, used_at)` | 2FA fallback |
| `workspaces(organization_id, position)` | sidebar |
| `workspaces(organization_id, slug)` unique | URL routing |
| `docs(target_type, target_id)` unique | the doc for the object the right panel is showing |
| `docs(project_id, target_type)` | documentation-coverage meter, docs-mode site build, AI context assembly |
| `comments(target_type, target_id, created_at)` | comment sidebar |
| `comments_open_target_idx` (partial) | the default "unresolved only" view |
| `comments(root_id, created_at)` | one thread with its replies in one scan |
| `comments(project_id, resolved_at, created_at)` | project-wide "open comments" inbox |
| `comments(parent_id)` | FK cascade probe |
| `saved_queries(project_id, updated_at)` | the query library list |
| `saved_queries(created_by_id)` | "my queries" |
| `saved_queries(tags)` GIN | tag filter |
| `saved_query_entities(entity_id)` | "which saved queries use this table", and hiding queries that touch hidden tables — which only works for queries whose `identifiers_resolved` is true; the rest are project-scope-only by the fail-closed rule on `SavedQuery` |
| `ai_threads(project_id, last_message_at)` | thread list |
| `ai_threads(user_id, last_message_at)` | "my conversations" |
| `ai_messages(thread_id, ordinal)` unique | ordered replay of a thread (C11) |
| `ai_messages(project_id, created_at)` | per-project AI usage and rate-limit accounting |
| `snapshots(project_id, created_at DESC)` | history list, diff picker |
| `share_links(token_hash)` unique | opening a share URL |
| `share_links(project_id, revoked_at)` | "Who has access" dialog |
| `access_requests(project_id, status, created_at)` | manager's pending queue |
| `access_requests(requester_id, status)` | "you have a pending request" banner |
| `access_requests(resource_type, resource_id)` | the `purge_polymorphic_refs` DELETE, and "requests for this resource" in the sharing dialog |
| `access_grants(project_id, resource_type, resource_id)` | the "Who has access" dialog for one resource |
| `doc_drafts(project_id, status)` | the AI-draft review queue (Phase 5) |
| `export_jobs(project_id, created_at DESC)` | "your exports" list; `export.ready` resolves its notification URL through it |
| `export_jobs(expires_at)` | the sweep that deletes rows whose S3 object has aged out |
| `invitations(token_hash)` unique | accepting an invite |
| `invitations(organization_id, accepted_at)` | pending invites on the members page |
| `invitations(email)` | on signup: "did anyone invite this address" |
| `notifications(user_id, created_at DESC)` | notification centre |
| `notifications_unread_idx` (partial) | the unread badge count |

Deliberately **not** indexed yet, with the trigger to add them:

- Trigram/full-text search over `entities.name`, `fields.name`, `docs.plain_text`. Phase 1
  search is in-memory over the already-loaded project (the client has the whole schema).
  Add `pg_trgm` GIN indexes when cross-project search ships, or when a project exceeds
  the size where the client holds the full model.
- `snapshots.ir` is never queried by content. If snapshot search is ever wanted, that is
  a sign snapshots should move to object storage, not a sign to add a JSONB index.

---

## 4. `access_grants`: two polymorphic columns, and what they cost

### 4.1 The shape

```
access_grants
  organization_id -> organizations.id   REAL FK, ON DELETE CASCADE   (C6)
  project_id      -> projects.id        REAL FK, ON DELETE CASCADE   (C6)
  resource_type   resource_type         project | area | entity
  resource_id     text                  NO FK
  principal_type  principal_type        user | group | email_invite | share_link
  principal_id    text                  NO FK
  role_id         -> roles.id           REAL FK, ON DELETE RESTRICT
  can_use_ai          boolean           additive modifier
  can_view_restricted boolean           additive modifier
  expires_at      timestamptz NULL
```

One row means: *this principal has this role, plus whichever modifiers are on, on this
resource*. Inheritance is computed, never stored. The resolver walks
`entity -> area -> project` in memory over the grants it already loaded.

`organization_id` is denormalised from `project.organization_id` by the grant writer (the
only place a grant is created) and is never accepted from a request. It exists so that
"delete this person's grants in this org" (§4.3) and "is this grant's principal still a
member" (§3.2) are single indexed statements rather than joins through `projects`.

**Precedence — the rule, stated as an algorithm.** The spec's one sentence ("grants
inherit downward; more specific grants override broader ones") does not determine the two
cases that actually occur, so doc 05 fixes them as R15 and R16 and this is the schema-side
restatement:

1. **Per principal, nearest level wins (R15).** For one principal `p`, walk
   `ancestors(R)` most-specific-first (`entity → area → project`) and stop at the first
   level where `p` has any live grant. That grant determines `p`'s contribution
   **entirely**; broader levels are discarded, not unioned. `@@unique([resourceType,
   resourceId, principalType, principalId])` guarantees there is at most one grant per
   level, so "the grants at that level" is always exactly one row. A narrower grant
   therefore **replaces** a broader one and may weaken it.
2. **Union across principals (R16).** The deciding level is computed *per principal*, not
   once for the subject. `effective(R) = ⋃ atoms_p(R)` over the subject's own user
   principal and each of their groups.
3. **Ceilings intersect last (R17).** `share_link` subjects are intersected with
   `{ schema:view }`; `guest` users have `sharing:manage` subtracted.

The two cases reviewers asked about, answered:

| Case | Result |
|---|---|
| Project-level Editor **and** area-level Viewer on Billing, same user principal | Billing is **read-only**. Rule 1: the area level is nearer, so it decides, and it is weaker. This is the only way to express "editor everywhere except here" in a system with no deny grants. |
| User is in group *Analysts* (viewer on P), group *Engineers* (editor on P), and holds a direct user grant (commenter on P) | **Editor.** Rule 2: three principals, each deciding at the project level, unioned. Principal types are not ranked and the most permissive path wins. |
| Direct user grant `viewer` on entity E, group grant `editor` on project P | **Editor on E.** The user principal decides at E (viewer); the group principal decides at P (editor); the union is editor. Narrowing one path does not narrow the others — revoking access means narrowing or removing **every** path, and the sharing dialog warns when a narrowing grant is defeated this way. |

These three are the fixture rows of the permission-matrix unit test spec §10 requires.

### 4.2 Why polymorphic rather than four nullable FK columns

The honest alternative is the exclusive arc: `project_id`, `area_id`, `entity_id`,
`user_id`, `group_id`, `invited_email`, `share_link_id` as nullable columns with a
`num_nonnulls(...) = 1` check on each side. That buys real foreign keys and real
cascades, and costs a migration plus a code change every time a new grantable resource
or principal appears.

Two things decide it for the polymorphic shape here:

1. **The resolver query is `WHERE project_id = $1 AND (principal_type, principal_id) IN
   (...)`.** With the arc it becomes a four-branch `OR` over four nullable columns, which
   is four index scans and a `BitmapOr` instead of one range scan. This is the single
   most frequent authenticated query in the product.
2. Spec §5 already names four principal types and explicitly wants more (email invites
   that become users, share links that behave like principals). The arc's column count
   grows with the vocabulary.

So: polymorphic, and pay the integrity bill explicitly rather than pretending there is no bill.

### 4.3 What integrity is lost, and how each loss is bought back

| Lost guarantee | Bought back by |
|---|---|
| `resource_id` points at a row that exists | `AFTER DELETE` triggers on `areas` and `entities` (§2.8) delete matching grants. On project delete, the real `project_id` FK cascades. |
| `principal_id` points at a principal that exists — **all four types** | `user` and `group`: the repository method below, in the deleting transaction. `share_link`: the `share_links_purge_grants` trigger (§2.8), because a link is a principal and `purge_polymorphic_refs` keys on the resource side. `email_invite`: invitation expiry and revocation delete the grant through `invitations.access_grant_id` (unique, `ON DELETE CASCADE` on the invitation side) — and an unswept one is harmless because doc 05 R11 says an `email_invite` grant never reaches the resolver at all. |
| `resource_id` belongs to `project_id` | `access_grants_project_self_ck` for the project case; for area/entity the *writer* validates (the sharing service loads the resource anyway to authorise the share). Read side is safe because every query is already scoped by `project_id`. |
| Type sanity (`principal_id` is a cuid, not an email) | `access_grants_email_shape_ck` (which the resolver's normalisation depends on) plus `access_grants_id_shape_ck` as a shape smoke-test. |
| No duplicate grant | `@@unique([resourceType, resourceId, principalType, principalId])` — all four columns are `NOT NULL`, so a plain unique works; no partial index needed. |
| One share link, one scope | `access_grants_one_per_share_link_uq` partial unique. |

### 4.3.1 Offboarding: removing someone from an org

This is the most common security operation in a B2B product and it needs two mechanisms,
because one of them is the enforcement and the other is the hygiene:

**Enforcement (doc 05 R12.3).** A `user` grant is live only if that user is a current
`OrgMember` of the grant's `organization_id`. Step 1 of the resolver (§3.2) already runs
that lookup on every request; no row returned means no access, and grants are not even
consulted. Delete the `org_members` row and the grants stop working on the next request —
which is why `access_grants.organization_id` exists. **Fail-closed by construction**: if
the cleanup below is ever missed or half-applied, access is still gone.

**Hygiene, in the same transaction as the membership delete.** The grants must also go,
or the "Who has access" dialog lists a person the members page no longer shows, and
re-adding them silently restores old access:

```sql
-- Removing an OrgMember. One transaction, plus an audit_log row per deleted grant.
DELETE FROM access_grants
  WHERE organization_id = $org AND principal_type = 'user' AND principal_id = $user;

-- …and that user's grants held through groups they were in, if leaving the org also
-- removes them from the org's groups (it does — group_members cascades from the group,
-- and the membership service deletes the user's rows in that org's groups here).
DELETE FROM group_members
  WHERE user_id = $user
    AND group_id IN (SELECT id FROM user_groups WHERE organization_id = $org);

UPDATE users SET perm_generation = perm_generation + 1 WHERE id = $user;
```

The first statement is served by `access_grants(principal_type, principal_id)` filtered on
`organization_id`; a user holds a handful of grants, so the scan is trivial.

**Deleting a user or a group outright** (as opposed to removing them from an org) runs the
same shape without the org filter, in the repository method, not in a service that
"remembers" to call it:

```sql
DELETE FROM access_grants WHERE principal_type = 'user'  AND principal_id = $1;
DELETE FROM access_grants WHERE principal_type = 'group' AND principal_id = $1;
```

### 4.3.2 Invitation acceptance: the unique-violation that would have shipped

`invitations.access_grant_id` points at a pending `email_invite` grant that acceptance
turns into a `user` grant. A plain `UPDATE … SET principal_type = 'user', principal_id =
$user` violates `@@unique([resourceType, resourceId, principalType, principalId])` the
moment the accepting user already holds a direct grant on that resource — Bob is Viewer on
P, someone invites bob@example.com as Editor on P, Bob accepts, the request 500s with
`accepted_at` possibly already written, and the invite can never be accepted again.

**Acceptance is an upsert, not an update** (doc 05 R11): delete the `email_invite` grant
and upsert the `user` grant on `(resourceType, resourceId, 'user', userId)`. On collision
the **invited role wins** if it is higher in the built-in chain, the two modifier booleans
are OR-ed, and the replaced role is written to `audit_log`. Then
`users.perm_generation++`. An expired-but-unswept invite is not a backdoor because an
`email_invite` grant is never read by the resolver (R11) — only the acceptance hook, which
checks the invitation's own `expires_at`, ever looks at one.

### 4.4 The nonsensical-grant constraints, restated as one list

All in migration `0002` (§2.5):

- `access_grants_project_self_ck` — a `project` grant whose `resource_id <> project_id`.
- `access_grants_email_shape_ck` — an `email_invite` grant whose principal is not a
  lowercased, plausible email.
- `access_grants_id_shape_ck` — a `user` / `group` / `share_link` grant whose principal
  is not a cuid.
- `access_grants_one_per_share_link_uq` — a share link with two scopes.
- The Prisma `@@unique` — the same principal granted twice on the same resource.

Two rules **not** enforced in SQL, on purpose:

- *"A share link may only carry a viewer-ish role."* Role contents are data (custom roles
  are user-created), so a check constraint would encode policy in DDL. Enforced in the
  sharing service and covered by a `PermissionResolver` unit test.
- *"An `email_invite` grant must have a live `invitations` row."* The FK runs the other
  way (`invitations.access_grant_id -> access_grants.id`, unique, cascade), which is the
  direction that actually needs to be tight: revoking the grant kills the invite.

### 4.5 Which migration

Everything in §4 lands in `0002_constraints_and_partial_indexes`, in the same transaction
as the table creation's sibling migration. It must not be deferred: a grant table without
`access_grants_project_self_ck` will silently accumulate cross-project grants the moment
someone writes a bulk-share endpoint.

### 4.6 `entities.area_id` is a permission column

Areas are grantable resources (C5), so `entities.area_id` decides who can reach an entity.
Dragging `salaries` into the Billing area grants the area-scoped freelancer edit access;
dragging it out revokes it. The schema treats it accordingly, and doc 04 classifies
`areaId` as a **governance** change rather than a cosmetic one for the same reason:

- Writing `entities.area_id` writes an `audit_log` row (`sharing.entity_area_changed`,
  with the before and after area ids) and bumps `projects.perm_generation`. Spec §5
  requires an audit row for every permission and sharing change; this is one.
- The same applies to **creating** an Area (it can only add) and to **deleting** one.
- **Deleting an Area is the dangerous direction.** `entities.area_id` is `SetNull`, so the
  entities survive and fall back to project-level grants — which may be *more* permissive
  than the area grant they had. The area's own grants are deleted by
  `purge_polymorphic_refs`, so this is not an orphan-grant bug; it is a deliberate
  widening. The rule: the delete dialog **lists every grant that will be destroyed and
  every entity whose effective access will change**, the operation writes one
  `sharing.area_deleted` audit row per destroyed grant, and it bumps
  `projects.perm_generation`. Refusing the delete while grants exist was the alternative
  and it is worse — it leaves the user with no way to reorganise a canvas without an admin.

---

## 5. `docs`: one document per target

```
docs
  project_id   -> projects.id   REAL FK, CASCADE
  target_type  target_type      project | area | entity | field
  target_id    text             NO FK
  content      jsonb            TipTap
  structured   jsonb            field-level structured docs
  plain_text   text             derived
  UNIQUE (target_type, target_id)
```

Notes specific to docs:

- **One doc per target, enforced by a plain unique.** `Doc` is a 1:1 satellite, so the
  polymorphism costs exactly one unique index and one trigger branch.
- `project_id` is present even though it is derivable, because the two queries that
  matter are project-scoped: the documentation-coverage meter
  (`COUNT(*) WHERE project_id = $1 AND target_type = 'field'`) and the docs-mode site
  build, which loads every doc for a project in one scan.
- `docs_project_self_ck` stops a project-level doc pointing at a different project. For
  `area` / `entity` / `field` targets no constraint can check it, so the rule is stated
  instead, in the same wording §4.3 uses: **the write path derives `project_id` from the
  target row and never accepts it from the request body.** The authorisation check already
  loads that row, so deriving costs nothing. A client-supplied tenant key on a polymorphic
  table is the cross-tenant bug waiting to happen: one wrong `project_id` in one service
  method renders another project's documentation — the entity name, the discussion of the
  salary column — inside a project the reader *is* authorised for. The read side is safe
  because every doc query is scoped by `project_id`.
- Orphan sweep: the same `purge_polymorphic_refs` trigger on `areas` / `entities` /
  `fields` (§2.8). Field deletion is the common case and it is the one an app-level
  sweep would miss, because fields get deleted by cascade from entity deletion.
- `field` is in `TargetType` but not in `ResourceType`, which is why the trigger
  compares `resource_type::text` rather than casting to the enum — casting `'field'` to
  `grant_resource_type` would raise. The `DELETE` on `access_grants` from the field
  trigger is a no-op index probe.

The exclusive-arc alternative is *more* attractive here than for grants (doc targets are
a closed set of four, and there is no hot multi-branch query), and it would let the four
FKs cascade natively and delete the trigger. It is rejected only because spec §9 names
`target_type, target_id` and because comments need the identical shape — one polymorphic
convention beats two different ones. Flagged in Open questions.

---

## 6. `comments`: the same shape plus threading

```
comments
  project_id    -> projects.id  REAL FK, CASCADE
  target_type   target_type     entity | field in practice; project | area allowed
  target_id     text            NO FK
  parent_id     -> comments.id  REAL FK, CASCADE (self-relation "CommentThread")
  root_id       text            NO FK, = id for a thread root
  author_id     -> users.id     SetNull
  mentioned_ids text[]
```

- `root_id` is denormalised so one indexed query (`comments(root_id, created_at)`) returns
  a whole thread. It is intentionally not a self-FK: a second self-relation on `Comment`
  doubles the generated Prisma relation surface for no integrity gain, since
  `parent_id`'s cascade already removes descendants. `comments_root_not_child_ck`
  guarantees a root's `root_id` equals its own id.
- **Threading is two levels in the UI** (a thread and its replies), but the model allows
  arbitrary nesting; the API flattens anything deeper into the same thread.
- `mentioned_ids text[]` replaces a `comment_mentions` join table. Mentions are extracted
  from the TipTap marks on write and are only ever read as a whole array (notification
  fan-out, and "comments mentioning me" which is answered from `notifications` anyway).
  A join table would be a table, an index, a cascade and a migration for a value that is
  never joined. If "mentions of me across all projects" becomes a real screen, add
  `@@index([mentionedIds(ops: ArrayOps)], type: Gin)` — one line, no schema change.
- `comments_resolved_pair_ck` stops half-resolved rows (`resolved_at` without
  `resolved_by_id`), which is the bug that makes a "resolved by" column render as blank
  forever.
- `comments_project_self_ck` exists for parity with `docs`, and the **same derivation
  rule applies and matters more**: `comments(project_id, resolved_at, created_at)` serves
  a project-wide open-comments inbox, so a wrong `project_id` renders another project's
  comment text — author included — to a reader authorised for this one. `project_id` comes
  from the target row, never from the request body.
- Orphan sweep: same trigger. Deleting a table deletes its comments; deleting a column
  deletes the comments on that column.

---

## 7. JSONB columns and the zod schema that guards each one

Prisma's `Json` maps to `jsonb` on PostgreSQL, so every column below is `jsonb`. The rule
is absolute: **nothing reaches a `Json` column without passing a zod parse in the write
path.** A `Json` column with no parser is an untyped column, and an untyped column is
where the next data-shape bug lives.

Two corollaries that are easy to get wrong and expensive to get wrong:

1. **Every `Json` column's Prisma default must itself satisfy that column's schema.**
   `docs.content` defaults to `{"type":"doc"}`, not `{}`, because `richTextSchema` requires
   the `doc` literal — with `{}` the very first row written by "open the docs panel on an
   undocumented entity" is a row that throws on read. `docs.structured` is nullable with no
   default, because a discriminated union has no empty member. One unit test parses every
   default in the schema through its own zod schema; it is four lines and it is the test
   that catches this class permanently.
2. **The strict schema guards writes; a lax one guards reads.** Each settings object gets
   two exports: `xInputSchema` (`.strict()`, used to validate a PATCH from a client, so a
   typo'd key is a 422 and not a silently ignored setting) and `xStoredSchema`
   (default `.strip()` behaviour, used when reading a row back). `.strict()` on the read
   path means that the day anyone renames or removes a settings key, every row written
   before that deploy contains a key the new schema rejects — and since the settings object
   is read on project open, that is *every existing project becoming unopenable, for
   everyone, immediately*, with no migration step to catch it. Adding keys is safe in both
   directions; removing one must not be an outage.

| Column | zod schema | Lives in | Notes |
|---|---|---|---|
| `users.notification_prefs` | `notificationPrefs{Input,Stored}Schema` | `contracts` | small |
| `organizations.settings` | `orgSettings{Input,Stored}Schema` | `contracts` | |
| `projects.settings` | `projectSettings{Input,Stored}Schema` | `contracts` | AI toggles only. `restrictedFieldMode` is a real column now, so nothing on the permission hot path parses this object |
| `namespaces.engine_props`, `entities.engine_props`, `fields.engine_props`, `links.engine_props`, `indexes.engine_props`, `index_columns.engine_props`, `constraints.engine_props`, `custom_types.engine_props` | `engine.propsSchemas[objectKind]` | the engine package | resolved at runtime from `EngineRegistry.get(project.engineId)` — C4 |
| `docs.content`, `comments.content`, `doc_drafts.content` | `richTextSchema` | `contracts` | TipTap JSON; shape-checked and size-capped, not fully typed |
| `docs.structured`, `doc_drafts.structured` | `structuredDocSchema` | `contracts` | discriminated on `targetType`; nullable column, parsed only when non-null |
| `fields.type_args` | `typeArgsSchema` | `contracts` | `z.array(z.union([z.number().int(), z.string().max(64)])).max(4)` — `numeric(10,2)`, `varchar(255)`, an interval qualifier |
| `namespaces.refs`, `entities.refs`, `fields.refs`, `links.refs`, `indexes.refs`, `constraints.refs`, `custom_types.refs` | `objectRefsSchema` | `contracts` (re-exporting `schema-model`'s `ObjectRefsSchema`) | server-owned, written from the engine's `extractReferences` on every write and import; never accepted from a request body |
| `snapshots.ir` | `irSnapshotSchema` | `schema-model` | the IR's own schema; also used on read to up-convert old `ir_schema_version` |
| `ai_threads.selection` | `selectionSchema` | `contracts` | also the request body type for the AI endpoint |
| `ai_messages.metadata` | `aiMessageMetaSchema` | `contracts` | |
| `activity_log.metadata`, `audit_log.metadata`, `notifications.data` | `logMetadataSchema` | `contracts` | deliberately loose: a record of JSON scalars with a key/size cap |

```ts
// packages/contracts/src/json-columns.ts
import { z } from 'zod';

/** Loose JSON, but bounded. Used for log/notification payloads. */
const jsonScalar = z.union([z.string().max(2_000), z.number(), z.boolean(), z.null()]);
export const logMetadataSchema = z
  .record(z.string(), z.union([jsonScalar, z.array(jsonScalar).max(50)]))
  .refine((o) => Object.keys(o).length <= 40, 'too many metadata keys');

/** Guards the `refs` column on every engineProps-bearing table (doc 04 delta D4, doc 05 R27).
 *  Shape matches `IrBase.refs` exactly; schema-model owns the type, contracts re-exports it. */
export const objectRefsSchema = z
  .object({
    entityIds: z.array(z.string()).max(500).default([]),
    fieldIds: z.array(z.string()).max(2_000).default([]),
  })
  .strict();

/**
 * Every settings object is declared once as a plain shape, then exported twice:
 * `…InputSchema` (.strict()) validates a PATCH from a client; `…StoredSchema`
 * (default .strip()) parses a row read back out. See corollary 2 above — .strict()
 * on the read path turns "we renamed a settings key" into a full outage.
 */
const notificationPrefsShape = {
  emailMentions: z.boolean().default(true),
  emailInvites: z.boolean().default(true),
  emailAccessRequests: z.boolean().default(true),
  emailCommentReplies: z.boolean().default(true),
  inAppDigest: z.enum(['off', 'daily', 'weekly']).default('off'),
};
export const notificationPrefsInputSchema = z.object(notificationPrefsShape).strict();
export const notificationPrefsStoredSchema = z.object(notificationPrefsShape);

const orgSettingsShape = {
  allowGuestInvites: z.boolean().default(true),
  defaultOrgRole: z.enum(['member', 'guest']).default('member'),
};
export const orgSettingsInputSchema = z.object(orgSettingsShape).strict();
export const orgSettingsStoredSchema = z.object(orgSettingsShape);

/**
 * `restrictedFieldMode` is NOT here — it is a real column on `projects`.
 * `defaultNamespaceId` is NOT here — `namespaces.is_default` is the single source and
 * it has a partial unique index behind it; a JSON copy has no FK, no sweep, and can
 * name a namespace that was deleted.
 * Canvas grid preferences are NOT here — snap-to-grid and grid size are per-person
 * client preferences that live in localStorage. Persisting them project-wide means two
 * people editing one project cannot have different ones, which is the opposite of what
 * a preference is.
 */
const projectSettingsShape = {
  ai: z
    .object({
      /** Project kill switch, ANDed with the `ai:use` atom at the call site. */
      enabled: z.boolean().default(true),
      includeDocsInContext: z.boolean().default(true),
    })
    .strict()
    .default({ enabled: true, includeDocsInContext: true }),
};
export const projectSettingsInputSchema = z.object(projectSettingsShape).strict();
export const projectSettingsStoredSchema = z.object(projectSettingsShape);

/** C5. The single source of the atom vocabulary, now that there is no Postgres enum.
 *  Lives in `packages/contracts/src/permissions.ts` together with doc 05's helpers, so there is
 *  ONE module in the repo that knows what an atom is. The tuple comes first because doc 05
 *  iterates it (`ALL_ATOMS`, the canonical sort order in `validateCustomRole`); the zod enum is
 *  derived from it rather than being a second list. */
export const PERMISSION_ATOMS = [
  'schema:view',
  'schema:edit',
  'docs:edit',
  'comment:create',
  'ai:use',
  'export:run',
  'history:view',
  'sharing:manage',
  'field:viewRestricted',
] as const;

export const permissionAtomSchema = z.enum(PERMISSION_ATOMS);
export type PermissionAtom = (typeof PERMISSION_ATOMS)[number];
export type AtomSet = ReadonlySet<PermissionAtom>;
// Also exported from this module, all owned by doc 05: closeAtoms, BUILT_IN_ROLES,
// BUILT_IN_ROLE_ORDER — plus BUILTIN_ROLE_IDS (§11, migration 0003), which is owned here.

/** Open dotted-verb set, mirroring activity_log.action. */
export const notificationTypeSchema = z.enum([
  'org.invited',
  'resource.shared',
  'comment.mentioned',
  'comment.replied',
  'access.requested',
  'access.decided',
  'ai.job_finished',
  'export.ready',
]);

/**
 * TipTap output. We validate the envelope and the size, not every node type —
 * a full ProseMirror schema mirror in zod would rot the first time a mark is
 * added. Sanitisation (allow-list of node/mark types) happens in the same
 * write pipeline, before this parse.
 */
export const richTextSchema = z
  .object({ type: z.literal('doc'), content: z.array(z.unknown()).max(5_000).optional() })
  .passthrough()
  .refine((d) => JSON.stringify(d).length <= 512_000, 'document too large');

/**
 * Only `entity` and `field` have structured facts. The `project` and `area` branches
 * were empty objects carrying a discriminator and nothing else — the column is nullable
 * instead, and a project- or area-level doc simply has `structured = NULL`.
 */
export const structuredDocSchema = z.discriminatedUnion('targetType', [
  z
    .object({
      targetType: z.literal('entity'),
      ownerUserId: z.string().nullable().default(null),
      businessMeaning: z.string().max(4_000).default(''),
    })
    .strict(),
  z
    .object({
      targetType: z.literal('field'),
      businessMeaning: z.string().max(4_000).default(''),
      allowedValues: z
        .array(z.object({ value: z.string().max(200), meaning: z.string().max(500) }))
        .max(200)
        .default([]),
      examples: z.array(z.string().max(500)).max(20).default([]),
      unit: z.string().max(50).nullable().default(null),
      ownerUserId: z.string().nullable().default(null),
    })
    .strict(),
]);

/** The canvas selection an AI thread was started from. */
export const selectionSchema = z
  .object({
    entityIds: z.array(z.string()).max(500).default([]),
    fieldIds: z.array(z.string()).max(2_000).default([]),
    linkIds: z.array(z.string()).max(1_000).default([]),
    areaIds: z.array(z.string()).max(100).default([]),
  })
  .strict();

export const aiMessageMetaSchema = z
  .object({
    assumptions: z.array(z.string().max(500)).max(20).default([]),
    /** Engine queryValidator result. */
    validation: z
      .object({
        ok: z.boolean(),
        unknownIdentifiers: z.array(z.string()).max(100).default([]),
      })
      .nullable()
      .default(null),
    /** Entities the produced query touches — drives the canvas glow. */
    usedEntityIds: z.array(z.string()).max(200).default([]),
    /** Visible-but-unselected entities the join path needs. */
    suggestedEntityIds: z.array(z.string()).max(50).default([]),
    finishReason: z.string().max(50).nullable().default(null),
  })
  .strict();
```

`engineProps` is the one that is *not* a fixed schema. The write path is:

```ts
// apps/api/src/schema/schema-object.service.ts (sketch)
// `propsSchemas[kind]` is an EnginePropsResolver — it takes the object's SUB-KIND, because a
// table and a view genuinely have different props (doc 03 §6). Core never calls it directly:
// `parseEngineProps` (doc 03 §6.1) wraps it and turns every zod issue into a Diagnostic whose
// `target.propPath` is the zod path, so the inspector highlights the exact input.
const engine = this.engines.get(project.engineId);            // EngineRegistry
const parsed = parseEngineProps(engine, 'field', null, input.engineProps);
if (!parsed.ok) throw new UnprocessableEntityException({ diagnostics: parsed.diagnostics });
const refs = engine.extractReferences(nextField, null, model);   // doc 03 §3.1 -> the refs column
await this.prisma.field.update({
  where: { id, version: expected },
  data: { engineProps: parsed.props, refs: toObjectRefs(refs), ... },
});
```

Two consequences worth stating now: engineProps is validated against the **current**
engine version, so `projects.engine_version` must be carried into the parse when an
engine ships a breaking props change; and because Prisma cannot type a dynamic JSON
column, the service layer returns `EngineProps<'field'>` from the engine's inferred zod
type, not `Prisma.JsonValue`.

---

## 8. Cascade behaviour

Referential actions, every relation, with the reason. The default in Prisma is
`Cascade` for required relations and `SetNull` for optional ones; nothing below relies on
that default being remembered — each is written out in the schema.

### 8.1 Auth and identity

| Relation | onDelete | Why |
|---|---|---|
| `accounts.user` | **Cascade** | an OAuth identity with no user is meaningless |
| `sessions.user` | **Cascade** | deleting a user must invalidate their sessions in the same statement |
| `verification_tokens.user` | **Cascade** | |
| `recovery_codes.user` | **Cascade** | |

### 8.2 Tenancy

| Relation | onDelete | Why |
|---|---|---|
| `org_members.organization` / `.user` | **Cascade** | membership is meaningless without either end |
| `user_groups.organization` | **Cascade** | |
| `group_members.group` / `.user` | **Cascade** | |
| `workspaces.organization` | **Cascade** | |
| `projects.organization` | **Cascade** | purging an org purges its projects |
| `projects.workspace` | **NoAction, deferred** (§8.6) | "a workspace with projects in it cannot be deleted" is a *product* rule and lives in the workspace service, which is the only place that can offer "move them first". As a referential action it was `Restrict`, and `Restrict` under the org's `Cascade` breaks org deletion |
| `projects.createdBy` | **SetNull** | a project outlives the person who created it |
| `roles.organization` | **Cascade** | custom roles die with the org; built-ins have `organization_id = null` and are untouched |
| `invitations.organization` | **Cascade** | |

### 8.3 Schema objects

| Relation | onDelete | Why |
|---|---|---|
| `namespaces.project`, `areas.project`, `entities.project`, `fields.project`, `links.project`, `link_endpoints.project`, `indexes.project`, `index_columns.project`, `constraints.project`, `constraint_columns.project`, `custom_types.project` | **Cascade** | one `DELETE FROM projects` empties the model |
| `entities.namespace` | **NoAction, deferred** (§8.6) | "you cannot drop a schema that still has tables" is enforced in the namespace service, which offers "move entities to `public` first". As `Restrict` it fired *inside* the project cascade and made project deletion fail |
| `entities.area` | **SetNull** | deleting the "Billing" region must not delete the billing tables. They become unassigned — which widens their effective access, so the delete is a sharing event (§4.6) |
| `fields.entity` | **Cascade** | |
| `fields.parent` (self, `FieldNesting`) | **Cascade** | deleting a nested object field deletes the subtree. Also enforced a second time by the composite `fields_parent_same_entity_fk`, which is `ON DELETE CASCADE` too — two cascade paths to the same rows, which PostgreSQL handles fine |
| `fields.customType` | **NoAction, deferred** (§8.6) | "you cannot drop an enum that columns still use" is enforced in the custom-type service. A **rename** additionally rewrites `fields.data_type` on every dependent row in the same transaction, one index scan on `fields(custom_type_id)` — otherwise the exporter emits DDL naming a type that no longer exists and the round-trip test cannot see it |
| `custom_types.namespace` | **NoAction, deferred** (§8.6) | same reason as entities |
| `links.sourceEntity` / `.targetEntity` | **Cascade** | deleting a table deletes the FKs that touch it. Two cascade paths from `entities` into `links` — legal in PostgreSQL (unlike SQL Server), and if both ends are deleted at once the row is simply deleted once |
| `link_endpoints.link` | **Cascade** | |
| `link_endpoints.sourceField` / `.targetField` | **Cascade**, *no trigger* | deleting a column removes it from the FK, and the `links` row **survives** with fewer (possibly zero) endpoints. A zero-endpoint link is a legal entity-level link (doc 04 §2.7/§8.6); deleting the relationship line a human drew because someone dropped a column is the more destructive reading, and a graph engine cannot model a property edge at all if zero endpoints is illegal |
| `index_columns.index` | **Cascade** | |
| `index_columns.field` | **Cascade** + `purge_empty_index` trigger | a zero-column index is invalid in every paradigm |
| `constraint_columns.constraint` | **Cascade** | |
| `constraint_columns.field` | **Cascade** + `purge_empty_keyed_constraint` trigger | drops a constraint that has lost its last column **and has no expression**. The predicate is engine-neutral on purpose (§2.9): CHECK and EXCLUDE legitimately have no columns and are exactly the ones carrying an expression |

### 8.4 Content, permissions, logs

| Relation | onDelete | Why |
|---|---|---|
| `docs.project`, `comments.project`, `saved_queries.project`, `saved_query_entities.project`, `ai_threads.project`, `ai_messages.project`, `snapshots.project`, `doc_drafts.project`, `export_jobs.project`, `access_grants.project`, `access_grants.organization`, `share_links.project`, `access_requests.project`, `activity_log.project` | **Cascade** | all of it is project content |
| `audit_log.project` **and** `audit_log.organization` | **SetNull** | the security trail must survive the thing it describes — *both* things. An org cascade would let the scheduled purge job erase every grant change, every 2FA change and the record of the deletion itself, with nobody in the room. `organization_name` and `actor_email` are denormalised so an orphaned row still reads. Erasure is a retention job (`WHERE organization_id IS NULL AND created_at < now() - :retention`), which is reviewable; a cascade is not |
| `notifications.project` | **SetNull** | a delivered notification is not retracted by deleting the project; the link just stops resolving |
| `notifications.organization` | **Cascade** | |
| `notifications.user` | **Cascade** | |
| `notifications.actor` | **SetNull** | |
| `docs.updatedBy`, `comments.author`, `comments.resolvedBy`, `saved_queries.createdBy`, `ai_threads.user`, `snapshots.createdBy`, `share_links.createdBy`, `access_grants.createdBy`, `access_requests.decidedBy`, `access_requests.requestedRole`, `doc_drafts.createdBy`, `doc_drafts.reviewedBy`, `export_jobs.requestedBy`, `activity_log.actor`, `audit_log.actor`, `invitations.invitedBy`, `invitations.acceptedBy` | **SetNull** | the artefact outlives the author. `activity_log.actor_name` and `audit_log.actor_email` preserve *who* it was after the row is gone |
| `access_requests.requester` | **Cascade** | a request from a deleted user has nobody to grant access to |
| `comments.parent` (self) | **Cascade** | deleting a thread root deletes its replies |
| `saved_query_entities.savedQuery` / `.entity` | **Cascade** | |
| `saved_queries.aiThread` | **SetNull** | deleting a conversation keeps the query it produced |
| `ai_messages.thread` | **Cascade** | |
| `access_grants.role` | **NoAction, deferred** (§8.6) | "a custom role in use cannot be deleted; N grants use it — reassign or archive first" is enforced in the role service. `Restrict` here breaks org deletion, because `roles` and `access_grants` both cascade from the org and `roles` goes first |
| `invitations.accessGrant` | **Cascade** | revoking the grant kills the pending invite |

### 8.5 The four deletes spelled out

**Deleting a project.** `projects.deleted_at` is set first (C8) and the project vanishes
from every list. A purge job later issues the real `DELETE`. The order below is **not** an
optimisation — leaving rows for the triggers to find is tens of thousands of trigger
invocations inside one transaction on a 300-table project:

```sql
BEGIN;
  -- 1. tables carrying purge_polymorphic_refs' targets, by project_id (index scans)
  DELETE FROM comments        WHERE project_id = $1;
  DELETE FROM docs            WHERE project_id = $1;
  DELETE FROM doc_drafts      WHERE project_id = $1;
  DELETE FROM access_grants   WHERE project_id = $1;
  DELETE FROM access_requests WHERE project_id = $1;

  -- 2. the ordered child tables, which carry purge_empty_index /
  --    purge_empty_keyed_constraint. Children before parents.
  DELETE FROM link_endpoints     WHERE project_id = $1;
  DELETE FROM index_columns      WHERE project_id = $1;
  DELETE FROM constraint_columns WHERE project_id = $1;
  DELETE FROM links              WHERE project_id = $1;
  DELETE FROM indexes            WHERE project_id = $1;
  DELETE FROM constraints        WHERE project_id = $1;

  -- 3. the schema objects themselves, in dependency order, so the deferred FKs in
  --    §8.6 have nothing left to complain about at COMMIT either.
  DELETE FROM fields       WHERE project_id = $1;
  DELETE FROM entities     WHERE project_id = $1;
  DELETE FROM custom_types WHERE project_id = $1;
  DELETE FROM namespaces   WHERE project_id = $1;

  -- 4. now every trigger has nothing to find and every cascade is a no-op
  DELETE FROM projects WHERE id = $1 AND deleted_at IS NOT NULL;
COMMIT;
```

Every statement is one index scan on the `@@index([projectId])` that C6 already put there
— that is what the denormalised `project_id` on the grandchild tables is *for*. What is
left (`saved_queries`, `ai_threads`, `snapshots`, `share_links`, `activity_log`,
`areas`, `export_jobs`) goes by FK cascade with no triggers attached. `audit_log` rows keep
their `organization_id` and lose their `project_id`. Notifications keep their text and lose
their link.

**Deleting an organization.** Same shape, one level up. The org purge job runs the project
purge for each live project first, then:

```sql
BEGIN;
  -- each project purged with the block above, then:
  DELETE FROM projects WHERE organization_id = $1;
  DELETE FROM organizations WHERE id = $1 AND deleted_at IS NOT NULL;
COMMIT;
```

Deleting the `projects` rows explicitly, before the org row, is what keeps
`projects_workspace_id_fkey` out of trouble even though §8.6 has already made it
deferrable — belt and braces, and it is one statement. `audit_log` survives with
`organization_id = NULL` and `organization_name` still readable.

**Deleting an entity.** One `DELETE FROM entities WHERE id = $1` inside the schema
service's transaction. Cascade removes its fields (and their nested subtrees), indexes,
index columns, constraints, constraint columns, saved-query links, and every link where
it is the source *or* the target. The `entities_purge_refs` trigger removes its doc, its
comments, any area/entity-level grants pointing at it and any pending access requests
for it. `activity_log` rows keep `target_id` pointing at a dead id **on purpose** —
"deleted table `orders`" is the single most useful line in a history feed, and
`target_name` is denormalised exactly so it still renders.

**Deleting a user.** Hard delete (C8 gives no tombstone for users, and GDPR erasure
wants a real delete). Cascade takes accounts, sessions, verification tokens, recovery
codes, org memberships, group memberships, notifications and their own pending access
requests. `SetNull` leaves their projects, docs, comments, snapshots, saved queries, AI
threads, share links and log entries standing, attributed to a null user that the UI
renders as "Deleted user" — with the real name still visible in `activity_log.actor_name`
and the real email in `audit_log.actor_email`. The two grant deletes in §4.3 run in the
same transaction. If a user is the **last owner** of an org, the delete is refused at the
service layer (no FK can express it) and the UI forces ownership transfer first.

### 8.6 Why five FKs are `NO ACTION DEFERRABLE INITIALLY DEFERRED`

`projects.workspace_id`, `entities.namespace_id`, `custom_types.namespace_id`,
`fields.custom_type_id` and `access_grants.role_id` all used to be `onDelete: Restrict`,
and all five sit **underneath a parent that cascades**. PostgreSQL's `RESTRICT` trigger is
non-deferrable and fires at the end of the inner cascaded `DELETE`, before the sibling
cascade has removed the referencing rows. So:

- `DELETE FROM organizations` cascades to `workspaces` *and* to `projects`. If the
  workspaces cascade runs first, `projects_workspace_id_fkey` raises.
- `DELETE FROM organizations` also cascades to `roles` *and*, through `projects`, to
  `access_grants`. `roles` is created in step 3 of `0001` and `access_grants` in step 7,
  so the roles cascade fires first and `access_grants_role_id_fkey` raises.
- `DELETE FROM projects` cascades to `namespaces` *and* to `entities` / `custom_types`.
  `Namespace` is declared before `Entity`, so Prisma emits its FK first and the namespaces
  cascade fires first — `entities_namespace_id_fkey` raises. That order is against us
  today, and nothing in the schema *states* the order, so it could silently flip.

Whether an org delete or a project purge succeeded therefore depended on the order Prisma
happened to emit `ADD CONSTRAINT` in `0001`. Two changes fix it, and both are needed:

1. **Deferral**, in `0002` §2.10, because Prisma cannot express `DEFERRABLE`. Deferred to
   `COMMIT`, by which time both sibling cascades have completed and there is nothing to
   reference.
2. **The explicit ordered deletes** in §8.5, which mean the deferred check has nothing to
   evaluate in the common path anyway.

The product rules these FKs *used* to express ("you cannot drop a schema that still has
tables", "you cannot delete a workspace with projects in it", "you cannot drop an enum
columns still use") did not disappear — they moved to the services that own those
operations, which are the only places that can offer the user the fix ("move the entities
to `public` first"). A referential action cannot offer anything; it can only raise a
constraint-violation error the UI has to reverse-engineer.

---

## 9. The field-nesting model

PostgreSQL does not need it. MongoDB does, and `capabilities.supportsNestedFields` is in
the engine contract, so the column exists from day one — adding a self-relation to a
`fields` table with real data in it is a bad afternoon.

### 9.1 Shape

```
fields
  entity_id        NOT NULL   always the owning entity, even for a deeply nested field
  parent_field_id  NULL       NULL = top level
  position         NOT NULL   order among siblings
```

**There is no `depth` column.** Revision 1 materialised one, checked
`depth BETWEEN 0 AND 5` and `(parent_field_id IS NULL) = (depth = 0)`, and then rested the
entire no-cycles argument on the application maintaining it correctly. That is a derived
value with a single point of failure: a reparent that forgets to rewrite its descendants'
depths leaves wrong depths that pass both CHECKs, at which point the cycle argument
collapses and nothing else notices, because nothing queries `depth`. Doc 04 does not read
it either — the IR recomputes depth from `parentFieldId` when it needs it. Deleting the
column removes one column, two CHECK constraints and one class of silent corruption in the
same stroke.

`entity_id` is **not** nullable for nested fields. Every field, at any depth, names its
entity. That is what makes "load the whole project" one flat `WHERE project_id = $1`
instead of a recursive CTE, and what makes `fields(entity_id, position)` useful.

### 9.2 Invariants and who enforces them

| Invariant | Enforced by |
|---|---|
| parent is in the same entity | `fields_parent_same_entity_fk`: composite FK `(parent_field_id, entity_id) -> fields(id, entity_id)`, against the `@@unique([id, entityId])` index. This is the one the database really has to hold — it is the invariant that makes `entity_id` trustworthy |
| no 1-cycles | `fields_not_self_ck` |
| no longer cycles | **application**: `reparentField` refuses a target that is a descendant of the moved node, checked with the bounded recursive CTE in §9.4. That single check is what prevents every cycle length, and it is the check that has to run anyway to compute the subtree |
| depth ceiling (`MAX_FIELD_DEPTH` = 8) | **application**, in the same `createField` / `reparentField` path and from the same CTE: a move that would push the moved subtree past the ceiling is rejected with a **422**, not a constraint violation surfacing as a raw 500 |
| sibling name uniqueness | `fields_name_uq` on `(entity_id, coalesce(parent_field_id, ''), lower(name))` |

Both application-enforced rules live in **one** code path and both read the same CTE
result, so there is no second place to forget. The ceiling is a product decision, not a
technical limit: past a handful of levels a document field tree is unreadable on a canvas card.
The ceiling is **`MAX_FIELD_DEPTH = 8`**, declared in `packages/schema-model` (doc 04 §4) and
re-exported by `packages/contracts`. Doc 04 owns the number; an earlier revision of this document
said 5, which is superseded — 8 is also doc 03's `capabilities.maxFieldDepth` for MongoDB, and
PostgreSQL's `supportsNestedFields: false` makes the effective depth 1 in v1 regardless.

### 9.3 Ordering within a level

`position Int`, scoped to `(entity_id, parent_field_id)` — a nested field's position is
relative to its siblings, not to the whole entity. Reads use
`ORDER BY position, id`; `id` is a cuid, so the tiebreak is stable and roughly creation
ordered.

`position` is deliberately **not** unique. A reorder rewrites every sibling's position in
one transaction, and **checks the parent's version once** rather than racing N per-row
checks:

```ts
// The client sends the full ordered id list for one level, plus the entity version it
// was holding. One conflict check for the whole gesture.
await prisma.$transaction(async (tx) => {
  const owner = await tx.entity.update({
    where: { id: entityId, version: expectedEntityVersion },   // P2025 -> 409
    data: { version: { increment: 1 } },
  });
  await Promise.all(
    orderedIds.map((id, i) =>
      tx.field.update({ where: { id, entityId: owner.id }, data: { position: i } }),
    ),
  );
});
```

Revision 1's example bumped `version` on every sibling and checked none, while the prose
one paragraph later claimed the operation was "trivially conflict-checkable against
`version`" — two concurrent reorders of the same list would both have succeeded and
interleaved. Checking the parent is both correct and cheaper, and it is the same rule the
ordered child tables use (§10.4).

With a unique index this would fail halfway through, because a partial unique index
cannot be `DEFERRABLE` in PostgreSQL and per-row uniqueness is checked statement by
statement. The alternatives — sparse gaps, fractional indexing, `DEFERRABLE` full-table
unique constraints — all cost more than "renumber the siblings, they are never more than
a few hundred". Duplicate positions would only ever produce a stable-but-unexpected
order, never data loss.

Insert-in-the-middle is the same operation: renumber. Drag-and-drop on the canvas sends
the full ordered id list for the affected level, which makes the operation idempotent.

### 9.4 Reading a subtree

The client loads all of a project's fields flat and builds the tree in memory. The server
only needs a subtree query for the impact preview before a delete:

```sql
WITH RECURSIVE subtree AS (
  SELECT id, 0 AS lvl FROM fields WHERE id = $1
  UNION                                   -- not UNION ALL
  SELECT f.id, s.lvl + 1
    FROM fields f JOIN subtree s ON f.parent_field_id = s.id
   WHERE s.lvl < 9                     -- MAX_FIELD_DEPTH (8) + 1
)
SELECT id FROM subtree;
```

Served by `fields(parent_field_id, position)`. Two details, both load-bearing now that
there is no `depth` column to lean on:

- **`UNION`, not `UNION ALL`.** `UNION` deduplicates, so the recursion terminates on a
  cycle instead of running forever. Revision 1 used `UNION ALL` and relied on a depth
  CHECK to bound it — but a cycle means the depths are *already wrong*, so the bound was
  exactly the thing that had failed. An unbounded recursive CTE on the largest table,
  triggered by a user clicking delete, is a bad way to find out.
- **`WHERE s.lvl < MAX_FIELD_DEPTH + 1`** is the belt: even a malformed tree stops.

The same CTE is what `reparentField` runs to reject a move into a descendant and to reject
a move that would exceed `MAX_FIELD_DEPTH` (§9.2).

---

## 10. Link endpoints and composite foreign keys

PostgreSQL foreign keys span multiple column pairs
(`FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)`), and
multi-tenant schemas — the exact schemas this product's users draw — use them constantly.
A `link` with a single `source_field_id` / `target_field_id` pair cannot represent that, and
retrofitting it means migrating every existing link. So the field pairs live in their own
table from the start.

### 10.1 Shape

```
links
  source_entity_id  -> entities.id   denormalised, for drawing
  target_entity_id  -> entities.id   denormalised, for drawing
  kind              text             engine-defined ("foreign_key")
  cardinality       link_cardinality
  engine_props      jsonb            on_delete, on_update, deferrable, match

link_endpoints
  link_id           -> links.id
  ordinal           int              C11 — column order inside the key
  source_field_id   -> fields.id
  target_field_id   -> fields.id
  UNIQUE (link_id, ordinal)
  UNIQUE (link_id, source_field_id)
```

A simple FK is one endpoint row. `orders(tenant_id, customer_id) -> customers(tenant_id, id)`
is two rows:

| ordinal | source_field | target_field |
|---|---|---|
| 0 | `orders.tenant_id` | `customers.tenant_id` |
| 1 | `orders.customer_id` | `customers.id` |

`ordinal` is not cosmetic: it decides the pairing in the generated DDL, and
`FOREIGN KEY (a, b) REFERENCES t (x, y)` is a different constraint from
`FOREIGN KEY (b, a) REFERENCES t (x, y)`.

**Cardinality spelling.** The column is the `link_cardinality` enum
(`one_to_one | one_to_many | many_to_one | many_to_many`); the IR spells it
`'1:1' | '1:N' | 'N:1' | 'N:M'`. Doc 04 §8.1 owns the mapping and it is a literal
four-row lookup in both directions — restated here so nobody has to go and find it:

| column | IR |
|---|---|
| `one_to_one` | `1:1` |
| `one_to_many` | `1:N` |
| `many_to_one` | `N:1` |
| `many_to_many` | `N:M` |

### 10.2 Why the entity ids are on `links` and not derived

Rendering 300 tables and their edges must not require joining `link_endpoints` and
`fields` to find out which two cards an edge connects. `source_entity_id` /
`target_entity_id` are denormalised for exactly that, and they are what
`VisibilityFilter` reads to decide whether an edge becomes a faded "restricted" stub
(spec §5: links to hidden entities appear without names).

The cost is a consistency rule the database does not check: *every endpoint's source
field must belong to `link.source_entity_id`, and likewise for target.* Enforcing it in
SQL would mean carrying `source_entity_id` / `target_entity_id` on `link_endpoints` too
and adding two more composite FKs — four extra columns and two extra indexes to protect
against a bug in one service method. It is enforced instead in the engine's `validator`,
which every link write already passes through, and asserted in the round-trip test
(`DDL -> IR -> DDL` would produce garbage the moment it broke).

### 10.3 Other rules

- `link_endpoints_distinct_ck`: a field cannot reference itself within one endpoint.
- `UNIQUE (link_id, source_field_id)`: the same source column cannot appear twice in one key.
- **Self-referencing links** (`employees.manager_id -> employees.id`) are fine:
  `source_entity_id = target_entity_id`, nothing special. The edge label the canvas draws
  is `links.name` — there is no per-endpoint `role` column, and doc 04 deleted
  `LinkEndpoint.role` from the IR for the same reason: two links between the same pair are
  already distinguished by their endpoints, and a label belongs to the edge, not to one
  side of it.
- **N:M** is `cardinality = many_to_many` with the canvas offering to generate a junction
  entity; the generated junction is two ordinary `many_to_one` links. Nothing in the
  model stores "this was once an N:M".
- **Cardinality is a modelling annotation**, not derived. A PostgreSQL FK is always
  many-to-one at the DDL level; `one_to_one` is the user saying "and there is a unique
  constraint on the source columns", which the exporter checks against the actual
  `constraints` rows and flags as a warning if absent (see §10.5 — that check only works
  because uniqueness has exactly one canonical representation).
- **Non-relational engines**: MongoDB's "reference" and Neo4j's edges are the same two
  tables with `kind = 'reference'` / `'edge'` and usually one endpoint. Graph edge
  properties go in `links.engine_props`.
- **Losing a column does not lose the link.** Deleting a participating field cascades its
  `link_endpoints` row away; the `links` row survives. A composite FK that loses one of its
  two columns degrades to a single-column FK; a link that loses all of them becomes an
  entity-level link with empty endpoints, which is legal (doc 04 §2.7) and is what a graph
  engine's property edge looks like anyway. PostgreSQL would drop the whole constraint;
  SchemaLoom is a design tool, and silently erasing the relationship line a human drew
  because someone dropped a column is the worse of the two behaviours. The exporter warns
  on a link it cannot emit as DDL. **This closes revision 1's open question 4.**

### 10.4 Concurrency for ordered children and for geometry (C7 carve-outs)

C7 says every mutable schema object carries `version`. Two carve-outs, both stated here
rather than left for an implementer to infer:

**1. The three ordered child tables have no `version`; their parent's governs.**
`link_endpoints`, `index_columns` and `constraint_columns` are never edited on their own —
reordering a composite PK's columns, swapping which column an index covers, repairing an
FK's column pairing are all edits *to the index / constraint / link*. So:

> **Any write to `link_endpoints`, `index_columns` or `constraint_columns` carries the
> parent's expected `version`, verifies and increments it in the same transaction, and
> only then renumbers the children.**

Identical in shape to the field-reorder transaction in §9.3. Without this rule the
reordering of a composite primary key would be last-write-wins with no conflict detection,
and §10.1 is explicit that `FOREIGN KEY (a,b)` and `FOREIGN KEY (b,a)` are different
constraints — two users reordering concurrently would produce an order neither chose and
generate silently wrong DDL. Checking the parent once also avoids tripping
`@@unique([indexId, ordinal])` halfway through a renumber and surfacing a 500 where a 409
belongs.

**2. Canvas geometry is outside the concurrency contract entirely.**
`entities.position_x`, `position_y`, `width` and `height` are written by a dedicated
endpoint that does **not** read or bump `version`, and is last-write-wins by design. At the
spec's 300-entity target, one auto-layout (elkjs) rewrites every position in one operation;
if that bumped 300 versions, every other client with an open property panel — a rename in
progress, a nullable toggle — would 409 on a change that conflicted with nothing. With
presence and autosave-on-drag, two people panning the same project would 409 each other's
*semantic* edits continuously. That is the change that gets reverted at 3am under the
label "optimistic concurrency is broken".

The canvas already reconciles geometry through presence broadcasts, and doc 04 classifies
`position` / `width` / `height` / `color` as **cosmetic** changes that the diff and the
migration generator ignore. If layout ever needs a counter of its own, it gets a separate
`layoutVersion`; it does not get to share this one.

### 10.5 One canonical representation of uniqueness

A PostgreSQL unique constraint and a unique index are two spellings of one thing, and this
schema can hold both (`constraints.kind = 'unique'`, or `indexes.is_unique = true`). Two
implementers would pick differently, both round-trip tests would pass — each is
self-consistent — and the break would show up somewhere else entirely: §10.3's `one_to_one`
check reads `constraints`, so if the importer modelled uniqueness as a unique index, every
one-to-one link would warn spuriously forever. It also means `indexes_name_uq` and
`constraints_name_uq` are two namespaces for objects PostgreSQL keeps in one.

> **A table-level `UNIQUE` is always a `Constraint` with `kind = 'unique'` and its
> `constraint_columns`. `SchemaIndex.is_unique` is reserved for a bare
> `CREATE UNIQUE INDEX` with no backing constraint — partial (`WHERE`) or expression
> uniqueness, which PostgreSQL cannot express as a constraint at all.**

The importer normalises to that, the exporter emits from it, the `one_to_one` check reads
`constraints` only, and the engine conformance suite in `engine-sdk` asserts it: a DDL
fixture containing both `UNIQUE (email)` and `CREATE UNIQUE INDEX … ON t (lower(email))`
must produce exactly one `Constraint` and exactly one `SchemaIndex`.

---

## 11. Migration ordering

### `0001_init` — generated, one transaction

`prisma migrate dev --create-only --name init`. Prisma emits creation in dependency
order; the order it produces (and the order to sanity-check the file for) is:

1. **Enums.** `org_role`, `resource_type`, `restricted_field_mode`, `principal_type`,
   `target_type`, `link_cardinality`, `access_request_status`, `verification_purpose`,
   `ai_message_role`, `snapshot_kind`, `doc_draft_status`, `job_status`,
   `theme_preference`. There is no `permission_atom` and no `notification_type` — both
   are `String` (see the enum block's header comment for why).
2. **Roots with no outbound FKs.** `users`, `organizations`.
3. **Depending on those.** `accounts`, `sessions`, `verification_tokens`,
   `recovery_codes`, `org_members`, `user_groups`, `group_members`, `workspaces`,
   `roles`.
4. **`projects`** (needs `organizations`, `workspaces`, `users`).
5. **Schema objects, parents first.** `namespaces`, `areas`, `custom_types`, `entities`,
   `fields`, `links`, `link_endpoints`, `indexes`, `index_columns`, `constraints`,
   `constraint_columns`.
6. **Project content.** `docs`, `doc_drafts`, `comments`, `ai_threads`, `ai_messages`,
   `saved_queries`, `saved_query_entities`, `snapshots`, `export_jobs`.
7. **Permissions.** `access_grants`, `share_links`, `access_requests`, `invitations`
   (last of this group: it points at `access_grants`).
8. **Logs.** `activity_log`, `audit_log`, `notifications`.

`fields` is self-referencing, so Prisma creates the table and then adds the
`parent_field_id` FK — that is fine and expected. Same for `comments.parent_id`.

### `0002_constraints_and_partial_indexes` — hand-written

All of §2. It must run in the same deploy as `0001`; there is no intermediate state where
the app is allowed to write.

### `0003_builtin_roles` — data migration

Inserts the five built-in roles with `organization_id = NULL`, `is_built_in = true`, and
the C5 atom sets:

The five sets form a **strict superset chain** — `viewer ⊂ commenter ⊂ documenter ⊂
editor ⊂ manager` — which is doc 05 R2 and is what makes "a narrower grant overrides a
broader one" (§4.1) a well-defined strengthening or weakening rather than an incomparable
swap. Doc 05 owns these sets; this migration is where they land.

| key | atoms |
|---|---|
| `viewer` | `schema:view export:run` |
| `commenter` | viewer + `comment:create` |
| `documenter` | commenter + `docs:edit` |
| `editor` | documenter + `schema:edit history:view` |
| `manager` | editor + `sharing:manage` |

`ai:use` is in no built-in role: it is the per-grant `can_use_ai` toggle (C5/spec §5), and
doc 05 R7 makes that toggle **additive only** — `effective = role.atoms ∪ { ai:use if
canUseAi } ∪ { field:viewRestricted if canViewRestricted }`. A custom role that *does*
contain `ai:use` therefore grants AI whatever the toggle says, and the share dialog renders
the toggle checked-and-disabled with "always included in <role>". The toggle can add an
atom; it can never remove one. `field:viewRestricted` is in no built-in role either — it is
always an explicit, deliberate addition, which is the entire point of the Restricted flag,
and `can_view_restricted` is its symmetric toggle.

**The five ids are fixed constants, hardcoded here.** PostgreSQL has no `cuid()` function,
so "generate them at insert time" could not be written as SQL at all; worse, ids that
differ between dev, CI, staging and production make seed data, test fixtures and any
exported grant set non-portable, because `access_grants.role_id` is a real FK to them.

```sql
-- 0003_builtin_roles. Re-runnable.
INSERT INTO roles (id, organization_id, key, name, atoms, is_built_in, is_archived,
                   created_at, updated_at) VALUES
  ('rl00000000000000000viewer', NULL, 'viewer', 'Viewer',
   ARRAY['schema:view','export:run'], true, false, now(), now()),
  ('rl0000000000000commenter', NULL, 'commenter', 'Commenter',
   ARRAY['schema:view','export:run','comment:create'], true, false, now(), now()),
  ('rl000000000000documenter', NULL, 'documenter', 'Documenter',
   ARRAY['schema:view','export:run','comment:create','docs:edit'], true, false, now(), now()),
  ('rl00000000000000000editor', NULL, 'editor', 'Editor',
   ARRAY['schema:view','export:run','comment:create','docs:edit','schema:edit',
         'history:view'], true, false, now(), now()),
  ('rl0000000000000000manager', NULL, 'manager', 'Manager',
   ARRAY['schema:view','export:run','comment:create','docs:edit','schema:edit',
         'history:view','sharing:manage'], true, false, now(), now())
ON CONFLICT (id) DO NOTHING;
```

They are exported from `packages/contracts` as `BUILTIN_ROLE_IDS` so the seed script, the
tests, the sharing service and the resolver all reference one constant, and a built-in
lookup becomes `findUnique({ id })` instead of `findFirst({ key, organizationId: null })`.
They are cuid-*shaped* for consistency only: `access_grants_id_shape_ck` constrains
`principal_id`, not `role_id`, so nothing validates them.

A data migration rather than the seed script, because production has no seed script and a
deploy without these five rows is a deploy where nobody can be granted anything.

### Note on optimistic concurrency (C7)

Writes use Prisma's extended `where` on `update` (GA since 4.16):

```ts
await prisma.entity.update({
  where: { id, version: expectedVersion },     // not a unique filter; extendedWhereUnique
  data: { name, version: { increment: 1 } },
});
// P2025 -> throw ConflictException (HTTP 409)
```

No database-level support is needed, and no trigger bumps `version` — the writer does,
in the same statement. Three rules complete the contract, all from §10.4 and §9.3:

1. **Ordered children carry the parent's version.** A write to `link_endpoints`,
   `index_columns` or `constraint_columns` checks and increments `links.version` /
   `indexes.version` / `constraints.version`. One check per gesture, not N racing ones.
2. **A field reorder checks the entity's version**, once, and then renumbers
   unconditionally.
3. **Canvas geometry does not participate.** `position_x/y`, `width`, `height` go through
   their own endpoint, last-write-wins, no version read and no version bump.

A `P2025` from any of these is a 409 with `code = 'stale_version'`; a 409 raised by a
snapshot restore is `code = 'project_restored'` instead, because the client's correct
response is "reload", not "retry".

### Two invariant tests that belong with the migrations

Both are cheap, both catch a class rather than an instance, and neither exists unless
someone writes it now:

- **`json-defaults.spec.ts`** — parse every `Json` column's Prisma default through that
  column's zod schema. Four lines. Catches `@default("{}")` on a column whose schema
  requires a discriminator.
- **`db:verify`** — assert that every named object in `0002` exists (`pg_indexes`,
  `pg_constraint`, `pg_trigger`) **and that the five FKs in §2.10 are still
  `condeferrable`**. A `prisma migrate dev` that recreates them as plain `NO ACTION`
  produces a database that passes an existence check and fails the first org deletion.

---

## 12. Phase map: what to wire up first

Prefer creating **all** of it in `0001`. Retrofitting `access_grants` and `roles` onto a
live database means backfilling grants for every existing project, taking a write lock on
the busiest table in the product, and rewriting every controller's guard in the same
release. The cost of shipping the tables early is an empty table and a Prisma model
nobody imports. That is not a cost.

| Model | Phase | First wired up in |
|---|---|---|
| `users`, `accounts`, `sessions`, `verification_tokens`, `recovery_codes` | 1 | auth module |
| `organizations`, `org_members`, `workspaces`, `projects` | 1 | tenancy module |
| `invitations` | 1 | org invite flow (org role only; the `access_grant_id` column stays null until Phase 3) |
| `namespaces`, `areas`, `entities`, `fields`, `links`, `link_endpoints`, `indexes`, `index_columns`, `constraints`, `constraint_columns`, `custom_types` | 1 | schema module + PostgreSQL engine + canvas |
| `docs` | 1 | docs panel (entity + field targets only) |
| `activity_log` | 1 | written from day one; the feed UI can lag |
| `audit_log` | 1 | written from day one for auth and sharing events (§10 of the spec requires it) |
| `roles` | 1 (rows) / 3 (UI) | the five built-ins exist from `0003`; the custom-role editor is Phase 3 |
| `access_grants` | 1 (project scope) / 3 (area + entity scope) | Phase 1 writes exactly one grant per project: the creator as `manager`. The resolver already walks the full `entity -> area -> project` chain, it just never finds a narrower grant yet |
| `ai_threads`, `ai_messages` | 2 | AI query assistant |
| `saved_queries`, `saved_query_entities` | 2 | query library |
| `user_groups`, `group_members` | 3 | groups |
| `share_links`, `access_requests` | 3 | share links, request access |
| `export_jobs` | 1 (DDL/JSON) / 4 (PNG/SVG, Markdown/PDF) | the export queue. Phase 1 already exports DDL and IR JSON through BullMQ to object storage (spec §2), so the row exists from the first export |
| `comments` | 4 | comments |
| `snapshots` | 4 | named snapshots + diff + migration generation. Read/restore requires a **project-scoped** grant (see the `Snapshot` model comment) |
| `notifications` | 4 | in-app + email notifications |
| `doc_drafts` | 5 | AI doc drafting. Empty until then |
| Phase 5, the rest (docs mode, AI schema generation) | — | **adds no further tables.** Docs mode is a read of `docs`; AI schema generation writes ordinary `entities` / `fields` rows through the same schema service the canvas uses |

Two columns exist in Phase 1 but stay inert until later, so an implementer does not
wire them by accident:

- `fields.is_restricted` — written by the docs panel in Phase 1 (it is a documentation
  flag), but only *enforced* by `VisibilityFilter` in Phase 3.
- `access_grants.expires_at`, `can_view_restricted` — always default until Phase 3.

DDL **import** (spec §6.4) deliberately has no table: parse-and-preview is one stateless
request returning the preview plus the unsupported-statement report, and applying it is a
second request carrying the same DDL. Nothing has to survive between the two, so nothing
is stored. Bulk import inserts through `createMany` inside one transaction rather than
row-at-a-time — a 300-table DDL is on the order of 10,000 `fields` rows, each maintaining
six indexes.

## Key decisions

1. **The live schema is ten relational tables; JSON appears only in `snapshots.ir`.**
   C3, and it is what makes per-object permissions, per-object `version`, comments on a
   single column and partial reads possible at all.
2. **`project_id` is denormalised all the way down to `index_columns` and
   `link_endpoints`.** C6. Loading a project becomes eleven parallel single-index scans
   with zero joins, and purging one becomes sixteen flat deletes that leave every trigger
   nothing to find.
3. **Engine-specific vocabulary never gets a core column.** FK actions, index predicates,
   operator classes, enum labels, type parameters all live in `engine_props`, validated
   by the engine's zod schema. Adding MongoDB must not require a migration (C4).
4. **`Area` has no `engine_props` and no engine involvement.** It is a canvas/organisation
   concept the core owns, not one of the seven IR object kinds in spec §3.1. Giving it
   `engine_props` would invite an engine to put meaning there.
5. **Foreign keys are `Link` rows, not `Constraint` rows.** The canvas draws them, the AI
   join-path resolver walks them, and the exporter can emit a `CONSTRAINT` from a `Link`
   trivially. Modelling them as constraints would mean the edge list is a filtered scan of
   a polymorphic constraint table.
6. **`link_endpoints` exists from day one so composite foreign keys work.** Multi-tenant
   schemas use them constantly, and adding the table later means migrating every link.
7. **`access_grants` is polymorphic on both sides, and pays for it in `0002`.** The
   resolver's single hot query (`project_id` + `(principal_type, principal_id)`) is worth
   more than the four FKs an exclusive-arc design would give; the lost integrity is bought
   back by named check constraints, partial uniques and two trigger functions.
8. **Built-in and custom roles share one table.** The resolver has one code path, and the
   sharing dialog has one list. Built-ins are `organization_id IS NULL`, guarded by
   `roles_builtin_global_ck`.
9. **A share link is a principal, and its session is stateless.** `share_links` holds the
   token and the policy; the scope and role live in an ordinary `access_grant` whose
   principal is the link, so the resolver has no share-link branch except the view-only
   ceiling. The visitor carries a signed `sl_session` cookie — there is **no** `sessions`
   row, because a share-link visitor has no user and `sessions.user_id` is NOT NULL.
   Revocation sets `revoked_at` **and** deletes the grant, so two independent things have
   to fail for a revoked link to keep working; the cookie is not revoked and does not need
   to be.
10. **`position` is never unique.** Reorders renumber siblings in one transaction; partial
    unique indexes cannot be deferred in PostgreSQL, so uniqueness here would buy a
    constraint violation rather than an ordering guarantee. `ORDER BY position, id`.
11. **Users are hard-deleted; their work is `SetNull` and their name is denormalised into
    the logs.** C8 gives tombstones only to projects and orgs, and GDPR erasure wants a
    real delete — but `activity_log.actor_name` and `audit_log.actor_email` keep the
    history readable.
12. **Nothing can erase the audit trail by cascade.** Both `audit_log.project_id` and
    `audit_log.organization_id` are `SetNull`, with `organization_name` denormalised
    alongside `actor_email`. A trail a deletion can erase is not a trail; erasure is a
    reviewable retention job, not a referential action.
13. **Three trigger functions, none of them generic.** `purge_polymorphic_refs`,
    `purge_empty_index`, `purge_empty_keyed_constraint` and the one-line
    `purge_share_link_grants` make orphaned docs, comments, grants and zero-column indexes
    structurally impossible. The earlier single generic `purge_empty_owner` — `format()`,
    `EXECUTE`, three `TG_ARGV` slots and a raw SQL-fragment escape hatch — served three
    call sites of three different shapes, built SQL at runtime on every child delete, and
    was the hardest thing in the file to read. Same line count, no dynamic SQL.
14. **Five FKs are `NO ACTION DEFERRABLE INITIALLY DEFERRED`, not `RESTRICT`.** `RESTRICT`
    under a cascading parent fires mid-cascade and makes org deletion and project purge
    fail in an order-dependent way (§8.6). The product rules those FKs encoded moved to the
    services that can actually offer the user a fix.
15. **`mentioned_ids text[]` instead of a `comment_mentions` table.** The value is only
    ever read whole. A join table would be a table, an index, a cascade and a migration
    for nothing.
16. **Permission atoms and notification kinds are `String`, not PostgreSQL enums.**
    `ALTER TYPE … ADD VALUE` cannot be used in the transaction that added the value, so a
    migration adding an atom and seeding it into a role fails and has to be split across
    two deploys. The zod union in `contracts` was already the source of truth for the API;
    now it is the only one. Enums stay where the set is genuinely closed and structural.
17. **`SchemaIndex` / `SchemaIndexColumn` are the only models whose Prisma name is not the
    singular of the table name.** `prisma.index` is a landmine in a product about database
    indexes.
18. **The whole permission model ships in `0001` even though Phase 1 writes one grant per
    project.** Migrating a live permission model is the specific pain this design pass
    exists to avoid.
19. **Permission-cache invalidation is three `perm_generation` columns in PostgreSQL, not
    an epoch in Redis.** Committed with the change they describe, so a crash or an eviction
    cannot leave a stale entry valid forever, and a Redis flush narrows access instead of
    widening it. Three scopes (org / project / user) instead of one is what removes the
    fan-out problem — a role edit has no project in scope, and a single per-project epoch
    would have left a demoted admin an admin indefinitely.
20. **Offboarding is enforced by liveness, not by cleanup.** A `user` grant only counts if
    that user is still an `OrgMember` of the grant's org — a lookup the resolver already
    performs. The cleanup that deletes their grants runs in the same transaction as the
    membership delete, but it is hygiene: if it were ever missed, access would still be
    gone.
21. **Canvas geometry is outside C7, and ordered child rows are versioned by their
    parent.** Auto-layout on 300 entities must not 409 every open property panel, and a
    composite key's column order must not be last-write-wins. Both are stated rules with
    code shapes in §9.3 and §10.4, not inferences.
22. **Uniqueness has exactly one canonical representation** (§10.5): table-level UNIQUE is
    a `Constraint`, `indexes.is_unique` is only for partial/expression unique indexes.
    Two self-consistent conventions would both pass the round-trip test and break the
    `one_to_one` exporter check.
23. **One `refs Json` column per `engine_props`-bearing table, not three `*_referenced_ids`
    arrays.** It is the only thing that lets core redact an expression C4 forbids it to parse
    (doc 05 R27), it is written by the engine's `extractReferences` (doc 03 §3.1), and it covers
    the case the narrower arrays missed entirely — `CREATE INDEX ON employees ((salary * 12))`,
    which names no field id at all.
24. **Engine *plugin* version is a column, separate from `engine_version`.** `engine_version` is
    the target database ("16"); `engine_plugin_version` is the contract version the stored
    `engine_props` were written under, on `projects` **and** on `snapshots`, so a cross-major
    restore is refused instead of writing rows no later edit can save.
25. **`fields.depth` is deleted.** It was a derived value the application had to maintain
    correctly, it was the single point of failure for the no-cycles argument, and nothing
    queried it. The ceiling and the cycle check both come from the one recursive CTE that
    `reparentField` has to run anyway, and the CTE is `UNION` so it terminates regardless.

## Open questions

Everything a reviewer could resolve from the spec, from doc 04 or from doc 05 has been
resolved in the body above. What is left is genuinely for the user.

1. **`docs` and `comments` polymorphism could be an exclusive arc.** Both have a closed,
   four-value target set and no hot multi-branch query, so nullable
   `project_id/area_id/entity_id/field_id` columns with `num_nonnulls(...) = 1` would give
   real cascading FKs, a real database guarantee that the target belongs to the project
   (which §5/§6 currently place on the writer), and would delete `purge_polymorphic_refs`
   entirely. Spec §9 names `target_type, target_id`, and one polymorphic convention beats
   two, so this document follows the spec — but if you would rather have the FKs, this is
   the cheapest thing in the schema to change, and now is the moment. **Needs a decision.**
2. **`activity_log` and `audit_log` overlap.** They differ in scope key (project vs org),
   retention and what a deletion does to them, which is why they are two tables. If you
   are willing to accept one retention policy and one scope column, they collapse into
   one. I kept two because spec §9 names both and because compliance retention is a
   different conversation from a feed. **Assumption, worth confirming.**
3. **Audit-log retention after an org is deleted.** §8.4 keeps the rows with
   `organization_id = NULL` rather than cascading them away, and hands the deletion to a
   retention job. **What is the retention period, and does a deleted tenant's trail have
   to be exported before it is dropped?** That is a contract/GDPR question this document
   cannot answer; the schema is shaped so either answer is implementable. **Needs a
   decision.**
4. **Snapshot size and snapshot scope.** `snapshots.ir` is a `jsonb` blob; a 300-entity
   project with docs will be a few megabytes, TOASTed — fine for tens of snapshots per
   project, bad for thousands. Move to object storage with a pointer, or store deltas,
   when it hurts. Related and already decided in the body: because the blob cannot be
   filtered, snapshot read and restore require a **project-scoped** grant, so an
   area-scoped Editor cannot use history at all. That is the conservative reading of spec
   §5 and it may be stricter than you want. **Assumption.**
5. **Id arrays in JSON columns are best-effort and unswept.** `ai_threads.selection`,
   `ai_messages.metadata.{usedEntityIds,suggestedEntityIds}`, `comments.mentioned_ids` and
   `docs.structured.ownerUserId` all hold ids of rows that can be deleted with nothing
   sweeping them. The stated behaviour: readers drop ids that no longer resolve, except
   the AI thread, which *tells the user* ("3 selected tables no longer exist") because
   silently answering about a smaller schema than the user selected is worse. If any of
   these should instead be a real FK — `ownerUserId` is the plausible one, if "fields I
   own" becomes a screen — say so now. **Assumption.**
6. **`is_restricted` is on the field, but "who may see restricted fields" is an atom plus a
   per-grant toggle.** Restriction is therefore all-or-nothing per grant: there is no
   "Ana may see `salary` but not `ssn`". Spec §5 reads that way, and per-field ACLs would
   multiply the grant table by the field count. Flagging it because it is the first thing
   an enterprise customer will ask for. **Assumption.**
7. **Over-built, per C12, and designed anyway because the spec asks for it:**
   - `custom_types` — PostgreSQL enums, domains and composites are a real feature, but
     Phase 1 users will overwhelmingly draw tables and columns. Nothing in Phases 1–4
     depends on it, and it brings the `fields.data_type` denormalisation rule (§8.3) with
     it, which is the sharpest maintenance edge in the schema.
   - `constraints` + `constraint_columns` as a general table, when Phase 1 realistically
     needs primary key, unique and check. The general shape costs nothing extra, so this is
     a note rather than an objection.
   - `link_cardinality` as a database enum, when cardinality is a drawing annotation the
     engine could keep in `engine_props`. It is a core column because the canvas renders
     crow's-foot notation generically, without asking the engine — and a database enum
     rather than a String because doc 04 pins the set to exactly four values. The first
     request for `zero_or_one` costs an `ALTER TYPE`.
   - `doc_drafts` and `export_jobs` are Phase 5 / Phase 1-partial tables created empty in
     `0001`. They are here because spec §6.2 demands per-suggestion accept/reject and spec
     §2 demands S3-backed export jobs, and because an empty table costs nothing while a
     retrofit costs a release.
8. **Nesting depth is capped at `MAX_FIELD_DEPTH` (8, doc 04 §4) and `engine.capabilities.supportsNestedFields` is not
   consulted by the database.** A PostgreSQL project could technically store a nested
   field; only the engine validator stops it. Acceptable, but it means the validator is
   load-bearing for data integrity, not just UX — and now that `fields.depth` is gone, the
   *ceiling* is application-enforced too. The cycle check is not: it is a structural
   consequence of the `UNION` CTE in `reparentField`. **Assumption.**
9. ~~**Three columns this document declines to add that doc 05's sketches show.**~~ **Closed.**
   Doc 05 adopted this document's column set wholesale (`Role.isBuiltIn` not `scope`; no resource
   pointer on `ShareLink`; the partial unique on `access_requests`), and this document adopted
   doc 05's four additions (`canViewRestricted`, three `perm_generation` counters) and kept
   `restrictedFieldMode` as a real column, which doc 05 also wanted. The reconciliation table is
   in "Who owns what, across documents" at the top. **Nothing left to decide.**
10. **Seven `refs` columns and three version/revision columns were added late** for docs 03–05
    (`refs` on every `engine_props`-bearing table, `projects.engine_plugin_version`,
    `projects.schema_revision`, `snapshots.engine_plugin_version`). Each has a named consumer and
    a stated failure mode if absent, and each is one column rather than a table — but they are
    ten columns that did not exist when this schema was first drawn, so they deserve a look.
    `schema_revision` is the softest of them: its only consumer is the engine-diagnostics cache
    key, and if diagnostics turn out not to need caching in Phase 1 it can go. **Assumption.**

