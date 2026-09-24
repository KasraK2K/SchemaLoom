# SchemaLoom Phase 1 — design review and approval

Five design documents, 14,589 lines. This is the reviewable version: everything here is decided,
the detail is in the five documents (§6), and no code has been written.

## 1. What you are approving

- **Folder structure** — one pnpm/Turborepo monorepo: 2 apps, 7 packages, 1 e2e package. The
  dependency graph is a 7-level DAG, `schema-model` depends on nothing but zod, and acyclicity is
  enforced by pnpm's isolated `node_modules` plus Turborepo's cycle check, not by lint.
- **Prisma schema** — 39 models, 13 enums, all created in migration `0001` (including the
  permission tables, empty until Phase 3). `access_grants` is polymorphic on both resource and
  principal, with `organization_id` and `project_id` denormalised so a permission resolve is one
  index scan and offboarding is one statement.
- **Engine SDK** — `EngineDefinition` splits into an `EngineStaticFacet` (browser-safe data and
  pure functions) and the server half. 10 capability atoms, down from 33, plus 12 derived helpers.
  Adding MongoDB later touches four lines outside its two new packages and needs no migration.
- **IR types** — normalized maps keyed by id, eight object types, no nesting anywhere in the
  persisted or transported shape. **Rows are the truth; the IR is the read model.** The only
  schema write API is a typed `SchemaOperation` batch — not IR patches, not per-object REST.
- **Permission resolution** — 9 atoms, 5 built-in roles in a strict superset chain, per-principal
  nearest-level-wins unioned across principals, no deny grants, and an inescapable org
  owner/admin short-circuit.

## 2. The five deliverables

### 2.1 Folder structure

```
schemaloom/
├─ apps/api/                      NestJS — the only thing that talks to Postgres
├─ apps/web/                      Next.js App Router
├─ packages/
│  ├─ schema-model/               engine-neutral IR + diff. Depends on zod only.
│  ├─ engine-sdk/                 EngineDefinition + EngineUiPlugin + conformance suite
│  ├─ contracts/                  zod request/response schemas, DTOs, permission atoms
│  ├─ engines/postgresql/         EngineDefinition (server) + ./static descriptor
│  ├─ engines/postgresql-ui/      EngineUiPlugin (React)
│  ├─ ui/                         Radix + Tailwind component library
│  └─ config/                     tsconfig / eslint / tailwind / tsup / vitest presets
├─ e2e/                           Playwright, drives web+api over HTTP
├─ docker-compose.yml             postgres / redis / minio / mailpit
└─ turbo.json, pnpm-workspace.yaml, .env.example, .nvmrc (22)
```

`schema-model` is split from `contracts` because the IR is *domain* (no HTTP shape) and contracts
is *transport*: merging them drags pagination and error envelopes into `engine-sdk`'s closure and
breaks "schema-model depends on nothing but zod". `engines/` is a nested folder so a second engine
is visibly a drop-in sibling. `e2e` is its own package because it exercises both apps and belongs
to neither — an ownership choice, not a tooling limit: `test:e2e` `dependsOn` both apps' `#build`.

**Dependency DAG** — an edge only ever points to a lower level; that is the cycle proof.

| Level | Packages |
|---|---|
| 0 | `zod`, `react`, `libpg-query` (externals) |
| 1 | `schema-model`, `ui` |
| 2 | `engine-sdk` (`.`), `contracts` |
| 3 | `engine-sdk/ui`, `engine-sdk/conformance`, `engine-postgresql/static` |
| 4 | `engine-postgresql` (`.`), `engine-postgresql-ui` |
| 5 | `apps/api`, `apps/web` |
| 6 | `e2e` (imports `contracts` only; drives both apps over HTTP) |

`apps/api → schema-model` and `apps/web → schema-model` are declared directly, not inherited
through the engine: under `node-linker=isolated` an undeclared import is a hard resolution failure
— the same property that keeps React out of the API bundle. Packages are **compiled with tsup**,
not consumed as source, and `engine-sdk/ui` imports React type-only.

### 2.2 The Prisma schema

39 models, 13 enums, all created in `0001` — retrofitting `access_grants` and `roles` onto a live
database means backfilling every project, locking the busiest table and rewriting every guard in
one release, and an empty table costs nothing.

| Models | Purpose | Phase |
|---|---|:--:|
| `users`, `accounts`, `sessions`, `verification_tokens`, `recovery_codes` | Identity, OAuth links, device sessions, magic-link/TOTP tokens | 1 |
| `organizations`, `org_members` | Tenant plus membership carrying the org role | 1 |
| `workspaces`, `projects` | Project containers; `projects` holds engineId, settings, `restricted_field_mode`, `perm_generation` | 1 |
| `namespaces`, `areas` | Engine schema grouping; areas are canvas grouping **and** a permission resource | 1 |
| `entities`, `fields` | Table/view/collection/node and its columns, nested via `parent_field_id` | 1 |
| `links`, `link_endpoints` | FK / reference / graph edge; one endpoint row carries both field ids | 1 |
| `indexes`, `index_columns`, `constraints`, `constraint_columns` | Indexes plus PK/UNIQUE/CHECK/EXCLUDE — FKs are links, not constraints | 1 |
| `custom_types`, `docs` | Enums/domains/composites; one TipTap doc plus structured facts per target | 1 |
| `roles` | Five built-in rows seeded by `0003` | 1 rows / 3 UI |
| `access_grants` | The permission table. Phase 1 writes one project-scope grant per project | 1 / 3 |
| `invitations`, `export_jobs` | Org invites (`access_grant_id` null until Phase 3); the export queue | 1 |
| `activity_log`, `audit_log` | Feed plus security trail (org id nullable, org name denormalised) | 1 |
| `ai_threads`, `ai_messages`, `saved_queries`, `saved_query_entities` | AI transcripts; query library plus its resolved-identifier join rows | 2 |
| `user_groups`, `group_members`, `share_links`, `access_requests` | Groups as grant principals; public view links; request-access flow | 3 |
| `comments`, `snapshots` | Threaded comments; named versions, the source for diff and migration | 4 |
| `notifications`, `doc_drafts` | In-app and email notifications; AI doc-draft staging | 4 / 5 |

**`access_grants`** — the shape the whole permission system rests on:

```prisma
model AccessGrant {
  id             String        @id @default(cuid())
  organizationId String        @map("organization_id")  // denormalised: resolve needs no join
  projectId      String        @map("project_id")       // == resourceId when resourceType=project
  resourceType   ResourceType  @map("resource_type")    // project | area | entity
  resourceId     String        @map("resource_id")
  principalType  PrincipalType @map("principal_type")   // user | group | email_invite | share_link
  principalId    String        @map("principal_id")     // users.id | user_groups.id | email | share_links.id
  roleId         String        @map("role_id")
  canUseAi          Boolean    @default(false) @map("can_use_ai")
  canViewRestricted Boolean    @default(false) @map("can_view_restricted")
  note           String?       // "contractor until Q3", shown in Who-has-access
  createdById    String?       @map("created_by_id")
  expiresAt      DateTime?     @map("expires_at") @db.Timestamptz(6)

  @@unique([resourceType, resourceId, principalType, principalId])
  @@index([projectId, principalType, principalId])   // THE hot path
  @@index([principalType, principalId])              // projects list + offboarding delete
  @@index([projectId, resourceType, resourceId])     // "who has access to this"
  @@map("access_grants")
}
```

The two toggles are **additive only** — a grant's effective atoms are
`role.atoms ∪ {ai:use if canUseAi} ∪ {field:viewRestricted if canViewRestricted}`, so a toggle
can add an atom and never remove one. `expires_at` is a SQL predicate on every resolve, not a
sweep job.

**`fields`** — the table that carries the nesting model and the restriction flag:

```prisma
model Field {
  id             String   @id @default(cuid())
  projectId      String   @map("project_id")
  entityId       String   @map("entity_id")
  parentFieldId  String?  @map("parent_field_id")   // null = top level
  name           String
  dataType       String   @map("data_type")         // denormalised when customTypeId is set
  customTypeId   String?  @map("custom_type_id")
  typeArgs       Json     @default("[]")  @map("type_args")        // numeric(10,2) -> [10,2]
  typeDimensions Int      @default(0)     @map("type_dimensions")  // text[][] -> 2
  position       Int      @default(0)
  isNullable     Boolean  @default(true)  @map("is_nullable")
  isRestricted   Boolean  @default(false) @map("is_restricted")   // the permission column
  isPii          Boolean  @default(false) @map("is_pii")
  isDeprecated   Boolean  @default(false) @map("is_deprecated")
  engineProps    Json     @default("{}")  @map("engine_props")
  refs           Json     // { entityIds: [], fieldIds: [] } — see below
  version        Int      @default(0)

  parent     Field?      @relation("FieldNesting", fields: [parentFieldId], references: [id], onDelete: Cascade)
  customType CustomType? @relation(fields: [customTypeId], references: [id], onDelete: NoAction)

  @@unique([id, entityId])   // target of the composite FK keeping a child inside its own entity
  @@index([entityId, position]) @@index([parentFieldId, position]) @@index([customTypeId])
  @@map("fields")
}
```

`refs` closes the expression leak: `engineProps.default` and `generatedExpression` name restricted
columns in plain text, so the engine declares the ids it references and the permission layer drops
the prop rather than shipping the string.

**Indexing.** Four hot paths were indexed and everything else left alone: load a project's schema
(every schema table carries `project_id`), resolve permissions (the grant index above plus the
`perm_generation` columns read in the same round trip), list a user's projects, and the activity
feed. There is deliberately **no** `fields(project_id, is_restricted)` index: the loader already
selects every field in the project, so the filter runs in memory, and a seventh index on the
largest table costs a write on every row of a 10,000-row DDL import for nothing.

**Polymorphism.** `access_grants` (two polymorphic pairs), `docs` and `comments`
(`target_type`/`target_id`) trade referential integrity for a fixed column count; four nullable
FK columns were rejected because every new resource type is then a migration on the hottest
table. What is lost is bought back explicitly: CHECK constraints reject nonsensical combinations,
the writer derives `project_id` from the target row and never from the request body, and a purge
trigger clears dangling refs.

**Cascades.** Five FKs are `NO ACTION DEFERRABLE INITIALLY DEFERRED`, because `RESTRICT` under a
cascading parent fires mid-cascade and made org delete fail in an order-dependent way; purge
deletes children explicitly in dependency order instead. `audit_log.organization_id` is nullable
`SET NULL` with the org name denormalised, so deleting a tenant cannot erase the trail.

### 2.3 `EngineDefinition` and the UI plugin

The definition is split in two. `EngineStaticFacet` is pure data and pure functions — it loads in
a browser. The full `EngineDefinition` adds the parts that need Node.

```ts
export interface EngineStaticFacet {
  readonly id: EngineId;
  readonly displayName: string;          // 'PostgreSQL'
  readonly version: string;              // semver of the BEHAVIOUR contract, not the package
  readonly paradigm: EngineParadigm;     // relational | document | key-value | wide-column | graph
  readonly icon: string; readonly summary: string;   // engine-picker card
  readonly capabilities: EngineCapabilities;
  readonly typeCatalog: TypeCatalog;
  readonly terminology: TerminologyBundle;   // the single home for every user-visible noun
  readonly diagnosticMessages: DiagnosticMessages;
  readonly propsSchemas: EnginePropsSchemas; // zod only — react-hook-form needs it client-side
}

export interface EngineDefinition extends EngineStaticFacet {
  readonly validator: EngineValidator;
  readonly importer: Importer;
  readonly exporter: Exporter;
  /** Adds risk semantics to a core diff. Core pre-sets only "a removed object is
   *  destructive"; varchar(255)->varchar(64) is engine knowledge. Pure, synchronous. */
  annotateDiff(diff: SchemaDiff, before: SchemaModel, after: SchemaModel): AnnotatedDiff;
  readonly migrationGenerator?: MigrationGenerator;   // Phase 4
  readonly queryValidator?: QueryValidator;           // Phase 2
  readonly aiProfile?: AiProfile;                     // Phase 2
  /** The engine's only obligation to the permission system. REQUIRED, and fails closed:
   *  an engine returning [] gets every expression-bearing prop dropped. */
  extractReferences(object: IrObject, subKind: string | null, model: SchemaModel): readonly IrObjectRef[];
}
```

The three optional services are optional *and* machine-checked: conformance asserts
`features.migrations === (migrationGenerator !== undefined)`, so an engine cannot advertise a
feature it has not implemented. That is what lets the Phase 1 PostgreSQL engine ship with no
`migration/` directory and fill it in later with no interface change. Deliberately absent: no
`linkRules` function (link legality is declarative data in `capabilities.linkKinds` evaluated by
one shared function, so canvas and server cannot drift), no lifecycle hooks, no `introspector`.

**Capability flags — 10 atoms**, cut from 33:

`nestedFields`, `notNull`, `links`, `referentialActions`, `indexes`, `expressionIndexes`,
`includeColumns`, `comments`, `migrations`, `queryValidation`.

Every deleted atom was one a descriptor already answered; they come back as 12 derived one-line
helpers (`supportsNamespaces`, `anyLinkKindEnforced`, `anyCompositeEndpoint`, `canExport`, …), so
there is one source of truth. `defineCapabilities` runs a 15-rule invariant table at construction
and throws `CapabilitiesContradictionError` on a contradiction.

**Proof the seam works — adding MongoDB later.** Two new packages
(`packages/engines/mongodb`, `packages/engines/mongodb-ui`), and outside them:

| File | Change |
|---|---|
| `apps/api/package.json` | one dependency line |
| `apps/api/src/engines/engines.manifest.ts` | one entry — `engines.module.ts` names no engine |
| `apps/web/package.json` | two dependency lines (`/static` plus the UI plugin) |
| `apps/web/src/engines/register.ts` | two `register(id, () => import(...))` lines |

**Not touched:** `apps/api/src/{schema,import,export,ai,access,snapshots,realtime,projects}/**`,
`apps/web/src/{canvas,inspector,docs,ai,sharing,palette}/**`, `packages/schema-model`,
`packages/contracts`, `packages/ui`, `prisma/schema.prisma` — **and no database migration**,
because nesting already exists (`fields.parent_field_id`) and everything MongoDB-specific lands in
`engineProps`. The facts that would normally force a core change absorb into `namespaces:
'optional'`, `LinkKindDescriptor.enforced: false`, `fieldsAreAuthoritative: false` and
`TerminologyBundle`.

### 2.4 The IR types

The root is normalized maps keyed by id, one per object type. Parent links are id references;
ordering is an explicit dense `ordinal`. No nesting in the persisted or transported shape — the
diff becomes a map lookup, `React.memo` holds on the other 299 cards when one entity changes, and
realtime patching is `objects.entity[id] = next`.

```ts
interface SchemaModel { irVersion: 1; projectId; engineId; engineVersion;
                        redacted: boolean; objects: IrCollections }
interface IrBase { id, name, version, engineProps, restricted?: true }

interface Entity extends IrBase {
  namespaceId: Id;
  kind: string;                  // engine-defined; core stores it, never branches on its value
  areaId: Id | null;             // explicit membership, NOT geometric containment
  position: Point; width?: number; height?: number;
  color: string | null; doc: DocRef | null;
}

interface Field extends IrBase {
  entityId: Id;
  parentFieldId: Id | null;      // flat-with-a-parent-pointer, mirrors the column exactly
  ordinal: number;               // dense 0..n-1 among siblings; SERVER-assigned on create
  type: TypeRef;
  isNullable: boolean; isRestricted: boolean; isPii: boolean; isDeprecated: boolean;
  doc: DocRef | null;
}

interface TypeRef {                        // no rendered `display` string — see below
  name: string;                            // "varchar", "numeric", or a CustomType name
  args?: readonly (string | number)[];     // numeric(10,2) -> [10,2] — CORE, a real column
  customTypeId?: Id | null;
  dimensions?: number;                     // 0/absent scalar, 1 array, 2 array-of-array
}

interface Link extends IrBase {
  kind: string;
  from: LinkEndpoint; to: LinkEndpoint;    // referencing side, referenced side
  cardinality: '1:1' | '1:N' | 'N:1' | 'N:M';
}
interface LinkEndpoint { entityId: Id; fieldIds: Id[] }   // paired by array index
```

A foreign key is a **Link**, not a Constraint — one user-visible concept, one object; `Constraint`
covers PK/UNIQUE/CHECK/EXCLUDE only. PK/FK/UNIQUE badges are derived through the index rather than
stored as field flags, so no denormalised flag can go stale. A link with zero endpoints on both
sides is legal (a graph edge with no key columns, or a line drawn before columns were chosen) and
is never swept. `TypeRef` carries no rendered `display` string: two renderers means guaranteed
drift on `varchar(255)` versus `character varying(255)`.

```ts
type PropertySeverity = 'structural' | 'governance' | 'documentation' | 'cosmetic';

interface SchemaDiff {
  irVersion: 1; engineId: string; from: SnapshotRef; to: SnapshotRef;
  redacted: boolean;                  // opsFromDiff throws on a redacted diff
  entries: DiffEntry[];               // one flat array, sorted by an opaque sortPath
  summary: { added; removed; changed; destructive;
             byObjectType: Record<IrObjectType, { added; removed; changed }> };
}

type DiffEntry =
  | (Base & { change: 'added';   after: IrObject })
  | (Base & { change: 'removed'; before: IrObject })
  | (Base & { change: 'changed'; before; after; properties: PropertyChange[];
              matchedBy: 'id' | 'logicalKey' | 'pinned' });   // 'pinned' = a human confirmed it
```

`governance` is a fourth severity covering `isRestricted`, `isPii` and `areaId`: they emit no
DDL, so the migration generator skips them, but `ignoreCosmetic` must never drop them — hiding a
permission change from the review meant to catch it is the failure mode.

**The consequential call: how IR changes are written back.**

> Rows are the truth. A typed `SchemaOperation` batch is the only write API. The IR is the read
> model. Clients patch their in-memory IR from the batch result; the server never rebuilds and
> re-sends a whole IR after a write.

One endpoint — `POST /projects/:projectId/schema/ops` — plus three siblings (geometry, import,
restore). Rejected, with the reason each lost:

- **Free-form IR patches (JSON Patch / immer).** The IR is derived, so `/objects/field/abc/name`
  translates back into a row update anyway — an update op with extra parsing and no type safety.
  Worse, JSON Patch can express writes the relational model cannot honour, so the server needs a
  whitelist of legal paths: the typed op list, written in a worse language.
- **Plain REST, one request per object.** "Create a table with five columns and a PK" is seven
  rows; an import is hundreds. One user gesture must be one transaction.
- **Full-IR PUT.** Loses per-object versions (concurrency degrades to last-write-wins over the
  whole project) and makes per-object permission checks impossible.

### 2.5 Permission resolution

**Nine atoms**, fixed: `schema:view`, `schema:edit`, `docs:edit`, `comment:create`, `ai:use`,
`export:run`, `history:view`, `sharing:manage`, `field:viewRestricted`. Stored as
`roles.atoms String[]`, not a Postgres enum — `ALTER TYPE … ADD VALUE` cannot be used in the
transaction that seeds it, and adding an atom is exactly what Phases 2–5 do. Every atom implies
`schema:view`; that closure is applied once at write time, so the resolver is a plain set union.

**Five built-in roles, a strict superset chain.** That chain is what makes "more specific
overrides broader" a well-defined strengthening or weakening rather than an incomparable swap.

| Atom | manager | editor | documenter | commenter | viewer |
|---|:--:|:--:|:--:|:--:|:--:|
| `schema:view` | yes | yes | yes | yes | yes |
| `export:run` | yes | yes | yes | yes | yes |
| `comment:create` | yes | yes | yes | yes | — |
| `docs:edit` | yes | yes | yes | — | — |
| `schema:edit` | yes | yes | — | — | — |
| `history:view` | yes | yes | — | — | — |
| `sharing:manage` | yes | — | — | — | — |
| `ai:use`, `field:viewRestricted` | grant toggle | grant toggle | grant toggle | grant toggle | grant toggle |

Org-level operations — billing, deleting the org, creating projects, managing members, groups and
custom roles — are **not** atoms; they are gated by `@RequireOrgRole('owner'|'admin')`, because
they are not resource-scoped and the atom set has no "org" resource type.

**The algorithm** (`resolveProject(subject, projectId)`):

```ts
const project = await loadProject(projectId);          // alive, org alive
if (!project) return EMPTY_MAP;
const skel = await resolver.skeleton(projectId);       // subject-independent, cached, FIRST

if (subject.kind === 'user') {
  const member = await orgMembership(subject.userId, project.organizationId);
  if (!member) return EMPTY_MAP;                                       // not in the org
  if (member.role === 'owner' || member.role === 'admin')
    return ALL_ACCESS_MAP(project, skel);                              // R13, grants not read
  principals = [`user:${uid}`, ...member.groupIds.map(g => `group:${g}`)];
} else {
  if (subject.projectId !== projectId) return EMPTY_MAP;
  principals = [`share_link:${subject.shareLinkId}`];
}

const grants = await liveGrants(projectId, principals, now());   // ONE statement, expiry in SQL
for (const p of principals) {                                    // R15: per-principal cascade
  pProject = g.project ? materialise(g.project) : EMPTY;
  for (const areaId of skel.areaIds)
    pArea[areaId] = g.area[areaId] ? materialise(g.area[areaId]) : pProject;
  for (const e of skel.entities)
    pEntity[e.id] = g.entity[e.id] ? materialise(g.entity[e.id])       // nearest = entity
                  : e.areaId       ? pArea[e.areaId]                   // nearest = area
                  :                  pProject;
  unionSharingManageDownward(pProject, pArea, pEntity);          // R5
}
projectAtoms = unionAll(perPrincipal.project);                   // R16: union across principals
areaAtoms    = unionByKey(perPrincipal.area,   skel.areaIds);
entityAtoms  = unionByKey(perPrincipal.entity, skel.entityIds);

if (subject.kind === 'share_link') intersectAll({ 'schema:view' });    // R17 ceiling
else if (orgRole === 'guest')      subtractAll('sharing:manage');

entityOverrides = entityAtoms.filter(e => !sameSet(e.atoms, e.inherited));  // ~2 KB, not 50 KB
validUntil = min(now + PERM_TTL, nearest grant or share-link expiry);
```

**The precedence rules the spec did not determine**, and how each was resolved:

- **R13 — org owner/admin short-circuit, inescapable.** Every resource resolves to all nine
  atoms; grants are not read at all. A narrowing grant on an admin is inert and the sharing
  dialog renders it struck through with "no effect — org admin". Demoting someone who can
  re-promote themselves in one click is theatre that misleads a compliance reader.
- **R14 — no deny grants, ever.** Default-deny; a grant can only add. This keeps the rule set
  monotone in the number of principals, which is what makes R16 safe to cache. "Editor on
  everything except this table" is expressed by granting at area or entity level instead.
- **R15 — per-principal nearest-level-wins.** For one principal, walk `entity → area → project`
  and stop at the first level with a live grant. That level decides that principal's contribution
  **entirely**; broader levels are discarded, not unioned. Project Editor plus area Viewer is
  therefore read-only in that area.
- **R16 — union across principals.** The deciding level is computed per principal, not once for
  the subject. The alternative lets one entity-level grant to some group silently demote an
  unrelated project-level editor. The invariant people expect holds: adding a principal or a
  grant never removes anyone's access.
- **R17 — subject-class ceilings intersected last.** Share-link subjects are intersected with
  `{schema:view}` whatever role the link carries; guests have `sharing:manage` subtracted. The
  only cap in the algorithm, and it is code, not data.
- **R18 — determinism.** Unions and intersections only: order-independent, independent of which
  grant was created first, a pure function of (org role, groups, live grants, skeleton,
  `restrictedFieldMode`, now).

**Caching.** One shape (`ProjectPermissionMap`) in Redis with a TTL, keyed by three
`perm_generation` counters read from Postgres in the same round trip as the project row. The
Redis mirror of those counters was deleted: it created a write-back-versus-DEL race that
resurrected revoked grants for up to 10 seconds under load. The staleness bound is now literally
"the next request".

## 3. Decisions that need your attention

| # | Decision | Why | What the alternative costs |
|---|---|---|---|
| 1 | **Masked fields disclose no name and no type.** | SchemaLoom stores no data — names and types *are* the content. Keeping them makes `field:viewRestricted` decorative and leaves the freelancer in your own workflow #2 reading `salary numeric(10,2)`. | Keeping name and type is friendlier ("there is a salary column you cannot see") but it is the leak. Reversing later changes the wire shape and every redaction test. |
| 2 | **No deny grants.** | Deny plus inheritance plus groups is the classic ACL pathology; monotonicity is what makes the cache safe. | Adding deny later is not a feature, it is a rewrite of the resolver and every cached map. |
| 3 | **Org admins always see everything, inescapably.** | They can edit the grant in one click. Reads of restricted fields are audit-logged. | A regime requiring "admins cannot read PII" needs break-glass or a real deny mechanism — a different product feature, not a config flag. |
| 4 | **Per-principal nearest-level-wins, unioned across principals.** | Adding a grant never takes access away from anyone. | The simpler "one deciding level per subject" is easier to explain and silently demotes people. Changing this after launch changes who can see what, overnight. |
| 5 | **Rows are the truth; one typed op batch is the only write API.** | One gesture, one transaction, one permission check, one broadcast. | Per-object REST is easier to start and gives you half-created tables. Moving off it later means rewriting the client's entire write path. |
| 6 | **Polymorphic `access_grants` / `docs` / `comments`.** | Fixed column count; a new target type is not a migration on the hottest table. | Exclusive-arc FKs give real database integrity. This is the cheapest thing in the schema to change **now** and among the more expensive later. |
| 7 | **All 39 models in migration `0001`.** | Retrofitting the permission tables onto a live database is a backfill plus a lock plus a guard rewrite in one release. | Nothing, beyond a dozen empty tables and Prisma models nobody imports yet. |
| 8 | **No engine `propsMigrations`.** A major engine bump opens the project **read-only** until an operator runs a job. | The upgrade-on-open subsystem had four race conditions; this is one paragraph instead of a subsystem. | It is a commitment to write that operator job *before* the first breaking engine change ships. It does not exist yet. |
| 9 | **Capability atoms cut from 33 to 10.** | Every deleted atom was already answered by a descriptor; duplication is how two sources of truth drift. | Restoring one is additive and machine-checked by conformance, so this is cheap to reverse. |
| 10 | **Generation counters read from Postgres on every resolve.** | Removes the revoke race; the staleness bound becomes "the next request". | One extra round trip per resolve, mitigated by reading it with the project row. If measurement says it hurts, a CAS-Lua mirror is the upgrade path. |
| 11 | **`export:run` in every role including viewer; `history:view` starts at editor.** | A viewer can already read the whole redacted schema; withholding export is defeated by a screenshot. History is for people who change things, and snapshots are the largest redaction surface. | "Read-only auditor" and "viewer, no export" both become custom roles — Phase 3. |
| 12 | **The rename heuristic is deleted.** Only human-pinned renames are matched. | The scoring could not detect an entity rename at all (max 0.50 against a 0.6 threshold) and could score 1.20 on a 0..1 scale. | Until Phase 4 builds a real candidate generator, a rename shows as a drop plus an add in the diff and in the generated migration. |

## 4. Open questions, ranked by rework cost

| # | Question | Recommended default |
|---|---|---|
| 1 | **Masked-field shape conflict.** Docs 04 and 05 currently give opposite answers on whether a masked field keeps its name and type. The most security-relevant disagreement between the documents. | Doc 05 wins — blank name, type and flags. Doc 04's paragraph is edited before any code. Needs your explicit yes. |
| 2 | **Workspace-level sharing is not expressible.** The grantable set is fixed to project / area / entity. | Ship without it. It is cheap now (one enum value, one ancestry step) and expensive after launch — decide before implementation starts, not after. |
| 3 | **`docs`/`comments` polymorphism versus exclusive-arc FKs.** | Keep polymorphic, since your spec §9 names `target_type`/`target_id`. If you want database-level integrity here, now is the moment — it is the cheapest schema change on this list. |
| 4 | **Engines cannot literally "register themselves at startup"** without a side-effecting import. Substituted a one-line manifest file outside the module. | Accept the manifest. The alternative is a registration side effect on `EngineDefinition`, which makes the definition impure. |
| 5 | **Redacted-IR size is unmeasured.** A 300-entity project's redacted model has no measured serialised size or assembly time. | Measure before Phase 1 closes. Above roughly 1 MB gzipped the canvas query must be paginated by area before the canvas ships. |
| 6 | **Area geometry.** `Area.rect` was deleted; the canvas derives an area's region from its members' bounding box, so an empty area exists only in the sidebar legend. | Accept the derived box. Hand-drawn area rectangles that entities join by being dropped inside them is four columns and the opposite decision — say now if you want it. |
| 7 | **Client-generated ids.** The server accepts a caller-chosen primary key. | Keep it — it makes optimistic canvas creation trivial. Confirm you are comfortable with it. |
| 8 | **Snapshots and exports are project-scoped only.** An area-scoped editor cannot use history at all and cannot export. | Accept for v1. An area-scoped export endpoint is small but is not in the spec. |
| 9 | **Restriction is all-or-nothing per grant.** No "Ana may see `salary` but not `ssn`". | Accept. Per-field ACLs multiply the grant table by the field count. |
| 10 | **Audit-log retention after an org is deleted.** Rows survive with `organization_id` NULL. | Pick a retention period and say whether a deleted tenant's trail must be exported before it is dropped. The schema is shaped so either answer works. |

## 5. Deliberately not being built in Phase 1

- **Engines:** PostgreSQL only. No MySQL, no MongoDB — §2.3 is the proof the seam holds.
- **On the engine itself:** no `migrationGenerator` (Phase 4), no `queryValidator` (Phase 2), no
  `aiProfile` (Phase 2), no `introspector` at all, no `propsMigrations`, no rename heuristic.
- **Permissions:** grants are written at **project scope only** — one per project, creator as
  manager. Area and entity scope, groups, share links, access requests, the custom-role editor
  and enforcement of `field:viewRestricted` are all Phase 3. The resolver already walks the full
  `entity → area → project` chain; it simply never finds a narrower grant yet.
- **Features:** no comments, snapshots, notifications or diff UI (Phase 4); no AI or saved-query
  library (Phase 2); no doc drafting and no PDF export (Phase 5). Image export is client-rendered
  and uploaded via presigned PUT — `apps/api` has no headless browser.
- **Repo:** no `apps/worker` (BullMQ processors run in the API process — a load question, not a
  design one), no `packages/emails`, no changesets (nothing is published), no `infra/` and no
  application Dockerfile — hosting is undecided.
- **CI:** no Turborepo remote caching; e2e is Chromium only; integration tests run serially (fine
  at ~30 tests, a coffee break at 300 — the schema-per-worker upgrade is scoped and named, and
  nobody is to "fix" the slowness with retries).
- **DDL import** has no table at all: parse-and-preview is one stateless request, applying it is
  a second request carrying the same DDL. Nothing survives between the two, so nothing is stored.

## 6. Where the detail lives

| Document | Lines | What to read it for |
|---|--:|---|
| `docs/phase1/01-repo-layout.md` | 2,296 | Full tree, NestJS module list, guard chain, the workspace DAG proof, pnpm/Turborepo/tsup config, docker-compose, env var inventory, test layout, CI workflow |
| `docs/phase1/02-prisma-schema.md` | 3,604 | The schema itself (§1), the hand-written SQL migration, indexing strategy per hot path, the polymorphism cost and buy-back argument, JSONB columns and their zod guards, cascade behaviour, field nesting, link endpoints, migration ordering |
| `docs/phase1/03-engine-sdk.md` | 3,250 | `EngineCapabilities` in full, `TypeCatalog`, link rules, importer/exporter/migration/query-validator/AI interfaces, the engine registry, versioning, the whole frontend `EngineUiPlugin` contract, the conformance suite, the MongoDB proof |
| `docs/phase1/04-schema-model-ir.md` | 2,665 | All eight object types and their zod schemas, identity and logical keys, the diff engine and its matching algorithm, row-to-IR assembly, the operation type and its permission requirements, realtime/restore/cascade, the redacted IR shape, traversal helpers |
| `docs/phase1/05-permission-resolution.md` | 2,774 | Atom-to-operation table, custom roles, the full resolver with a worked example for every ambiguity, `VisibilityFilter` and its information-leak audit, caching and invalidation, the guard decorators, the test matrix, two end-to-end workflow traces |

Each document ends with its own numbered **Key decisions** and **Open questions** — the next level
of detail down from this review.
