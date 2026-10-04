# 05 — Permission model, resolution algorithm, and VisibilityFilter

**Status:** design pass. No source files. All code in this document is a fenced block.
**Owns:** the permission atom set, roles, the `AccessGrant` / `Role` / `ShareLink` /
`AccessRequest` **semantics**, `PermissionResolver`, `VisibilityFilter`, `@RequirePermission` /
`PermissionGuard`, the permission cache, and the redaction rules.
**Obeys:** C1–C12 from SPEC §12.

This is the correctness-critical document. A bug here leaks a customer's salary column to a
freelancer. Everything below is written to be read as a rule set, not as prose — the numbered
rules (R1–R29, L1–L27, G1–G5, P1–P13) are citable from the other four documents and from tests.

---

## 1. Scope, and the three things this document fixes

1. **Resolution is a pure function of data.** `resolveProject(subject, projectId) -> map` does
   four small reads and then computes in memory. No I/O inside the rule evaluation, so the whole
   rule set is unit-testable without a database and snapshot-testable as a matrix (§11).
2. **Redaction happens once per request, in one place.** `redact` is the only function that turns
   a loaded `SchemaModel` into something serializable, and the raw model is physically
   unreachable outside it (§8.6) — not merely discouraged.
3. **Every ambiguity in SPEC §5 is resolved here with a worked example.** Where the spec was
   silent or self-contradicting, §13 records what I chose and §14 records what I want confirmed.

### 1.1 What this document assumes from siblings

The file numbers below are the real ones: `03-engine-sdk.md` is the engine SDK,
`04-schema-model-ir.md` is the IR. (An earlier draft had these two swapped; every cross-reference
in this revision is against the real files.)

| Assumed | From | Why I need it |
|---|---|---|
| `SchemaModel`, `IrBase`, `Entity`, `Field`, `Link`, `LinkEndpoint`, `Index`, `IndexColumn`, `Constraint`, `CustomType`, `Namespace`, `Area`, `IrPatch` | `packages/schema-model` (**doc 04**) | the thing being redacted |
| `IrBase.refs?: ObjectRefs` — **new requirement**, §8.3 and §14 Q8 | **doc 04** | I cannot redact an expression I cannot analyse |
| `IrBase.propsRedacted?: true` — **new requirement**, a second optional flag beside `restricted?: true` | **doc 04** | a visible object whose `engineProps` were blanked must say so |
| `redact` / `RawSchemaModel` / `RedactedModel` / `VisibilityContext` live in `schema-model` — **new requirement**, §8.6 | **doc 04** | true encapsulation of the raw model with no lint rule |
| `Exporter.export(input)` and `AiProfile.serializeContext(model, …)` take `RedactedModel` — **signature change** | **doc 03** (engine-sdk) | the single-path rule (§8.6) |
| `QueryValidationResult.touchedEntityIds` / `touchedFieldIds` | **doc 03** | the saved-query / AI-transcript filter (L25) |
| `User`, `Organization`, `OrgMember`, `UserGroup`, `GroupMember`, `Workspace`, `Project`, `Area`, `Entity`, `Field`, `Role`, `AccessGrant`, `ShareLink`, `AccessRequest`, `Invitation`, `SavedQuery`, `AiThread`, `AiMessage`, `AuditLog`, `ActivityLog`, `Notification` | **doc 02** (Prisma) | grants point at them |

**Ownership rule.** Doc 02 owns the Prisma models, their column names and their SQL. This
document owns their **semantics** and states the small set of columns it additionally requires
(§6.3). Where an earlier draft of this document invented a competing column name, this revision
adopts doc 02's. Remaining genuine disagreements are enumerated in §14 Q12 with a recommended
resolution each — that table is exhaustive, and nothing outside it is in dispute.

### 1.2 Phasing — what is load-bearing on day one

SPEC §11 ships permissions across four phases. The resolver algorithm **does not change**
between them: later phases add principal kinds and grant levels to a table the Phase 1 code
already reads generically. That is the whole point of designing it now.

| Phase | Ships | Rules that become live |
|---|---|---|
| **1** — orgs / workspaces / projects, canvas, docs, import/export | The nine atoms; `Role` seeded with the five built-ins (`isBuiltIn = true`); `AccessGrant` with **`user` principals at `project` scope only**; `PermissionResolver` whole; `PermissionGuard` + the boot-time route sweep + the 404/403 rule; `VisibilityFilter` with the §8.6 seam and the entity/field rules of §8.3; `canOpenProject`; `permGeneration`; `Field.isRestricted` and `Project.restrictedFieldMode` as real columns | R1, R2, R7, R8, R10, R12, R13, R15, R16, R18, R19, R20, R22; G1–G5; L1–L11, L14, L20–L24, L26, L27; R21′ on import and restore |
| **2** — AI assistant, saved queries | `ai:use` gating; the AI context path; the saved-query library | L12, L13, **L25** |
| **3** — roles, custom roles, groups, area/entity sharing, guests, share links, access requests | Custom roles; `group` principals; `area` / `entity` grants; `field:viewRestricted` grants; share links; access requests; the mask/hide UI | R3, R4, R4a, R5, R6, R9, R11, R17, R21; `resolveResource` (§7.7) |
| **4** — comments, realtime, snapshots, diffs, migrations, notifications | `redactPatch`; presence; notification rendering; history | L15, L16, L17, L18, L19; R21′ on migration generation |
| **5** — docs mode, AI doc drafting | Docs-mode read added to the share-link allow-list (R21) | — |

R14 (no denies) is a rule about what never exists; it is "live" from day one by absence.

**Phase 1 minimum, concretely.** Creating a project writes, in the same transaction, one grant
`{ resourceType: 'project', resourceId: project.id, principalType: 'user', principalId: creator,
roleId: manager }`. Everything else a Phase 1 user can do comes out of the org-role short-circuit
(R13) or that one grant. The boot sweep is on from the first commit — an unannotated route must
never be able to ship, and retrofitting that is exactly the risk this pass exists to remove.

---

## 2. The permission atom set

Fixed by C5. Nine atoms.

```ts
// packages/contracts/src/permissions.ts
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

export type PermissionAtom = (typeof PERMISSION_ATOMS)[number];
export type AtomSet = ReadonlySet<PermissionAtom>;
```

**Storage shape — doc 02's, adopted.** A role's atoms are stored as `roles.atoms String[]`
(doc 02 §1), **not** a PostgreSQL enum array, and there is no `permission_atom` type in the
database. An earlier draft of this document chose the enum for the typo-rejection it buys; doc 02
chose `String[]` and its argument wins: `ALTER TYPE … ADD VALUE` cannot be used in the same
transaction that added the value, so a migration that adds an atom **and seeds it into a role**
fails and has to be split across two deploys — and adding an atom is exactly the change phases
2–5 make. The tuple above is therefore the single source of the vocabulary, and the write path is
the enforcement: `permissionAtomSchema` (the zod enum derived from `PERMISSION_ATOMS`, doc 02 §7)
validates every element in `validateCustomRole` (§4.2) before the array is stored. The column is
`atoms`, not `permissions`; every query in this document names it that way.

### 2.1 Implication closure

**R1.** Every atom implies `schema:view`. There is no meaningful "edit docs but cannot see the
schema". The closure is applied **once, at write time** — when a `Role` row is saved and when a
grant is materialised (§7.5) — so the resolver itself is a plain set union with zero rule
evaluation.

```ts
export function closeAtoms(atoms: Iterable<PermissionAtom>): Set<PermissionAtom> {
  const s = new Set(atoms);
  if (s.size > 0) s.add('schema:view');   // R1 — the only implication
  return s;
}
```

If a future atom needs a richer implication graph, it goes in this one function. Deliberately
not a general rule engine: one line of real logic does not need one.

### 2.2 Atom → operations

`schema:view` is required by every row below and is not repeated in each cell.

| Atom | Permits | Exact API operations it gates |
|---|---|---|
| `schema:view` | Read the structure of the resource: entities, their fields, links, indexes, constraints, custom types, namespaces, canvas positions, areas, docs, comments, presence. | `GET /projects/:id/ir`, `GET /projects/:id/entities`, `GET /entities/:id`, `GET /links/:id`, `GET /projects/:id/search`, `GET /projects/:id/docs`, `GET /projects/:id/comments`, `GET /projects/:id/coverage`, `WS project:subscribe`, docs-mode read, query-editor autocomplete. |
| `schema:edit` | Create / update / delete entities, fields, links, indexes, constraints, custom types, namespaces, areas; move entities between areas; reorder fields; change canvas positions; apply a DDL import; restore a snapshot; set `field.isRestricted` to `true` (with R20); run autolayout. | **There is no per-object REST surface.** Doc 04 §8.2 makes `POST /projects/:projectId/schema/ops` the only write endpoint for the schema domain; the guard checks `@RequireProjectAccess('projectId')` and the service authorises each op through `requirementsOf(op, live)` + `resolver.assertAll` (§7.8, §10.4). The three siblings are `POST /projects/:id/schema/geometry` (doc 04 §8.11), `POST /projects/:id/import` and `POST /snapshots/:id/restore`, plus `POST /projects/:id/autolayout`. |
| `docs:edit` | Edit TipTap documentation on the project, an entity or a field; edit the structured field facts doc 02 stores in `docs.structured` (business meaning, allowed values, examples, unit, owner); accept/reject AI doc drafts; resolve any comment thread. **Not** `isPii` / `isDeprecated` / `isRestricted` — those are core IR columns on `Field` (doc 04 §2.6), written through a schema op and gated at `schema:edit` (doc 04 §8.5) or, for `isRestricted`, by R20. Doc 04 Open question 13 records the consequence: a Documenter cannot flag a column as PII today, and the smallest fix if product wants that is one extra row in doc 04 §8.5, not moving the columns. | `PUT /projects/:id/docs/:targetType/:targetId` (doc 04 §8.10 — the single docs write endpoint, carrying TipTap **and** the structured facts), `POST /ai/doc-drafts/:id/accept`, `POST /comments/:id/resolve` (for threads you did not author). |
| `comment:create` | Create comments and replies on entities and fields; edit and delete **your own** comments; resolve **your own** threads; @-mention. | `POST /comments`, `PATCH /comments/:id` (own), `DELETE /comments/:id` (own), `POST /comments/:id/resolve` (own thread). |
| `ai:use` | Run the AI query assistant, "explain this query", and enqueue AI doc drafting, scoped to the selection. Consumes the per-user and per-org AI rate limit. | `POST /ai/threads`, `POST /ai/threads/:id/messages` (SSE), `POST /ai/explain`, `POST /ai/doc-drafts`. |
| `export:run` | Produce an artefact from the **redacted** view: DDL, IR JSON, PNG/SVG of the diagram, docs as Markdown/PDF. Enqueues a BullMQ job. | `POST /projects/:id/exports`, `GET /exports/:id` (own jobs only). |
| `history:view` | List and read snapshots, view a visual diff, view the activity log, read a generated migration script. | `GET /projects/:id/snapshots`, `GET /snapshots/:id`, `GET /projects/:id/diff`, `GET /projects/:id/activity`, `GET /projects/:id/migration`. Note: **creating** a snapshot is `schema:edit`; generating a migration additionally requires R21′. |
| `sharing:manage` | Create/update/revoke grants on this resource and everything under it; create/revoke share links; approve or deny access requests; set `field.isRestricted` to `false`; change `project.restrictedFieldMode`; read the "Who has access" dialog including the explain view. | `GET/POST/PATCH/DELETE /projects/:id/access`, `POST/DELETE /share-links`, `POST /access-requests/:id/approve` and `/deny`, `PATCH /fields/:id/restricted` (unset), `PATCH /projects/:id/restricted-field-mode`. |
| `field:viewRestricted` | See the name, type, default, docs, `engineProps` and comments of fields with `isRestricted = true` **within this resource**; edit them when `schema:edit` is also held; include them in export and AI context. | Not a route of its own. It is consumed by `VisibilityFilter` (§8) and by the field-write path (§7.10). |

**Not atoms** (deliberately): billing, deleting the org, transferring ownership, creating a
project, managing org members / groups / workspaces / custom roles. These are **org-level
operations** gated by `@RequireOrgRole('owner' | 'admin')`. They are not resource-scoped, so
modelling them as atoms would mean inventing an "org" resource type, which C5 does not have.

---

## 3. Roles

### 3.1 Built-in resource roles are a strict chain

**R2.** The five built-in resource roles form a totally ordered chain: each is a strict superset
of the one below. This is a deliberate design constraint, not an accident. It makes the matrix
explainable in one sentence, makes "more specific grant overrides" (§7.4) a well-defined
strengthening or weakening rather than an incomparable swap, lets the "Who has access" UI sort
roles on a single axis, and makes the invite-collapse rule of R11 a one-liner.

```ts
const VIEWER     = ['schema:view', 'export:run'] as const;
const COMMENTER  = [...VIEWER,     'comment:create'] as const;
const DOCUMENTER = [...COMMENTER,  'docs:edit'] as const;
const EDITOR     = [...DOCUMENTER, 'schema:edit', 'history:view'] as const;
const MANAGER    = [...EDITOR,     'sharing:manage'] as const;

export const BUILT_IN_ROLES = {
  viewer:     closeAtoms(VIEWER),
  commenter:  closeAtoms(COMMENTER),
  documenter: closeAtoms(DOCUMENTER),
  editor:     closeAtoms(EDITOR),
  manager:    closeAtoms(MANAGER),
} satisfies Record<BuiltInResourceRole, Set<PermissionAtom>>;

/** Ascending. The index in this array IS the R2 order; nothing else defines it. */
export const BUILT_IN_ROLE_ORDER = [
  'viewer', 'commenter', 'documenter', 'editor', 'manager',
] as const;

export type BuiltInResourceRole = (typeof BUILT_IN_ROLE_ORDER)[number];
```

| Atom | manager | editor | documenter | commenter | viewer |
|---|:--:|:--:|:--:|:--:|:--:|
| `schema:view` | ✔ | ✔ | ✔ | ✔ | ✔ |
| `export:run` | ✔ | ✔ | ✔ | ✔ | ✔ |
| `comment:create` | ✔ | ✔ | ✔ | ✔ | — |
| `docs:edit` | ✔ | ✔ | ✔ | — | — |
| `schema:edit` | ✔ | ✔ | — | — | — |
| `history:view` | ✔ | ✔ | — | — | — |
| `sharing:manage` | ✔ | — | — | — | — |
| `ai:use` | grant toggle | grant toggle | grant toggle | grant toggle | grant toggle |
| `field:viewRestricted` | grant toggle | grant toggle | grant toggle | grant toggle | grant toggle |

Two notes on the two cells that are not obvious:

- **`export:run` is in every role including `viewer`.** A viewer can already read the whole
  redacted schema on screen; withholding "export" from them is theatre that a screenshot
  defeats. The atom still earns its place because a *custom* role can withhold it (an org with
  a real DLP requirement builds "Viewer (no export)"). Flagged in §14 Q4.
- **`history:view` starts at `editor`.** History is a change-tracking feature for people who
  change things, and snapshots are the largest redaction surface in the product (L18). If a
  customer wants read-only auditors, that is a custom role.

### 3.2 Org roles

Org role is a property of `OrgMember`, not a grant. It is resolved before grants and, for
owner/admin, instead of grants.

| | owner | admin | member | guest |
|---|:--:|:--:|:--:|:--:|
| Effective atoms on **every** resource in the org | **all 9** | **all 9** | none | none |
| Create a project (becomes `manager` on it via an auto-written grant) | ✔ | ✔ | ✔ | — |
| Manage org members, groups, custom roles | ✔ | ✔ | — | — |
| Create / rename / delete workspaces | ✔ | ✔ | — | — |
| List org members, groups, workspaces | ✔ | ✔ | ✔ | — |
| Billing | ✔ | — | — | — |
| Delete the org, transfer ownership | ✔ | — | — | — |
| Change another **owner's** role | ✔ | — | — | — |
| Can be the target of a resource grant | ✔ (inert) | ✔ (inert) | ✔ | ✔ |
| Can be granted `sharing:manage` | inert | inert | ✔ | **never** (R9) |
| Appears in @-mention autocomplete for other members | ✔ | ✔ | ✔ | only within resources they share (§7.7) |

A **guest** is a normal `User` whose `OrgMember.role = 'guest'`. There is no separate subject
kind for guests; everything a guest can do comes from grants. A guest may be a member of an org
group (that is how "all our contractors" works), and group grants apply to them normally.

---

## 4. Custom roles (Phase 3)

### 4.1 Storage

Doc 02 owns the model. Its shape, restated for reference, with this document's semantics:

```prisma
model Role {
  id             String           @id @default(cuid())
  organizationId String?          @map("organization_id")   // null iff isBuiltIn
  key            String                                     // 'viewer' … | 'analyst-ro'
  name           String
  description    String?
  atoms          String[]         @default([])              // closed set: closeAtoms() on write
  isBuiltIn      Boolean          @default(false) @map("is_built_in")
  isArchived     Boolean          @default(false) @map("is_archived")   // retirement, not
                                                                        // revocation: R12 does
                                                                        // not read it (§6.3)
  // timestamps per C9
  @@map("roles")
}
```

`isBuiltIn` replaces the `RoleScope` enum an earlier draft proposed — a two-value enum is a
boolean wearing a hat. The five built-in roles are seeded rows with `isBuiltIn = true`,
`organizationId = null`, so a grant always points at a `roleId` and the resolver has exactly one
code path. Built-in rows are immutable (doc 02 enforces this with a trigger); the seed script
asserts their atom sets match `BUILT_IN_ROLES` on boot and refuses to start on drift — a silently
mutated built-in role is a silent privilege change across every org.

**There is no `isArchived`.** An earlier draft made role archival part of grant liveness (R12);
the spec has no archival feature, doc 02 has no column, and `onDelete: Restrict` on
`AccessGrant.roleId` already forces an org to reassign grants before a custom role can be
deleted. One fewer liveness predicate, one fewer column, one fewer join predicate in the hot
query.

**R3 — custom roles are org-scoped, never project-scoped.** A role belongs to an organization and
can be used in any grant inside that organization. Project-scoped roles were considered and
rejected: they multiply the "which role is this" surface for no use case the spec names.
Cross-org use is prevented by a service assertion on every grant write:

```ts
// role must be a built-in, or belong to the project's own org
if (role.organizationId !== null && role.organizationId !== project.organizationId)
  throw new ForbiddenException({ code: 'role_cross_org' });
```

**This invariant is application-enforced, not database-enforced, and this document says so rather
than pretending.** A cross-table CHECK is not expressible in PostgreSQL without a trigger. The
database-level alternative is a composite foreign key — `UNIQUE (id, organization_id)` on `roles`
plus a two-column FK from `access_grants` — which does not work here because built-in roles have a
NULL `organizationId`, and a two-column FK cannot express "the role's org equals the grant's, *or*
the role is a built-in belonging to no org". (The grant does carry `organizationId`, §6.1; it is
the `roles` side that defeats the FK.) The chosen mitigation is
the assertion above plus the nightly integrity query of §7.15, which counts violations and alerts
on any non-zero result.

### 4.2 Validation on write

This function is **application code, not a contract**: it throws Nest exceptions and takes an
`Organization`, neither of which C10 permits in `packages/contracts`. `contracts` exports
`PERMISSION_ATOMS`, `closeAtoms`, `BUILT_IN_ROLES` and `BUILT_IN_ROLE_ORDER` and nothing else.

```ts
// apps/api/src/access/custom-role.service.ts
function validateCustomRole(input: { atoms: string[] }, actor: Subject, org: Organization) {
  // V1 — authorisation FIRST. Never validate input on behalf of someone who may not be here.
  requireOrgRole(actor, org, ['owner', 'admin']);

  // V2 — every atom is a known atom.
  const unknown = input.atoms.filter(a => !PERMISSION_ATOMS.includes(a as PermissionAtom));
  if (unknown.length) throw new BadRequestException({ code: 'unknown_atom', unknown });

  // V3 — closure, dedupe, canonical order (so the stored array is comparable).
  const atoms = [...closeAtoms(input.atoms as PermissionAtom[])]
    .sort((a, b) => PERMISSION_ATOMS.indexOf(a) - PERMISSION_ATOMS.indexOf(b));

  // V4 — an empty role is not a role.
  if (atoms.length === 0) throw new BadRequestException({ code: 'empty_role' });

  return atoms;
}
```

**Which atoms may an admin put in a custom role? All nine, including `sharing:manage` and
`field:viewRestricted`.** An org admin already holds every atom on every resource in the org
(§3.2) and can already hand out `manager`, so forbidding those atoms in custom roles forbids
nothing — it only forces the admin to use a clumsier route. The real guard is not on the role, it
is on the **grant**:

**R4 — grant attenuation (no privilege escalation).** A principal may create or update a grant on
resource `R` only if the grant's materialised atom set is a subset of the grantor's own effective
atoms **at `R` exactly**, and the grantor holds `sharing:manage` at `R` or an ancestor (R5).

**R4a — deleting a grant is subject to R5 only, never to R4.** Deletion removes access; it cannot
escalate anyone. This is also the documented escape hatch from a self-narrowing grant: see E12.

```ts
assertMayGrant(map, skel, ref, proposed: AtomSet) {
  const mine = this.atomsAt(map, skel, ref);      // includes ancestor sharing:manage (R5)
  if (!mine.has('sharing:manage')) throw new ForbiddenException({ code: 'sharing_not_permitted' });
  const escalation = [...proposed].filter(a => !mine.has(a));
  if (escalation.length) throw new ForbiddenException({ code: 'escalation', atoms: escalation });
}

assertMayDeleteGrant(map, skel, ref) {
  if (!this.atomsAt(map, skel, ref).has('sharing:manage'))
    throw new ForbiddenException({ code: 'sharing_not_permitted' });
}
```

Consequences worth stating out loud:

- A project `manager` who does **not** hold `field:viewRestricted` cannot grant
  `field:viewRestricted` to anyone. Restricted-field access spreads only from someone who has it.
- A project `manager` **can** grant `sharing:manage` (they have it), so delegation works, but
  only within the subtree where they hold it.
- An `editor` cannot grant anything at all (no `sharing:manage`).
- A manager who narrowed **herself** on one entity cannot widen that grant in place, because her
  atoms *at that entity* are now the narrow set. She deletes it (R4a) and inheritance restores
  her. E12 traces this, and the API's 403 body names the remedy.

**R5 — `sharing:manage` is evaluated over the ancestor chain, and the resolver encodes it.**
Authority to manage grants on resource `R` is
`∃ A ∈ ancestors(R) ∪ {R} : effective(A).has('sharing:manage')`. Without this, a project manager
given a narrowing `viewer` grant on one entity would lose the ability to fix that very grant — a
lockout with no recovery below org-admin.

An earlier draft called this "the only atom with a non-local evaluation" and then never
implemented the non-locality; the guard's `atomsAt(map, ref).has(atom)` could not honour it.
**The fix is in the resolver, not the guard:** step 4b of §7.5 unions `sharing:manage` downward
from whichever level holds it into that principal's area and entity sets. After that,
`atomsAt(map, skel, ref).has('sharing:manage')` *is* R5, the guard needs no special case, and R4
reads the right grantor set for free.

> **Lemma (the downward union never widens visibility).** `sharing:manage` is only ever unioned
> into a set fed by a strictly non-empty ancestor set, and every stored role is non-empty and
> closed (V4 + R1), so the receiving set already contains `schema:view`. A principal with no
> grant anywhere in the chain receives nothing. Asserted by property **P12**.

**R6 — `sharing:manage` never crosses upward or sideways.** `sharing:manage` on an *area* does not
permit editing grants on the project, on a sibling area, or on an entity outside that area. The
subtree is the boundary, and the downward union of R5 respects it by construction.

---

## 5. `ai:use` and `canUseAi` — reconciled

The spec has both: *"Use AI is a separate toggle on each grant"* (§5), `access_grants.can_use_ai`
(§9), **and** `ai:use` as an atom (C5). Leaving both live with unstated precedence is exactly the
kind of thing that produces a 3am incident, so:

**R7 — grant modifier booleans are additive-only; the atom set is the single representation at
resolution time.**

```ts
function materialise(g: LiveGrant): Set<PermissionAtom> {
  const atoms = new Set(g.atoms);              // role.atoms, already closed at write time
  if (g.canUseAi)           atoms.add('ai:use');
  if (g.canViewRestricted)  atoms.add('field:viewRestricted');
  return atoms;                                // closure already holds
}
```

- The booleans can only **add** an atom. They can never remove one. A custom role that contains
  `ai:use` grants AI regardless of the toggle.
- No built-in role contains `ai:use` or `field:viewRestricted` (§3.1), so for the 99% case — a
  built-in role plus the toggles — the toggle *is* the source and the behaviour is exactly what
  the spec describes.
- **UI rule:** when the selected role already contains the atom, the toggle renders checked and
  disabled with the tooltip "always included in <role name>". The UI never shows a toggle that
  appears off while the atom is on.

Why additive-only and not "the boolean is authoritative": a toggle that can silently strip an atom
the admin deliberately put in a custom role is a footgun, and it makes the audit log unreadable
("role says AI, row says no AI, effective is?"). Additive-only means the effective set of a grant
row is always `role ∪ modifiers`, which fits on one line of an audit entry.

**R8 — `canViewRestricted` is a second modifier boolean, symmetric with `canUseAi`.** This is an
*addition* to doc 02 and to the spec's Prisma sketch, which list only `can_use_ai`.
Justification: some users must be able to see restricted fields, and with built-in roles forming
a chain (R2) there is no built-in role that carries `field:viewRestricted`. The alternatives were
(a) force every org to build a custom role to unhide one salary column — bad UX for the spec's
own workflow #2, or (b) put it in `manager` — which would mean "whoever manages sharing sees
salaries", which is wrong. A third modifier would justify replacing both booleans with
`extraAtoms PermissionAtom[]`; two do not (C12). Flagged in §14 Q1.

**R9 — guests can never hold `sharing:manage`.** Enforced twice: grant-write validation rejects a
grant to a guest principal whose materialised set contains it, and the resolver subtracts it from
a guest subject's result as a belt-and-braces pass. Reason: managing sharing requires enumerating
org members and groups, which is precisely what a guest must not do.

---

## 6. Data model (access-control slice)

Doc 02 owns these tables. This section states the **semantics** this document depends on, the
handful of columns doc 02 must add (§6.3), and nothing else. Field names below are doc 02's.

### 6.1 `AccessGrant`

```prisma
model AccessGrant {
  id            String            @id @default(cuid())
  organizationId String           @map("organization_id")   // C6; derived at write time from the project
  projectId     String            @map("project_id")        // C6; = resourceId when type=project
  resourceType  ResourceType      @map("resource_type")     // project | area | entity
  resourceId    String            @map("resource_id")
  principalType PrincipalType     @map("principal_type")    // user | group | email_invite | share_link
  principalId   String            @map("principal_id")      // user.id | group.id | lower(email) | shareLink.id
  roleId        String            @map("role_id")
  canUseAi      Boolean           @default(false) @map("can_use_ai")            // R7
  canViewRestricted Boolean       @default(false) @map("can_view_restricted")   // R8 — NEW, §6.3
  note          String?                                     // "contractor until Q3"
  createdById   String?           @map("created_by_id")
  expiresAt     DateTime?         @map("expires_at") @db.Timestamptz(6)
  // timestamps per C9

  @@unique([resourceType, resourceId, principalType, principalId])   // R10
  @@index([projectId, principalType, principalId])                   // the hot query
  @@index([principalType, principalId])                              // the projects list
  @@index([roleId])
  @@map("access_grants")
}
```

**`organizationId` is present, and derived at write time** from the grant's project — doc 02 owns
the column and this document adopts it. It is a C6 denormalisation on the resolver's hottest
query, and it is what makes doc 02's offboarding liveness rule (its Key decision 20: a `user`
grant counts only while that user is an `OrgMember` of the **grant's** `organizationId`) a lookup
rather than a join through project → workspace → org. The grant write path (§7.14) copies it from
the project inside the same transaction, so the two can never disagree.

**`note` is doc 02's column and this document carries it** — free text shown in the "Who has
access" dialog ("contractor until Q3"). Nothing in the resolver reads it; the audit row remains
the record of who granted what and when.

**R10 — one grant per (resource, principal).** There is no way to hold two grants on the same
resource as the same principal, which removes an entire family of "which of my two grants wins"
questions. The cost is that you cannot express "viewer forever plus editor until Friday"; you
express the latter and let it expire back to nothing. Accepted.

Doc 02's raw-SQL migration already carries the guard rails this document depends on, and this
document cites rather than re-states them: `access_grants_project_self_ck` (a project-scoped
grant must point at its own project), `access_grants_email_shape_ck`, `access_grants_id_shape_ck`,
and `access_grants_one_per_share_link_uq`.

### 6.2 `ShareLink` and `AccessRequest`

**`ShareLink` carries no resource pointer.** Doc 02's model is correct and this document adopts
it unchanged: the link is a *principal*, and its target is the `resourceType` / `resourceId` of
the `AccessGrant` whose `principalId` is the link's id. An earlier draft duplicated
`organizationId` / `resourceType` / `resourceId` onto `ShareLink` with no constraint that the two
copies agree — two rows, two delete paths, and a visitor who unlocks successfully into a 404. See
§7.12 for the single-source rule that follows from this.

**`AccessRequest` uses doc 02's field names** — `requestedById`, `requestedRoleKey`,
`decisionNote`, and `AccessRequestStatus = pending | approved | denied | withdrawn` — and
**carries no `@@unique` on `status`.** A four-column unique including `status` permits exactly one
denied row per (resource, requester) for all time, so the second denial is a 500 on the Deny
button, forever, and it contradicts §7.13's own "a denied request does not block a later one".
Prisma cannot express a partial unique index at all. Doc 02 already ships the right thing in its
hand-written migration, and this document cites it:

```sql
-- doc 02, migration 2.6. One OPEN request per (resource, requester); re-requesting
-- after a denial is allowed. Lives in raw SQL because Prisma cannot declare it.
CREATE UNIQUE INDEX access_requests_pending_uq
  ON access_requests (resource_type, resource_id, requested_by_id)
  WHERE status = 'pending';
```

### 6.3 Columns this document requires from doc 02

**New — doc 02 must add these five:**

```prisma
// on Project — read on every resolve, security-relevant (see the note below)
restrictedFieldMode RestrictedFieldMode @default(mask) @map("restricted_field_mode")
permGeneration      Int                 @default(0)    @map("perm_generation")
// on Organization
permGeneration      Int                 @default(0)    @map("perm_generation")
// on User
permGeneration      Int                 @default(0)    @map("perm_generation")
// on AccessGrant  (R8)
canViewRestricted   Boolean             @default(false) @map("can_view_restricted")
```

**New — required by L25 (Phase 2), so they can land with the AI phase:**

```prisma
// on SavedQuery
touchedEntityIds String[] @default([]) @map("touched_entity_ids")   // also kept as the
touchedFieldIds  String[] @default([]) @map("touched_field_ids")    // SavedQueryEntity join
// on AiMessage
touchedEntityIds String[] @default([]) @map("touched_entity_ids")
touchedFieldIds  String[] @default([]) @map("touched_field_ids")
```

Doc 02's `SavedQueryEntity` join table stays: it is the indexed "which queries touch this entity"
path used when an entity is deleted. The arrays are what the read-time filter checks, because
that check is an in-memory set test over a page of rows, not a query.

**Already in doc 02 / the spec sketch — confirming only, not a request:**
`Field.isRestricted`, `Entity.areaId`, `AccessGrant.expiresAt`, `ShareLink.revokedAt`,
`ShareLink.expiresAt`, `Role.atoms`, `Role.isBuiltIn`, `Role.isArchived`.

**`Role.isArchived` exists in doc 02, and R12 deliberately does not read it.** Archiving retires a
role from every picker; grants that already use it keep working unchanged. Making a checkbox
silently revoke access for everyone holding the role is a mass permission change with no
per-subject audit trail, and it would put a third join predicate on the resolver's hot query. To
remove access, remove the grants.

**Not required:** any user-deactivation column. An earlier draft's R12 depended on one; it does
not exist in doc 02 and it is not a spec feature. Removal from the org is the deactivation
mechanism and R12.2 already covers it.

**Why `restrictedFieldMode` is a column and not a key in `projects.settings`.** Doc 02 puts it in
the settings JSONB (`projectSettingsSchema`). It is read on every single permission resolve and it
is security-relevant; C4's JSONB rule is about *engine*-specific props, and C2 explicitly permits
a Prisma enum for a closed set the database should enforce. This is conflict (c) in §14 Q12.

**Default is `mask`, not `hide`.** `hide` looks safer but has a residual leak that `mask` does not
(L21: a create that collides with a hidden field name must fail, which is an existence oracle),
and it makes the schema the user sees a lie they can act on. `mask` discloses the slot honestly —
and, per §8.3, discloses nothing about what fills it.

### 6.4 `email_invite` grants never reach the resolver (R11, Phase 3)

An `email_invite` grant is a *pending* grant. It grants nothing, because there is no session to
attach it to. Doc 02's `Invitation` model owns the invite itself and points at the pending grant
via `accessGrantId`. When a user accepts an invitation with a **verified** email, one transaction
converts it. The resolver therefore only ever reads `user | group | share_link` principals, which
keeps the hot query short and removes any temptation to match grants on an unverified string.

**R11 — invitation acceptance, fully specified.** Three things an earlier draft left as a
placeholder are settled here: the org membership, the collapse rule, and the fact that an upsert
cannot read the row it is updating.

```ts
async function acceptInvitation(inv: Invitation, user: User) {
  await prisma.$transaction(async (tx) => {
    // 1. Org membership FIRST. Without it R12.2 kills the grant and the invitee lands on a 404
    //    on the happy path — the spec's workflow #4, broken.
    await tx.orgMember.upsert({
      where:  { organizationId_userId: { organizationId: inv.organizationId, userId: user.id } },
      update: {},                                   // never downgrade an existing member
      create: { organizationId: inv.organizationId, userId: user.id, role: inv.orgRole },
    });

    // 2. Convert the pending grant, if the invitation carried one.
    if (inv.accessGrantId) {
      const pending = await tx.accessGrant.findUnique({ where: { id: inv.accessGrantId } });
      if (pending) {
        const existing = await tx.accessGrant.findUnique({
          where: { resourceType_resourceId_principalType_principalId: {
            resourceType: pending.resourceType, resourceId: pending.resourceId,
            principalType: 'user', principalId: user.id } },
        });

        if (!existing) {
          await tx.accessGrant.update({
            where: { id: pending.id },
            data:  { principalType: 'user', principalId: user.id },
          });
        } else {
          const merged = collapseGrants(existing, pending);     // R11a, below
          await tx.accessGrant.update({ where: { id: existing.id }, data: merged.data });
          await tx.accessGrant.delete({ where: { id: pending.id } });
          if (merged.needsReview)
            await tx.auditLog.create({ data: audit('grant.invite_merge_review', pending, user) });
        }
        await tx.auditLog.create({ data: audit('grant.invite_converted', pending, user) });
      }
    }

    await tx.invitation.update({
      where: { id: inv.id },
      data:  { acceptedAt: new Date(), acceptedByUserId: user.id },
    });
    await tx.user.update({ where: { id: user.id }, data: { permGeneration: { increment: 1 } } });
  });
  await invalidate({ user: user.id, project: inv.projectId ?? undefined });
}
```

**R11a — the collapse rule, stated once with both branches.**

> Let `E` be the existing grant and `P` the pending one. Modifiers are always unioned:
> `canUseAi = E.canUseAi || P.canUseAi`, same for `canViewRestricted`, and
> `expiresAt = null` if either is null, otherwise the later of the two.
> For the **role**:
> 1. **Both roles are built-in** → keep the higher one in the `BUILT_IN_ROLE_ORDER` chain (R2).
>    Because the chain is total, that union is itself a built-in role. `needsReview = false`.
> 2. **Either role is custom** → **keep `E`'s role unchanged**, set `needsReview = true`, and
>    write an audit row naming `P`'s role so a manager can reconcile.
>
> Branch 2 is deliberately fail-closed. R2 orders only the five built-ins, so "the higher role"
> is undefined for two custom roles, and the two tempting alternatives are both worse: unioning
> the atom sets silently mints a privilege combination nobody approved, and minting a new
> org-scoped role on an invite acceptance creates role rows nobody asked for. Worked example:
> the invite carries custom `analyst-ro` (`schema:view`, `export:run`, `ai:use`) and the existing
> grant carries custom `docs-only` (`schema:view`, `docs:edit`). The user keeps `docs-only`,
> gains nothing, and the org's manager sees one review row saying the invite's `analyst-ro` was
> not applied. Nobody is silently escalated, and a human resolves it in one click.

---

## 7. The resolution algorithm

### 7.0 The module and the resolver surface

SPEC §5 names an `AccessModule` containing a `PermissionResolver`. Here they are.

```ts
// apps/api/src/access/access.module.ts
@Module({
  imports:   [PrismaModule, RedisModule],
  providers: [PermissionResolver, VisibilityFilter, SchemaLoader, PermissionGuard],
  exports:   [PermissionResolver, VisibilityFilter, SchemaLoader],
})
export class AccessModule {}
```

```ts
// apps/api/src/access/permission-resolver.service.ts
export type OrgRole = 'owner' | 'admin' | 'member' | 'guest';
export type RestrictedFieldMode = 'mask' | 'hide';

/** 'user:<id>' | 'group:<id>' | 'share_link:<id>' — the key used in every per-principal map. */
export type PrincipalKey = `${'user' | 'group' | 'share_link'}:${string}`;

/** One row of the hot query (§7.5), already joined to its role. */
export interface LiveGrant {
  id: string;
  resourceType: 'project' | 'area' | 'entity';
  resourceId: string;
  principalKey: PrincipalKey;
  atoms: PermissionAtom[];            // roles.atoms
  canUseAi: boolean;
  canViewRestricted: boolean;
  expiresAt: Date | null;
  linkExpiresAt: Date | null;         // share_links.expires_at, null for other principals
}

@Injectable()
export class PermissionResolver {
  /** The subject's whole view of one project. Cached (§9). */
  resolveProject(subject: Subject, projectId: string): Promise<ProjectPermissionMap>;

  /** The inverse: who can do what at one resource. Used by §7.7, §7.11 and §7.13. */
  resolveResource(projectId: string, ref: ResourceRef): Promise<Map<PrincipalKey, AtomSet>>;

  /** Subject-independent, cached. Exposed because VisibilityFilter and the guard need it. */
  skeleton(projectId: string): Promise<ProjectSkeleton>;

  /** Effective atoms at one resource. Pure; no I/O. */
  atomsAt(map: ProjectPermissionMap, skel: ProjectSkeleton, ref: ResourceRef): AtomSet;

  /** Bulk check, all-or-nothing (§10.4). Throws 403, or 404 if any ref is invisible. */
  assertAll(map: ProjectPermissionMap, skel: ProjectSkeleton,
            refs: readonly ResourceRef[], atom: PermissionAtom): void;

  /** R4 / R4a. */
  assertMayGrant(map: ProjectPermissionMap, skel: ProjectSkeleton,
                 ref: ResourceRef, proposed: AtomSet): void;
  assertMayDeleteGrant(map: ProjectPermissionMap, skel: ProjectSkeleton, ref: ResourceRef): void;

  /** Post-commit cache invalidation (§9.3). */
  invalidate(scope: { project?: string; org?: string; user?: string }): Promise<void>;
}
```

`VisibilityFilter` (§8.1) is the other export. Nothing else in the codebase reads
`access_grants`; a repository method that does, outside this module, is a review failure.

### 7.1 Subjects

```ts
export type Subject =
  | { kind: 'user';       userId: string; orgId: string }
  | { kind: 'share_link'; shareLinkId: string; projectId: string };

export function subjectKey(s: Subject): string {
  return s.kind === 'user' ? `u:${s.userId}` : `sl:${s.shareLinkId}`;
}
```

There is no `guest` subject kind (guest is an org role) and no `group` subject kind (group
membership is a set expanded inside the resolver). An unauthenticated request with no share-link
session has no subject and is rejected by the auth guard before the permission guard runs.

### 7.2 Resources and ancestry

```ts
export type ResourceRef =
  | { type: 'project'; id: string }
  | { type: 'area';    id: string }
  | { type: 'entity';  id: string };
```

Ancestry, most specific first:

```
entity E   →  [entity E, area E.areaId (if any), project P]
area A     →  [area A, project P]
project P  →  [project P]
```

- **Organization** is not in the chain. The org role is applied before grants (R13) and is not a
  grantable resource.
- _Amended 2026-10-04 (roadmap 19, `docs/phase19/DESIGN.md`): a workspace IS now grantable, through `workspace_grants`, as the level above the project in R15 (nearest level wins, per principal). The text below is the Phase 1 position._
- **Workspace** is not in the chain and not grantable (fixed by C5). A workspace is an
  organisational container for listing; "share the whole workspace" is expressed as N project
  grants. Flagged in §14 Q2.
- **Namespace** (PostgreSQL schema) is not grantable. Areas are the user-facing grouping.
- **Field** is not a resource. Field visibility is a function of the field's entity plus
  `isRestricted` (§7.10).

### 7.3 Liveness

**R12.** A grant is **live** at time `now` iff all of:

1. `expiresAt IS NULL OR expiresAt > now` — evaluated in SQL at query time, never by a cron. A
   cron that runs late means an expired grant still works.
2. its principal is live:
   - `user` — the user exists and is an `OrgMember` of the **grant's** `organizationId` (§6.1;
     doc 02 Key decision 20 — which is a lookup, not a join through project → workspace → org).
     Removing
     someone from the org neutralises every grant they hold there without deleting rows, and it
     is the product's only deactivation mechanism.
   - `group` — the group exists and the subject is a current member of it.
   - `share_link` — `ShareLink.revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > now)`.
3. its project is not soft-deleted (`Project.deletedAt IS NULL`) and its org is not soft-deleted.

There is no role-archival condition; see §4.1.

Grants are **hard-deleted** when revoked (they are not schema objects; C8's tombstone rule does
not apply), with a before-image in the audit log.

### 7.4 The precedence rules

These are the rules the spec's one sentence — *"grants inherit downward; more specific grants
override broader ones"* — does not fully determine. Each is followed by a worked example in §7.6.

> **Amended 2026-09-29 (product decision): R13 applies to org OWNERS only.** An org admin
> still manages members, groups, workspaces and custom roles, but sees only the projects,
> areas and entities they are granted, like a member. Access-request fallbacks notify owners.
> The original text below is kept for history; read "owner/admin" as "owner".
>
> **R13 — Org owner/admin short-circuit, and it cannot be escaped.**
> If the subject is a user whose `OrgMember.role` is `owner` or `admin`, every resource in that
> org resolves to all nine atoms, and grants are not read at all. A narrowing grant on an admin
> is inert; the "Who has access" dialog renders it struck through with "no effect — org admin".
> Rationale: an admin can edit or delete that grant in one click, so "demoting" them is theatre
> that would only mislead a compliance reader. Orgs that genuinely need "admins cannot see
> salaries" need a different product feature (§14 Q3). Admin reads of restricted fields are
> audit-logged (§10.5).

> **R14 — No deny grants. Ever.**
> There is no `deny` flag, no negative role, no exclusion list. Access is default-deny, and a
> grant can only add. Reasons: (a) the rule set stays monotone in the number of principals, which
> is what makes R16 safe; (b) "deny wins" plus inheritance plus groups is the classic ACL
> pathology that nobody can reason about; (c) caching a non-monotone function invites
> order-dependent bugs; (d) every use case the spec names is expressible without it. The
> workaround for "editor on everything except this table" is to grant at the area/entity level
> instead of the project level, or to place a narrowing grant (R15) on **every** principal path
> (R16) — and the UI warns when a narrowing grant is defeated (§7.7).

> **R15 — Per-principal nearest-level-wins (NLW).**
> For a single principal `p`, walk `ancestors(R)` most-specific first and stop at the first level
> where `p` has any live grant. That level's grant (there is at most one by R10) determines
> `p`'s contribution **entirely**; broader levels are discarded, not unioned. So a more specific
> grant *replaces* — it can weaken or strengthen.

> **R16 — Union across principals.**
> `effective(R) = ⋃ over all of the subject's principals p of atoms_p(R)`. Grants from the user
> themselves, from group A, and from group B are unioned at whatever level each of them decided.
> The deciding level is computed **per principal**, not once for the subject.

R15 + R16 together are the crux. The alternative — computing one deciding level for the whole
subject — was rejected because it lets a single entity-level grant to some group silently demote
an unrelated project-level editor. With per-principal NLW, the invariant is the one people
actually expect: **adding a principal or a grant never takes access away from anyone; taking
access away requires narrowing (or removing) every path that granted it.**

> **R17 — Subject-class ceilings are intersected last.**
> After R15/R16:
> - `share_link` subjects are intersected with `{ 'schema:view' }` (spec: view-only). They can
>   never hold `export:run`, `ai:use`, `comment:create`, `field:viewRestricted`,
>   `sharing:manage`, `history:view`, or `schema:edit`, whatever role is attached to the link.
> - `guest` users have `sharing:manage` subtracted (R9).
> This is the only place in the algorithm where a cap exists, and it is a fixed, code-level cap,
> not data.

> **R18 — Determinism.**
> The result is order-independent (unions and set intersections only), has no dependence on which
> grant was created first, and is a pure function of
> `(org role, group memberships, live grants, project skeleton, restrictedFieldMode, now)`.

### 7.5 Pseudocode

```ts
export interface ProjectPermissionMap {
  readonly projectId: string;
  readonly subjectKey: string;
  readonly orgRole: OrgRole | null;                        // null for share_link
  readonly projectAtoms: AtomSet;
  readonly areaAtoms: ReadonlyMap<string, AtomSet>;        // areaId -> atoms
  /** ONLY entities whose atoms differ from what they inherit. Usually empty. */
  readonly entityOverrides: ReadonlyMap<string, AtomSet>;
  readonly restrictedFieldMode: RestrictedFieldMode;
  /** Wall-clock ms. min(now + PERM_TTL_MS, next grant OR share-link expiry). */
  readonly validUntil: number;
}
```

Everything else is **derived**, not stored — one shape, nothing to keep in sync, and about 2 KB
of Redis instead of 50 KB for a 300-entity project where all 300 entries were the same nine
strings:

```ts
export function inheritedAtoms(map: ProjectPermissionMap, e: SkeletonEntity): AtomSet {
  return e.areaId ? (map.areaAtoms.get(e.areaId) ?? EMPTY) : map.projectAtoms;
}

export function atomsAt(map: ProjectPermissionMap, skel: ProjectSkeleton, ref: ResourceRef): AtomSet {
  if (ref.type === 'project') return ref.id === map.projectId ? map.projectAtoms : EMPTY;
  if (ref.type === 'area')    return map.areaAtoms.get(ref.id) ?? EMPTY;
  const e = skel.entityById.get(ref.id);
  if (!e) return EMPTY;                                          // unknown id -> 404 upstream
  return map.entityOverrides.get(ref.id) ?? inheritedAtoms(map, e);
}

export function visibleEntityIds(map, skel): Set<string> {
  return new Set(skel.entities.filter(e =>
    (map.entityOverrides.get(e.id) ?? inheritedAtoms(map, e)).has('schema:view')).map(e => e.id));
}
export function restrictedOkEntityIds(map, skel): Set<string> { /* same, 'field:viewRestricted' */ }

/** §7.9. Derivable from the map alone — no skeleton needed, so GET /projects is cheap. */
export function canOpenProject(map: ProjectPermissionMap): boolean {
  return map.projectAtoms.size > 0
      || [...map.areaAtoms.values()].some(s => s.size > 0)
      || [...map.entityOverrides.values()].some(s => s.size > 0);
}
```

Every set helper the pseudocode uses, declared once so nothing below is a mystery:

```ts
const EMPTY: AtomSet = new Set();
const ALL_ATOMS: AtomSet = new Set(PERMISSION_ATOMS);
const SHARE_LINK_CEILING: AtomSet = new Set(['schema:view']);

const withAtom   = (s: AtomSet, a: PermissionAtom): AtomSet => s.has(a) ? s : new Set([...s, a]);
const without    = (s: AtomSet, a: PermissionAtom): AtomSet => s.has(a) ? new Set([...s].filter(x => x !== a)) : s;
const intersect  = (s: AtomSet, t: AtomSet): AtomSet => new Set([...s].filter(a => t.has(a)));
const unionAll   = (sets: readonly AtomSet[]): AtomSet => new Set(sets.flatMap(s => [...s]));
const sameSet    = (s: AtomSet, t: AtomSet) => s.size === t.size && [...s].every(a => t.has(a));

/** For each key, union that key's set across every per-principal map. Missing = empty. */
function unionByKey(maps: readonly ReadonlyMap<string, AtomSet>[], keys: readonly string[]) {
  return new Map(keys.map(k => [k, unionAll(maps.map(m => m.get(k) ?? EMPTY))] as const));
}
const intersectAllInPlace = (m: Map<string, AtomSet>, c: AtomSet) =>
  { for (const [k, v] of m) m.set(k, intersect(v, c)); };
const withoutAllInPlace = (m: Map<string, AtomSet>, a: PermissionAtom) =>
  { for (const [k, v] of m) m.set(k, without(v, a)); };
```

The resolve itself:

```ts
function ALL_ACCESS_MAP(project: Project, skel: ProjectSkeleton,
                        subject: Subject, orgRole: OrgRole): ProjectPermissionMap {
  return {
    projectId: project.id, subjectKey: subjectKey(subject), orgRole,
    projectAtoms: ALL_ATOMS,
    areaAtoms: new Map(skel.areaIds.map(a => [a, ALL_ATOMS])),
    entityOverrides: new Map(),                      // nothing differs from the inherited value
    restrictedFieldMode: project.restrictedFieldMode,
    validUntil: Date.now() + PERM_TTL_MS,
  };
}

/** Never cached: a nonexistent or unreachable project has no row to key it by. */
function EMPTY_MAP(projectId: string, subject: Subject): ProjectPermissionMap {
  return {
    projectId, subjectKey: subjectKey(subject), orgRole: null,
    projectAtoms: EMPTY, areaAtoms: new Map(), entityOverrides: new Map(),
    restrictedFieldMode: 'mask',                     // default; nothing is visible anyway
    validUntil: 0,
  };
}

async function resolveProject(subject: Subject, projectId: string): Promise<ProjectPermissionMap> {
  // ---- step 0: project must exist and be alive -------------------------------------------
  const project = await loadProject(projectId);                 // deletedAt = null, org alive
  if (!project) return EMPTY_MAP(projectId, subject);

  // ---- step 1: the skeleton, BEFORE any short-circuit ------------------------------------
  // Subject-independent and cached, so this costs nothing — and ALL_ACCESS_MAP needs its
  // area ids. Resolving it after the org-role branch was a real bug: org owners got an
  // empty visible set and VisibilityFilter redacted the whole schema away from them.
  const skel = await resolver.skeleton(projectId);

  // ---- step 2: org role short-circuit (R13) ----------------------------------------------
  let orgRole: OrgRole | null = null;
  let principals: PrincipalKey[];

  if (subject.kind === 'user') {
    const member = await orgMembership(subject.userId, project.organizationId);   // cached
    if (!member) return EMPTY_MAP(projectId, subject);                            // R12.2
    orgRole = member.role;
    if (orgRole === 'owner' || orgRole === 'admin')
      return ALL_ACCESS_MAP(project, skel, subject, orgRole);
    principals = [`user:${subject.userId}`, ...member.groupIds.map(g => `group:${g}` as const)];
  } else {
    if (subject.projectId !== projectId) return EMPTY_MAP(projectId, subject);    // §7.12
    principals = [`share_link:${subject.shareLinkId}`];
  }

  // ---- step 3: one data read, then index by principal and level ---------------------------
  const grants = await liveGrants(projectId, principals, now());   // §7.3, one SQL statement
  const byPrincipal = indexGrants(grants, projectId, skel);        // §7.15 drops bad rows here

  // ---- step 4: per-principal cascade (R15) ------------------------------------------------
  const perPrincipal: Array<{ project: AtomSet; area: Map<string, AtomSet>;
                              entity: Map<string, AtomSet> }> = [];

  for (const p of principals) {
    const g = byPrincipal.get(p);
    if (!g) continue;                                      // principal contributes nothing

    const pProject = g.project ? materialise(g.project) : EMPTY;

    const pArea = new Map<string, AtomSet>();
    for (const areaId of skel.areaIds) {
      const ga = g.area.get(areaId);
      pArea.set(areaId, ga ? materialise(ga) : pProject);   // inherit downward
    }

    const pEntity = new Map<string, AtomSet>();
    for (const e of skel.entities) {
      const ge = g.entity.get(e.id);
      pEntity.set(e.id,
        ge         ? materialise(ge)                        // nearest level = entity
      : e.areaId   ? pArea.get(e.areaId)!                   // nearest level = area (or inherited)
                   : pProject);                             // entity in no area (§7.11)
    }

    // ---- step 4b: R5 — union sharing:manage DOWNWARD from wherever it is held -------------
    // This is what makes `atomsAt(...).has('sharing:manage')` mean the ancestor-OR of R5,
    // so the guard and R4 need no special case. See the Lemma in §4.2: it can never
    // introduce schema:view where the chain had none.
    if (pProject.has('sharing:manage')) {
      for (const [k, v] of pArea)   pArea.set(k, withAtom(v, 'sharing:manage'));
      for (const [k, v] of pEntity) pEntity.set(k, withAtom(v, 'sharing:manage'));
    } else {
      for (const e of skel.entities) {
        if (e.areaId && pArea.get(e.areaId)!.has('sharing:manage'))
          pEntity.set(e.id, withAtom(pEntity.get(e.id)!, 'sharing:manage'));
      }
    }

    perPrincipal.push({ project: pProject, area: pArea, entity: pEntity });
  }

  // ---- step 5: union across principals (R16) ---------------------------------------------
  let projectAtoms = unionAll(perPrincipal.map(x => x.project));
  const areaAtoms  = unionByKey(perPrincipal.map(x => x.area),   skel.areaIds);
  const entityAll  = unionByKey(perPrincipal.map(x => x.entity), skel.entities.map(e => e.id));

  // ---- step 6: ceilings (R17) ------------------------------------------------------------
  if (subject.kind === 'share_link') {
    projectAtoms = intersect(projectAtoms, SHARE_LINK_CEILING);
    intersectAllInPlace(areaAtoms,  SHARE_LINK_CEILING);
    intersectAllInPlace(entityAll,  SHARE_LINK_CEILING);
  } else if (orgRole === 'guest') {
    projectAtoms = without(projectAtoms, 'sharing:manage');
    withoutAllInPlace(areaAtoms, 'sharing:manage');
    withoutAllInPlace(entityAll, 'sharing:manage');
  }

  // ---- step 7: keep only the entities that differ from what they inherit -------------------
  const entityOverrides = new Map<string, AtomSet>();
  for (const e of skel.entities) {
    const mine = entityAll.get(e.id)!;
    const inherited = e.areaId ? (areaAtoms.get(e.areaId) ?? EMPTY) : projectAtoms;
    if (!sameSet(mine, inherited)) entityOverrides.set(e.id, mine);
  }

  return {
    projectId, subjectKey: subjectKey(subject), orgRole,
    projectAtoms, areaAtoms, entityOverrides,
    restrictedFieldMode: project.restrictedFieldMode,
    validUntil: Math.min(Date.now() + PERM_TTL_MS, nextExpiryOf(grants) ?? Infinity),
  };
}

/** R12.1 + share-link expiry — BOTH of them. A link expiring in 30 s must not leave a 300 s map. */
function nextExpiryOf(grants: readonly LiveGrant[]): number | null {
  const ts = grants.flatMap(g =>
    [g.expiresAt, g.linkExpiresAt].filter(Boolean).map(d => d!.getTime()));
  return ts.length ? Math.min(...ts) : null;
}
```

The hot query — one statement, one index scan per principal:

```sql
SELECT g.id, g.resource_type, g.resource_id, g.principal_type, g.principal_id,
       g.role_id, g.can_use_ai, g.can_view_restricted, g.expires_at,
       r.atoms,
       sl.expires_at AS link_expires_at        -- R12.2 liveness + nextExpiryOf: without this
                                               -- can outlive the link that produced it
FROM access_grants g
JOIN roles r ON r.id = g.role_id
LEFT JOIN share_links sl
       ON g.principal_type = 'share_link' AND sl.id = g.principal_id
WHERE g.project_id = $1
  AND (g.principal_type, g.principal_id) IN (  -- ('user',$u),('group',$g1),…  or ('share_link',$s)
        SELECT * FROM unnest($2::text[], $3::text[])
      )
  AND (g.expires_at IS NULL OR g.expires_at > now())
  AND (g.principal_type <> 'share_link'
       OR (sl.revoked_at IS NULL AND (sl.expires_at IS NULL OR sl.expires_at > now())));
```

`skeleton(projectId)` is subject-independent and shared across every user of the project:

```ts
export interface SkeletonEntity { id: string; areaId: string | null }

export interface ProjectSkeleton {
  generation: number;                              // Project.permGeneration when built
  areaIds: string[];
  entities: SkeletonEntity[];
  entityById: ReadonlyMap<string, SkeletonEntity>;
  /** R21′ and §8.3 ask "which entities have a restricted field", never "which field ids". */
  entitiesWithRestrictedFields: ReadonlySet<string>;
}
```

```sql
SELECT id, area_id FROM entities WHERE project_id = $1;
SELECT id          FROM areas    WHERE project_id = $1;
SELECT DISTINCT entity_id FROM fields WHERE project_id = $1 AND is_restricted = true;
```

An earlier draft also carried `fieldsByEntity: Map<entityId, {id, ordinal, isRestricted}[]>`.
**Deleted.** Nothing read it: redaction operates on the loaded raw model, which already contains
every field, and dense renumbering (L22) works from that same model. On a 300-entity project it
was roughly 4,500 entries against the skeleton's 300 — about 90 % of the cached payload and 90 %
of the rebuild cost, for a consumer that does not exist.

For a 300-entity project the skeleton is ~12 KB of JSON and three narrow index scans. The
per-principal cascade is `O(principals × entities)` with 1–4 principals in practice — a few
thousand `Set` reads, sub-millisecond.

### 7.6 Worked examples — every ambiguity, resolved

Fixture used throughout (also the §12 trace fixture and the §11 golden-matrix fixture):

```
org_acme
└── prj_shop  (postgresql 16, restrictedFieldMode = mask, namespace ns_public "public")
    ├── area ar_bill  "Billing"  (indigo)
    │   ├── ent_inv   invoices      [ fld_inv_id id uuid, fld_inv_emp employee_id uuid ]
    │   ├── ent_pay   payments      [ fld_pay_id id uuid, fld_pay_inv invoice_id uuid ]
    │   └── ent_emp   employees     [ fld_emp_id id uuid, fld_emp_name name text,
    │                                 fld_sal salary numeric(10,2) isRestricted = true ]
    ├── area ar_cat   "Catalog"  (amber)
    │   └── ent_prod  products      [ fld_prod_id id uuid, fld_prod_owner owner_id uuid ]
    └── (no area)     ent_aud       audit_events [ fld_aud_id id uuid ]

links   lnk_pay_inv  payments.invoice_id  -> invoices.id
        lnk_inv_emp  invoices.employee_id -> employees.id
        lnk_prod_emp products.owner_id    -> employees.id
indexes idx_emp_comp  ON employees, one expression column "(salary * 12)"
constr. cst_emp_pk    primaryKey on employees [fld_emp_id]
        cst_sal_pos   check      on employees [fld_sal], engineProps.expression "salary > 0"
docs    ent_inv ✓, ent_emp ✓, fld_inv_emp ✓, fld_emp_name ✓, fld_sal ✓; everything else absent
```

| # | Setup | Question | Result | Rule |
|---|---|---|---|---|
| **E1** | user:ana grant `project=editor`; user:ana grant `entity ent_emp=viewer` | atoms on `ent_emp` | `viewer` set — she can read it but not edit it | R15: nearest level for principal `user:ana` is entity; the project grant is **discarded**, not unioned |
| **E2** | user:dana grant `project=viewer`; user:dana grant `area ar_bill=editor` | atoms on `ent_inv` (Billing) / on `ent_prod` (Catalog) | `editor` / `viewer` | R15 both ways — specificity strengthens as readily as it weakens |
| **E3** | user:ana grant `entity ent_emp=viewer`; group:analysts grant `entity ent_emp=editor`; ana ∈ analysts | atoms on `ent_emp` | `editor` | R16 — union across principals at their own deciding levels. **The narrowing user grant does not win.** |
| **E4** | group:a grant `project=editor`; group:b grant `project=commenter`; ana ∈ both | atoms on anything | `editor` | R16 — union; because built-ins are a chain (R2) the union is simply the higher role |
| **E5** | user:ana grant `project=manager`; group:analysts grant `entity ent_emp=viewer`; ana ∈ analysts | atoms on `ent_emp` | **`manager`** | R15 is **per principal**. `user:ana`'s nearest level is project → manager. `group:analysts`'s nearest level is entity → viewer. Union = manager. A group's narrow grant cannot demote a broader personal grant. |
| **E5b** | same but the entity `viewer` grant is on `user:ana` herself | atoms on `ent_emp` | `viewer` **plus `sharing:manage`** | R15 replaces (same principal), then R5/step 4b unions `sharing:manage` down from the project level. This is exactly what makes E12 work. |
| **E6** | user:ana grant `project=editor`, `expiresAt = yesterday` | anything | nothing (`canOpenProject = false`) | R12.1 — expiry evaluated in SQL at resolve time |
| **E7** | user:ana grant `project=manager`; ana removed from `org_acme` | anything | `EMPTY_MAP` | R12.2 — principal liveness; removal from the org is the deactivation mechanism |
| **E8** | user:bob is org `owner` (was `admin` before the 2026-09-29 amendment; an admin now gets exactly the grant, viewer); grant `entity ent_emp=viewer` on bob | atoms on `ent_emp` | **all nine atoms** | R13 — short-circuit before grants are read; the grant is inert and the UI says so |
| **E9** | user:dana is org `guest`; grant `area ar_bill=manager` | atoms in Billing | manager **minus** `sharing:manage` | R9/R17 — and the grant write would have been rejected in the first place |
| **E10** | an `AccessGrant` whose principal is a share link somehow carries `manager, canUseAi = true` (a bad migration, or a future feature) | atoms anywhere | `{ schema:view }` | R17 — the ceiling is applied last and is not data-driven. §7.12 additionally guarantees link creation only ever writes the built-in `viewer`, so the ceiling is defence in depth, not the primary control. |
| **E11** | user:ana grant `area ar_bill=editor`; `ent_aud` is in no area | atoms on `ent_aud` | nothing | §7.11 — an entity in no area inherits directly from the project, which has no grant |
| **E12** | user:ana grant `project=manager`; user:ana grant `entity ent_emp=viewer`. (a) she **deletes** the entity grant. (b) she tries to **update** it to `editor`. | permitted? | **(a) yes. (b) no — `403 escalation`, body `{ code: 'escalation', atoms: ['schema:edit','history:view'], remedy: 'delete_narrowing_grant' }`** | (a) R4a + R5: her atoms at `ent_emp` carry `sharing:manage` by the step-4b downward union, and deletion is not attenuated. Afterwards inheritance restores her to manager. (b) R4: attenuation is measured at `ent_emp` exactly, where she is a viewer. **The escape hatch is delete-then-regrant, and the 403 names it.** |
| **E13** | user:ana grant `area ar_bill=manager`; she tries to grant `project=viewer` to bob | permitted? | **no**, `403 sharing_not_permitted` | R6 — area `sharing:manage` does not reach upward; step 4b only ever unions downward |
| **E14** | user:ana grant `project=editor` (so no `field:viewRestricted`); she tries to grant `canViewRestricted = true` to bob on `ent_emp` | permitted? | **no** — and she could not grant anything anyway (no `sharing:manage`). With `manager` but no `canViewRestricted` she still cannot. | R4 — attenuation |
| **E15** | two grants for `user:ana` on `project` | possible? | **no**, unique index | R10 |

### 7.7 The footgun, the inverse resolver, and the three features that need it

E3 and E5 mean: **a narrowing grant only narrows the principal it is attached to.** Someone who
sets `entity ent_emp = viewer` on a user who is also an editor via a group will not achieve what
they intended. This is the price of R14 (no denies) and R16 (union), and it is the right price —
the alternative is a rule set nobody can predict. It is mitigated in the product.

All three mitigations, plus guest mention autocomplete and access-request routing, need the
**inverse** of `resolveProject`: not "what can this subject do here" but "who can do what here".
An earlier draft hand-waved it as "re-run `resolveProject` for that principal", which answers the
one-principal question and not the set question, and would have cost 40+ full resolves per
`dryRun` keystroke on a project with 40 grants. It is a named algorithm:

```ts
/**
 * R23 — the inverse resolver. Two queries, no per-principal resolve.
 * Returns effective atoms per principal AT ref, already ceiling-adjusted.
 * Org owners and admins are unioned in with ALL_ATOMS (R13).
 */
async function resolveResource(projectId: string, ref: ResourceRef): Promise<Map<PrincipalKey, AtomSet>> {
  const chain = ancestorsOf(ref);                     // [entity, area?, project] — 1..3 ids
  // Query 1: every live grant anywhere on that chain, for every principal.
  const grants = await db.query(`
    SELECT g.principal_type, g.principal_id, g.resource_type, g.resource_id,
           g.can_use_ai, g.can_view_restricted, r.atoms
    FROM access_grants g JOIN roles r ON r.id = g.role_id
    LEFT JOIN share_links sl ON g.principal_type = 'share_link' AND sl.id = g.principal_id
    WHERE g.project_id = $1 AND g.resource_id = ANY($2)
      AND (g.expires_at IS NULL OR g.expires_at > now())
      AND (g.principal_type <> 'share_link'
           OR (sl.revoked_at IS NULL AND (sl.expires_at IS NULL OR sl.expires_at > now())))`,
    [projectId, chain.map(c => c.id)]);

  // Per-principal NLW over the chain (R15) — the same rule, evaluated for everyone at once.
  const byPrincipal = new Map<PrincipalKey, AtomSet>();
  for (const p of distinctPrincipals(grants))
    byPrincipal.set(p, materialise(nearestOnChain(grants, p, chain)));

  // Query 2: expand groups to users, and fetch org owners/admins in one statement.
  const { members, ownersAndAdmins } = await expandGroupsAndOrgRoles(projectId, byPrincipal);

  const out = new Map<PrincipalKey, AtomSet>();
  for (const [p, atoms] of byPrincipal)
    for (const userKey of expand(p, members)) out.set(userKey, union(out.get(userKey), atoms));
  for (const userKey of ownersAndAdmins) out.set(userKey, ALL_ATOMS);            // R13
  applyCeilings(out);                                                            // R9, R17
  return out;
}
```

Cost: two indexed queries, independent of the number of entities. Asserted against
`resolveProject` by property **P13**: for every generated world, subject and resource,
`resolveResource(ref).get(subjectKey)` equals `atomsAt(resolveProject(subject), ref)`. One
algorithm, two directions, one test that they agree.

Its consumers:

1. The **"Who has access"** dialog lists *people*, not grants, with their **effective** role per
   resource and an expandable "why" showing each contributing grant and its deciding level.
   `GET /projects/:id/access?explain=1`, gated on `sharing:manage`, 403 for guests. Share-link
   principals are **not** listed here; links have their own section (§7.12).
2. The **defeated-grant warning.** When an admin saves a grant whose principal's effective set at
   that resource is unchanged or wider, the API returns `200` with
   `warnings: [{ code: 'grant_has_no_effect', via: ['group:analysts'] }]` and the UI shows
   *"Ana is still an Editor here via the group Analysts."* with a one-click "narrow that too".
   Computed from one `resolveResource` call after the write, not from N resolves.
3. The **move / area-delete preview** (§7.11): diff `resolveResource(entity)` before and after,
   which is two calls and gives *"will give 3 more people access and remove access for 1"*.
4. **Guest @-mention autocomplete** (§3.2): a guest may mention only principals returned by
   `resolveResource` for the resource they are commenting on.
5. **Access-request routing** (§7.13): the recipients are the users in `resolveResource(ref)`
   whose atoms include `sharing:manage`.

### 7.8 Authority by operation — create, update **and** delete

A new object has no id, so it cannot be the resource. **R19 — every schema operation is
authorised against a stated resource.** An earlier draft covered creation only, which left two
concrete questions open; both are answered here.

| Object | Create at | Update at | Delete at | Atom |
|---|---|---|---|---|
| entity with `areaId` | that area | the entity | the entity | `schema:edit` |
| entity without `areaId` | the project | the entity | the entity | `schema:edit` |
| field / index / constraint | the owning entity | the owning entity | the owning entity | `schema:edit` |
| link | **both** endpoint entities | **both** endpoint entities | **both** endpoint entities | `schema:edit` on each |
| **area** | the project | **the project** | **the project** | `schema:edit` |
| namespace, custom type | the project | the project | the project | `schema:edit` |
| comment | the target entity (or the field's entity) | own only | own only | `comment:create` |
| snapshot | the project | — | the project | `schema:edit` (+ R21′ on restore) |
| grant / share link | the grant's own resource | same | same | `sharing:manage` (R5) + R4 / R4a |

**Why area delete and update are at the project, not at the area.** If they were at the area,
Dana — the Billing-only editor of the spec's workflow #2 — could delete the Billing area. §7.11
would then null out its three entities' `areaId` and hard-delete the area grant, locking her
irreversibly out of the tables she was editing, with no recovery below org-admin. Authorising at
the project means the one person who can dismantle a sharing boundary is someone who can see
across it. Renaming an area is grouped with deleting it for the same reason: the area label is
what the "Who has access" dialog uses to describe a grant.

**Why link delete requires both endpoints.** A link with one visible and one stub endpoint is
rendered to a redacted client (Dana sees the `products` link as a faded stub). If deletion were
authorised at one endpoint, the Billing editor could drop a foreign key on a Catalog table she
cannot see. Requiring both means a stub-touching link is **not deletable** by that client, so the
client must know it: **the UI hides destructive affordances on any link carrying a `restricted`
endpoint**, and the API returns `403 link_endpoint_not_permitted` rather than 404 (the link's
existence is already disclosed by the stub, so 403 is the honest shape). Both cases are in
§11.2.

**Moving** an entity to a different area requires `schema:edit` at **both** the old parent and
the new parent. Otherwise "move it into the area I control, then edit it" is an escalation.

### 7.9 `canOpenProject` — a derived boolean, not a tenth atom

The freelancer in workflow #2 has no project-level grant at all, so
`projectAtoms.has('schema:view')` is `false` — yet they must be able to open the project and see
the Billing area. C5 forbids inventing an atom, so `canOpenProject(map)` (§7.5) is derived from
the map alone.

It gates: `GET /projects` (the list), `GET /projects/:id` (the shell: name, engine badge,
terminology — not the schema), `GET /projects/:id/ir` (which is then redacted), and
`WS project:subscribe`. It is **never** used for a write or for anything that returns schema
content unredacted. It is exposed as `@RequireProjectAccess()` (§10.2), a separate decorator from
`@RequirePermission`, so the difference is visible at the call site.

### 7.10 Field level, including nested fields

Fields have no grants. Visibility is a function of the field's entity atoms, `field.isRestricted`,
`project.restrictedFieldMode` — and, for document engines, the field's **ancestors**.

```ts
export type FieldVisibility = 'entity-hidden' | 'full' | 'masked' | 'hidden';

/**
 * R24 — restriction is inherited down the field subtree. A child of a restricted field is at
 * most as visible as its parent. Doc 04 gives Field.parentFieldId for nested document fields
 * (SPEC §3.1); without this rule a non-restricted child of a restricted parent resolves to
 * 'full', survives redaction, and carries a parentFieldId pointing at a mask stub (a dangling
 * reference) or at nothing at all (an existence disclosure in hide mode).
 */
function fieldVisibility(
  ctx: VisibilityContext,
  f: { entityId: string; parentFieldId: string | null; isRestricted: boolean },
  byId: ReadonlyMap<string, { parentFieldId: string | null; isRestricted: boolean }>,
): FieldVisibility {
  if (!ctx.visibleEntityIds.has(f.entityId))     return 'entity-hidden';
  if (ctx.restrictedOkEntityIds.has(f.entityId)) return 'full';

  // walk up the sibling chain; any restricted ancestor restricts this field
  let restricted = f.isRestricted;
  for (let p = f.parentFieldId; p && !restricted; p = byId.get(p)?.parentFieldId ?? null)
    restricted = byId.get(p)?.isRestricted ?? false;

  if (!restricted) return 'full';
  return ctx.restrictedFieldMode === 'mask' ? 'masked' : 'hidden';
}
```

The depth of a field tree is small (PostgreSQL has none; a document schema is a handful of
levels), and `byId` is the raw model's own field map, so the walk is free.

`restrictedOkEntityIds` is **per entity**: the same user can hold `field:viewRestricted` on the
Billing area and not on the rest of the project. That is a feature, and it is why this is a set
rather than a boolean.

| Surface | `full` | `masked` | `hidden` |
|---|---|---|---|
| **Read** (IR, entity detail, docs mode) | the field, everything | the field object with **every leaking property blanked to a constant** — see §8.5. Real `id`, real `entityId`, real `parentFieldId`, real `ordinal`, `restricted: true`; **no** name, no type, no nullability, no docs, no `engineProps`, no PII/deprecated flags | omitted entirely; surviving siblings renumbered densely within their own `(entityId, parentFieldId)` group (L22) |
| **Canvas** | normal row | greyed row labelled `Restricted`, no type badge | nothing; **no "+2 hidden" badge** (that would be a count leak) |
| **Edit** (`PATCH/DELETE /fields/:id`) | allowed with `schema:edit` | `403 restricted_field` (existence already disclosed, so 403 is honest) | `404` (must not confirm existence) |
| **Reorder neighbour** (`POST /fields/:id/move { beforeFieldId }`) | allowed | **allowed** — naming a masked field as the neighbour is authorised by `schema:edit` on the entity and discloses nothing the client does not already hold | not addressable; `beforeFieldId: null` means "append after the entity's true last field", which is how a redacted client reaches the end of the list |
| **Create a colliding name** | normal unique error | normal unique error naming the conflict | `422 name_unavailable`, no detail — residual oracle, see L21 |
| **Set `isRestricted = true`** | `schema:edit` **+** `field:viewRestricted` on that entity (R20) | n/a | n/a |
| **Set `isRestricted = false`** | `sharing:manage` on that entity or an ancestor (R20) | n/a | n/a |
| **Export** (DDL/JSON/MD/PDF/PNG) | included | **omitted** — `mask` semantics cannot be expressed in valid DDL, so export always uses `hidden` semantics + one un-quantified notice line (L11) | omitted, same notice |
| **AI context** | included | **never included, in either mode** | never included |
| **Realtime** | patch emitted | only ordinal/structural stub deltas; a patch that redacts to a no-op is dropped | no event at all |
| **Search / autocomplete / @-mention** | matches | never matches, never suggested | never matches, never suggested |
| **Comments on the field** | visible | dropped | dropped |
| **Coverage meter** | counted | excluded from numerator **and denominator** | excluded from both |

**Why a masked field discloses no name.** This is the one place where this document and doc 04
§10.1 genuinely disagree, so the reasoning is written out. Doc 04 keeps `name`, `type` and
`isNullable`, on the grounds that "keeping name and type is the point of masked". But **SchemaLoom
stores no data** — a schema designer's only content *is* names, types and documentation. If a
masked column keeps its name and type, then `field:viewRestricted` protects nothing at all and
the feature is decorative; the spec's own workflow #2 ("salary columns Restricted") would leave
the freelancer reading the word `salary` next to `numeric(10,2)`. The honest reading of SPEC §5's
"masked or not at all" is: *mask* discloses that a slot exists and where it sits, *hide* discloses
nothing. That is what §8.5 emits, and it is the resolution recorded in §14 Q12(f).

**R20 — asymmetric authority on the `isRestricted` flag.** Turning restriction **on** needs
`schema:edit` + `field:viewRestricted` on that entity: the people who know which column holds PII
are the editors, and you must be able to see a field to classify it. Turning it **off** is a
de-restriction — an access-control change — and needs `sharing:manage`. Both are audit-logged and
both bump `Project.permGeneration`. The spec files the Restricted flag under "structured field
docs" (§6.2), which would imply `docs:edit`; that is too weak for the un-restrict direction and
this document deviates deliberately (§14 Q5).

**Ids in a redacted model are real.** An earlier draft replaced every hidden object's id with a
per-project HMAC stub token (`est_…`, `fst_…`), derived through HKDF from the app secret, and
banned the prefix at the DTO boundary. **All of that is deleted.** It bought nothing: a cuid
carries no name, ids are per-row so there is nothing to correlate across projects, and every
route already returns `404` for an id the subject cannot see (§10.3 step 8). What it cost was
real — a key-derivation path, a `stubKey` threaded through every context, an unanswered key
rotation question, a broken "Request access" button (the faded stub is exactly where the user
clicks, and §7.13 needs a real target), and a broken field reorder (a redacted client's
`beforeFieldId` is frequently the masked column). Doc 04 keeps the real id for precisely these
reasons and it is right. Confidentiality lives in the *properties* that are blanked, which is
where it belongs.

### 7.11 Area vs entity, and what deletion does to grants

**Confirmed against the spec:** an entity belongs to **at most one** area. SPEC §5 puts Area
between Project and Entity in a single hierarchy, §6.1 colours an entity card by its area (one
colour), and §9 gives `entities` a single area reference. So `Entity.areaId String?`.

- **Entity in no area.** `areaId = null`. Its chain is `[entity, project]` — the area level is
  simply absent. It inherits project grants and nothing else (E11). This is the default for a
  fresh import before the user groups anything, so it must be the common, boring path.
- **Entity moves between areas.** Grants live on the *area*, not on the entity. The moment
  `areaId` changes, the entity inherits the new area's grants and loses the old area's.
  **Entity-level grants survive the move unchanged.** Consequences and mitigations:
  1. The move can **expose** the entity to the new area's grantees, or **hide** it from the old
     area's. This is the correct semantic — areas are the sharing unit — but it must not be
     silent.
  2. `?dryRun=1` returns a preview built from two `resolveResource` calls (§7.7), and the move
     dialog shows *"Moving `employees` into Billing will give 3 more people access and remove
     access for 1."*
  3. The move writes an `audit_log` row of action `entity.area_changed` — an access-relevant
     event, not just an activity-feed one — and bumps `Project.permGeneration` (§9.3).
  4. If the entity has a restricted field and the move would expose it to principals holding
     `field:viewRestricted` on the target area, the dialog says so explicitly.
- **Deleting an area** (authorised at the project, R19). Its entities become `areaId = null` —
  they do not cascade-delete — every grant on that area is hard-deleted with a before-image in
  the audit log, and the generation is bumped. The dialog warns with the same principal diff.
- **Deleting an entity.** Every grant whose `(resourceType, resourceId)` is `('entity', id)` is
  hard-deleted **in the same transaction**, with a before-image in the audit log, and the
  generation is bumped. An earlier draft covered only area deletion, which left entity grants
  orphaned forever: `AccessGrant.resourceId` deliberately has no foreign key (doc 02 §4), so
  nothing cleaned them up, `liveGrants` kept returning them, they appeared in "Who has access"
  against objects that no longer exist, and — worst — the `@@index([principalType, principalId])`
  projects-list query kept returning candidate projects for principals whose only grant was on a
  deleted entity, so `GET /projects` resolved dead projects on every page load. Same rule as
  areas, same before-image, one transaction.

### 7.12 Share links

A share link is **not a side path**. It creates an ordinary `AccessGrant` whose principal is the
link, so the resolver has zero share-link branches except the R17 ceiling.

**R25 — the link and its grant are one object with two rows, and the link is the handle.**
`ShareLink` carries **no** `resourceType` / `resourceId` / `organizationId`; the target is read
off its grant (doc 02's design, adopted). Three consequences, all of which close a real failure:

1. **Creation** (`sharing:manage` + R4 at the target resource) writes, in one transaction: the
   `ShareLink` row, an `AccessGrant { principalType: 'share_link', principalId: link.id,
   resourceType, resourceId, roleId: <built-in viewer> }`, an audit row, and
   `Project.permGeneration++`. **The role is always the built-in `viewer`** — there is no role
   picker on link creation, so R17's ceiling is defence in depth rather than the only control.
   The plaintext token is returned **once** and never stored (only `sha256(token)`, unique-indexed).
2. **Revocation goes through the share-link endpoint only.** `DELETE /share-links/:id` sets
   `revokedAt` **and deletes the grant** in one transaction. Share-link grants are **hidden from
   the "Who has access" grant list** and rendered in their own "Links" section, whose only action
   is Revoke. Otherwise a manager tidying the dialog deletes the grant, the `ShareLink` row
   survives, the token route still resolves it, still accepts the password, still mints a
   12-hour session — and then every API call returns 404. A visitor who unlocked successfully and
   sees nothing is indistinguishable from a broken product, and the audit log records a
   successful `share_link.unlocked` for access that does not exist.
3. **Nothing can disagree**, because there is only one copy of the target.

**The session.**

```ts
// cookie: sl_session — httpOnly, Secure, SameSite=Lax, Path=/, no localStorage, ever
type ShareLinkSession = {
  sub: `share_link:${string}`;   // the link id
  pid: string;                   // the project id — a session can address exactly one project
  rid: string;                   // the granted resource id, for the landing route
  exp: number;                   // min(link.expiresAt, now + 12h)
};
```

**`Path=/`, not `Path=/s`.** Every request after the unlock goes to `/api/projects/:id/ir`,
`/api/comments`, `/api/projects/:id/exports` and `WS project:subscribe`. A cookie scoped to `/s`
is never sent to `/api/**`, so the guard would find no subject and the entire share-link flow
would 401 — §12.2 steps 5–13 could not happen. The scoping that matters is not the path: it is
`session.pid`, checked on every request (step 4 below), plus `SameSite=Lax`. There is no `jti`;
revoking the link revokes the access, which is the only revocation anyone asked for.

Flow:

1. `GET /s/:token` → `sha256` lookup. Not found, revoked, or expired → **`404`, always the same
   body, always the same latency class**. No "this link expired" message: that is an oracle for
   token guessing. (The email that carried the link can say it expired; the endpoint cannot.)
2. If `passwordHash` is set → render the unlock form. `POST /s/:token/unlock` verifies with
   argon2id, rate-limited **5 per minute per IP and 20 per hour per link** (Redis), with a
   constant-time-ish uniform failure response. No project or org name on this page — those are
   names.
3. On success mint `sl_session`, touch `lastUsedAt` / `useCount` (fire-and-forget, off the
   critical path), and redirect to the resource.
4. Every subsequent request carries the cookie. `PermissionGuard` builds
   `Subject { kind: 'share_link', … }` and **rejects if `session.pid !== the requested projectId`** —
   a share-link session can never address a second project even if ids are guessed.
5. `resolveProject` runs normally. The ceiling (R17) reduces the link's atoms to `{ schema:view }`.

**A signed-in visitor who also holds a link session (addendum, 2026-10-01).** Both cookies
arrive. `JwtAuthGuard` keeps the user as `req.auth` and the link as `req.shareAuth`.
`PermissionGuard` decides as the user, and only when that answer is `404` (the account can't see
the project at all) does it decide again as the link, which still has to pass R21 and step 4. So
a member testing their own link keeps their own access, and an outsider with a link sees the
link's view instead of a 404. The realtime gateway does the same at `project:subscribe`.

**R21 — the share-link surface allow-list.** Beyond the atom ceiling, a share-link subject may
reach **only** these surfaces, and every other route returns `404`:

```ts
// apps/api/src/access/share-link-allowlist.ts
export const SHARE_LINK_ROUTES = new Set([
  'GET /projects/:id',              // the shell: name, engine badge, terminology
  'GET /projects/:id/ir',           // redacted
  'GET /projects/:id/docs',         // docs-mode read (Phase 5)
  'GET /projects/:id/search',       // client-side over the payload it already holds
  'WS  project:subscribe',
]);
```

An earlier draft expressed this as a **deny**-list (comments, activity, snapshots, presence,
member identities, access requests, "Who has access", mention autocomplete). A deny-list over a
deliberately fat atom — `schema:view` grants structure, docs, comments, presence and search in
one — is fail-open: every future surface built under `schema:view` (Phase 5 docs mode, AI
doc-draft suggestions, the coverage drill-down) is a share-link leak by default until somebody
remembers to add a row. Inverting it is the same amount of code and fails closed, and the
boot-time route sweep (§10.3 step 1) then asserts that **every** route is classified as
share-link-reachable or not. A public link exposing an internal comment thread ("we're dropping
this table when Acme churns") is a leak the atom set alone would never have prevented.

**Revocation, propagation.** `revokedAt` set + grant deleted + audit row + `permGeneration++`, in
one transaction. The next request from that link re-reads the generation from Postgres, misses
the map, re-runs the hot query, finds no live grant (R12.2), and gets `EMPTY_MAP` →
`canOpenProject = false` → `404`. **Propagation is the next request, full stop** (§9.4). The
signed cookie is not revoked and does not need to be — it authenticates a principal whose grant
no longer exists.

**Expiry needs no cron**: it is a SQL predicate (R12) **and** it caps `validUntil`, because
`nextExpiryOf` now reads `share_links.expires_at` as well as `access_grants.expires_at` (§7.5).
An earlier draft claimed "a cached map never outlives the grant that produced it" while neither
selecting nor folding in the link's expiry, so a link expiring in 30 seconds whose grant had a
null `expiresAt` produced a map cached for 300 seconds: four and a half minutes of full read
access past the link's stated expiry. §9.1 makes the TTL derivation normative.

### 7.13 Access requests

- **Who can request.** Any authenticated user. `POST /access-requests { projectId, resourceType,
  resourceId, requestedRoleKey?, message? }` returns **`202 Accepted` unconditionally** — for a
  project that does not exist, for one in another org, for one you already have. It creates a row
  only when the target exists and is in the requester's org. This makes the endpoint a
  non-oracle: you cannot enumerate projects through it.
- **The stub case works**, because stub ids are real ids (§7.10). The faded entity on the canvas
  is exactly where the user clicks "Request access", and the id it carries is the id this
  endpoint takes. No exception, no reverse map.
- **Rate limit:** one open request per `(resource, requester)`, enforced by doc 02's partial
  unique index `access_requests_pending_uq`; plus one *new* request per `(resource, requester)`
  per 24 h in Redis. **A denied request does not block a later one** — the partial index covers
  only `status = 'pending'`, which is why §6.2 removes the four-column `@@unique` an earlier
  draft carried.
- **Who is notified.** `resolveResource(projectId, ref)` (§7.7), filtered to principals holding
  `sharing:manage` — which by R5 already includes anyone holding it at an ancestor. If that set
  is empty, fall back to the org's owners and admins. Capped at 25 recipients, ordered by most
  recent activity in that project, to stop a 200-person org from being paged. In-app notification
  always; email according to each recipient's notification settings.
- **Who can approve.** Anyone in that set — recomputed at approval time, never trusted from the
  notification. Approval is an ordinary grant write and is therefore subject to R4 attenuation:
  an approver cannot grant more than they hold.
- **What approval grants.** `role = requestedRoleKey ?? approver's choice ?? viewer`,
  `canUseAi = false`, `canViewRestricted = false`, `expiresAt = null`. The two modifiers are never
  set by an approval flow — turning them on is always a deliberate, separate act.
- **Denial** records `decisionNote` (optional, shown to the requester) and notifies the requester.
- Every transition writes an `audit_log` row.

### 7.14 The grant write path — one transaction, one lock

R4 is a read-then-write: it reads the grantor's effective atoms and then writes a grant. Nothing
in an earlier draft serialised that against a concurrent change to the grantor's own access, or
against a second `sharing:manage` holder writing the same row, and P11 would have passed against
a simulated resolver while the real service raced.

**R26 — every access-control write takes a project-scoped advisory lock, re-resolves inside it,
and commits the change, the audit row and the generation bump together.**

```ts
await prisma.$transaction(async (tx) => {
  // ponytail: one lock per project. Per-resource locks only if a project ever sees
  // contended sharing writes, which a schema designer will not.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, 0))`;

  const map  = await resolver.resolveProjectUncached(grantor, projectId, tx);   // inside the lock
  const skel = await resolver.skeleton(projectId);
  resolver.assertMayGrant(map, skel, ref, materialise(proposed));               // R4

  const before = await tx.accessGrant.findUnique({ where: { id } });
  const after  = await tx.accessGrant.upsert({ /* … */ });
  await tx.auditLog.create({ data: audit('grant.updated', before, after) });
  await tx.project.update({ where: { id: projectId }, data: { permGeneration: { increment: 1 } } });
});
await resolver.invalidate({ project: projectId });
```

The same shape covers grant delete (with `assertMayDeleteGrant`), share-link create/revoke,
`isRestricted` toggles and `restrictedFieldMode` changes.

**Why access-control rows carry no `version Int`, deviating from C7.** C7 exists for *user-edited
schema objects*, where two people editing the same table must not silently clobber each other and
the loser needs a 409 to re-render. A grant is not edited over minutes in a panel; it is set from
a dropdown, and the failure mode that matters is not "lost update" but "escalation computed
against stale authority". The advisory lock closes that, and it closes it for *sequences* of
writes, which a per-row version cannot. Carrying both would be two mechanisms for one problem.
This deviation is deliberate and is stated rather than left silent.

### 7.15 Integrity of the polymorphic pointer

`AccessGrant.resourceId` is polymorphic and has no foreign key — doc 02 chose that deliberately
and documents what it costs. This document buys part of it back where it is cheapest, inside
`indexGrants`, which every resolve already runs:

```ts
function indexGrants(grants: readonly LiveGrant[], projectId: string, skel: ProjectSkeleton) {
  const out = new Map<PrincipalKey, { project?: LiveGrant; area: Map<string, LiveGrant>;
                                      entity: Map<string, LiveGrant> }>();
  for (const g of grants) {
    // A 'project' grant whose resourceId is a DIFFERENT project would silently grant full
    // access here. doc 02's access_grants_project_self_ck already forbids it; this is the
    // application-side alarm for a row that predates the constraint or arrived by backfill.
    if (g.resourceType === 'project' && g.resourceId !== projectId) { warn('grant_project_mismatch', g); continue; }
    if (g.resourceType === 'area'   && !skel.areaIds.includes(g.resourceId)) { warn('grant_dangling_area', g); continue; }
    if (g.resourceType === 'entity' && !skel.entityById.has(g.resourceId))   { warn('grant_dangling_entity', g); continue; }
    place(out, g);
  }
  return out;
}
```

Every `warn` is a structured pino line at `warn` level and a counter; a non-zero rate means a
delete path is missing. Backed by **a weekly BullMQ sweep** that deletes grants whose
`(resourceType, resourceId)` no longer resolves and grants whose `roleId` belongs to another org
(R3), logging both counts. A non-zero count is a bug report, not routine hygiene.

---

## 8. `VisibilityFilter`

### 8.1 Surface

The pure part lives in `packages/schema-model` alongside the IR it transforms (§8.6 explains why
that placement is load-bearing, not cosmetic). The impure part is a Nest service in `apps/api`.

```ts
// packages/schema-model/src/redact.ts — depends on zod and this package only (C10)
declare const REDACTED: unique symbol;

/** Structurally a SchemaModel (doc 04: "the same type, validated by the same zod schema"),
 *  plus a phantom brand no cast-free code can forge. At runtime the marker is the real
 *  `redacted: true` field doc 04 already defines. */
export type RedactedModel = SchemaModel & { readonly [REDACTED]: true };

/** The only thing SchemaLoader returns. See §8.6 — the payload is genuinely unreachable. */
export class RawSchemaModel { /* opaque; see §8.6 */ }

export interface VisibilityContext {
  readonly projectId: string;
  readonly subjectKind: 'user' | 'share_link';
  readonly subjectKey: string;
  readonly canOpenProject: boolean;
  readonly visibleEntityIds: ReadonlySet<string>;
  readonly restrictedOkEntityIds: ReadonlySet<string>;
  /** Areas where the subject holds anything at all — an area with a live grant and no
   *  entities yet must still be rendered (§8.3, area rule). */
  readonly areasWithAtoms: ReadonlySet<string>;
  readonly restrictedFieldMode: RestrictedFieldMode;
  /** R21′ needs both of these and cannot fetch them: redact is pure. */
  readonly totalEntityCount: number;
  readonly entitiesWithRestrictedFields: ReadonlySet<string>;
}

/** Pure. No I/O, no clock. The only producer of RedactedModel. */
export function redact(raw: RawSchemaModel, ctx: VisibilityContext): RedactedModel;

/** Realtime. Returns null when the patch redacts to a no-op — the caller must not emit. */
export function redactPatch(patch: IrPatch, ctx: VisibilityContext): IrPatch | null;
```

```ts
// apps/api/src/access/visibility-filter.service.ts
@Injectable()
export class VisibilityFilter {
  /** One resolve per request, memoised (§9.5). Projects ProjectPermissionMap + skeleton. */
  computeContext(subject: Subject, projectId: string): Promise<VisibilityContext>;

  /** Re-exported so callers have one import site. */
  redact(raw: RawSchemaModel, ctx: VisibilityContext): RedactedModel;
  redactPatch(patch: IrPatch, ctx: VisibilityContext): IrPatch | null;

  /** Generic row filter: activity, comments, notifications, search hits, doc-draft suggestions. */
  redactRefs<T>(rows: readonly T[], ref: (t: T) => TargetRef, ctx: VisibilityContext): T[];

  /** L25. Saved queries and AI messages, whose BODY is raw schema text. */
  filterQueryRows<T extends { touchedEntityIds: string[]; touchedFieldIds: string[] }>(
    rows: readonly T[], ctx: VisibilityContext, fieldVis: FieldVisibilityIndex): T[];

  /** TipTap JSON: rewrites or removes @mention nodes pointing at invisible objects. */
  redactRichText(doc: JSONContent, ctx: VisibilityContext): JSONContent;
}
```

`computeContext` is a projection of `ProjectPermissionMap` + `ProjectSkeleton` (§7.5) — the filter
does not re-resolve anything:

```ts
async computeContext(subject, projectId) {
  const map  = await this.resolver.resolveProject(subject, projectId);
  const skel = await this.resolver.skeleton(projectId);
  return {
    projectId, subjectKind: subject.kind, subjectKey: map.subjectKey,
    canOpenProject: canOpenProject(map),
    visibleEntityIds:      visibleEntityIds(map, skel),
    restrictedOkEntityIds: restrictedOkEntityIds(map, skel),
    areasWithAtoms: new Set([...map.areaAtoms].filter(([, s]) => s.size > 0).map(([a]) => a)),
    restrictedFieldMode: map.restrictedFieldMode,
    totalEntityCount: skel.entities.length,
    entitiesWithRestrictedFields: skel.entitiesWithRestrictedFields,
  };
}
```

### 8.2 The guarantees

> **G1 (soundness).** For all `raw` and `ctx`, `JSON.stringify(redact(raw, ctx))` contains no
> substring equal to any `name`, `doc.plainText`, `TypeRef.display`, `engineProps` value or
> `IndexColumn.expression` belonging to an object that `ctx` says is invisible, and none
> belonging to a masked or hidden field. *Testable directly — §11 P4.*
>
> **G2 (purity).** `redact` performs no I/O, reads no clock, and is deterministic given
> `(raw, ctx)`.
>
> **G3 (idempotence).** `redact(new RawSchemaModel(redact(raw, ctx)), ctx)` deep-equals
> `redact(raw, ctx)`.
> Stubs and masks survive a second pass unchanged.
>
> **G4 (bounded alteration).** A surviving object loses **no property except those §8.3 lists for
> its kind**, and nothing is reordered, re-keyed or normalised. *Note the wording.* An earlier
> draft said "every visible object is byte-identical to its raw form", which is false on its own
> rules: §8.3 drops `name` from a visible link with one hidden endpoint, and blanks `engineProps`
> on a visible field whose default references a restricted column. The property test compares
> against an oracle derived from the §8.3 table, not against the raw object (P3).
>
> **G5 (totality).** Every `IrObjectType` in doc 04's `IR_OBJECT_TYPES` has an explicit rule in
> §8.3. A new object type added to the IR without a rule here fails a compile-time exhaustiveness
> check (`assertNever` on the type union).

### 8.3 Redaction rules, against doc 04's actual shape

The redacted payload is a `SchemaModel`: `{ irVersion, projectId, engineId, engineVersion,
redacted: true, objects: { area, namespace, customType, entity, field, constraint, index, link } }`
where each collection is `Record<Id, T>` keyed by the **singular** type name (doc 04 §1.3). An
earlier draft emitted top-level arrays (`entities`, `links`, `indexes`, …), `source`/`target`
endpoints with a singular `fieldId`, a `coverage` key on the model, and stubs missing `name`,
`version`, `doc` and `engineProps`. None of that typechecks against doc 04, so
`RedactedModel = SchemaModel & brand` was uninhabitable and doc 04's compatibility story was
false. Everything below is written against the real shape.

| Kind | Rule |
|---|---|
| **Entity, visible** | kept; its fields filtered per §7.10; the **expression rule** below may blank `engineProps` |
| **Entity, invisible, referenced by a surviving link** | kept as a **stub** (§8.5): real `id`, real `kind`, real `namespaceId`, real `position`, `name: ''`, `areaId: null`, `version: 0`, `doc: null`, `engineProps: {}`, `restricted: true` |
| **Entity, invisible, not referenced by anything that survives** | **absent** from `objects.entity` |
| **Field on a visible entity** | per §7.10: `full`, `masked` (§8.5), or omitted |
| **Field on a stub or absent entity** | always omitted — a stub entity has no fields |
| **Link, both endpoint entities visible, no redacted endpoint field** | kept; expression rule may still apply |
| **Link touching a stub entity, or any endpoint field that is masked or hidden** | kept so the stub renders connected, with: `name: ''`, `from.fieldIds = []` **and** `to.fieldIds = []`, `from.role`/`to.role` dropped, `engineProps: {}` (it holds `onDelete`, `matchFull`, and the constraint name), `restricted: true` |
| **Link, both endpoint entities invisible** | absent |
| **Index referencing a hidden (hide-mode) field** | **absent** — its `columns[].fieldId` would dangle |
| **Index referencing a masked field, or whose `refs` are not fully visible** | kept with `name: ''`, `engineProps: {}` (it holds the partial `WHERE`), every `IndexColumn` with `expression !== null` removed, `restricted: true`. If no `role: 'key'` column survives, the whole index is **absent** |
| **Constraint referencing a hidden field** | **absent** |
| **Constraint referencing a masked field, or whose `refs` are not fully visible** | kept with `name: ''`, `engineProps: {}` (the CHECK body lives there), `fieldIds` unchanged, `restricted: true` — this is what keeps the PK badge rendering |
| **CustomType** | project-scoped, not entity-scoped. Kept if the subject can see any entity, because type *names* are shared vocabulary. **Exception:** a composite type whose attributes mirror a hidden entity is a leak vector — §14 Q7; v1 keeps them and flags it |
| **Namespace** | kept if it contains at least one surviving entity (stub or full); otherwise omitted (a name like `payroll_private` is a name) |
| **Area** | kept if it contains at least one **visible** entity **or** `ctx.areasWithAtoms.has(area.id)`. The second clause matters: SPEC workflow #2 starts with the owner creating an empty "Billing" area and sharing it *before* grouping tables into it. Without it the freelancer's first load has no area to draw on and a create-entity call names an area the client was never told exists. A **stub** entity never keeps an area alive and never carries `areaId` |
| **`doc` on a surviving object** | kept for `full` objects, `null` for anything carrying a `restricted` mark. `doc.plainText` on a surviving object is free prose — see L26 |
| **Comments** (separate endpoint, not in the model) | dropped with their target; body through `redactRichText`; author identity replaced with `"A team member"` for guest subjects who cannot see org membership; **not reachable at all for share-link subjects** (R21) |
| **Saved queries, AI threads and messages** (separate endpoints) | **L25**: a row survives only if every id in `touchedEntityIds` is in `visibleEntityIds` and no id in `touchedFieldIds` is masked or hidden. Otherwise the row is **omitted entirely, never stubbed** — the body *is* the payload and SQL text cannot be partially redacted. A thread with any filtered-out message is omitted whole and 404s on read |
| **Project-level metadata** (name, engine id/version, terminology) | kept if `ctx.canOpenProject` |

**The expression rule (R27) — one rule that closes L3–L6.** Doc 04 keeps defaults, generated
expressions, CHECK bodies and partial-index predicates in `engineProps`, and index expression
bodies in `IndexColumn.expression`. Those strings *textually* name other objects. Doc 04's rule
that `engineProps` never holds an id **reference** is satisfied while the leak stands, and an
earlier draft's mitigations pointed at three fields that do not exist
(`Index.fieldIds`, `Constraint.referencedFieldIds`, `Field.defaultReferencedIds`), so
`CREATE INDEX ON employees ((salary * 12))` — which references no field id at all — shipped
verbatim.

> **Required of doc 04 (one optional core field, not three):**
> ```ts
> export interface ObjectRefs { entityIds: Id[]; fieldIds: Id[] }
> // on IrBase:
> /** Every IR object this object's engineProps / expression strings textually reference.
>  *  Populated by the engine on write and on import. Absent = no cross-object expression. */
> refs?: ObjectRefs;
> ```
> and `IrBase` gains a second optional flag beside `restricted?: true`:
> ```ts
> /** This object survived, but its engineProps / expression strings were blanked. */
> propsRedacted?: true;
> ```
>
> **The rule.** For any object `O` that survives: if any id in `O.refs` is invisible, or is a
> field that is `masked` or `hidden` for this subject, then `O.engineProps = {}`, every
> `IndexColumn.expression` on it is dropped, and `O.propsRedacted = true`. The two flags are
> independent: an object may carry `propsRedacted` alone, or alongside `restricted: true` when it
> was also stubbed or masked. The UI renders `propsRedacted` as "some properties are hidden from
> you" rather than claiming the column has no default.

This is one rule over one field instead of three parallel arrays, it covers expression indexes,
partial predicates, CHECK bodies, defaults and generated columns uniformly, and it fails closed:
an engine that forgets to populate `refs` for a new props key ships `refs` empty, so **L4's
dev-time canary stays** as the tripwire that finds it — explicitly a canary, never the mitigation.

`redactRichText` walks the TipTap document and, for each `mention` node with
`attrs.targetType/targetId`, either keeps it (visible), rewrites it to
`{ type: 'mention', attrs: { restricted: true } }` rendering as a grey "restricted" pill
(invisible, `mask`), or replaces it with the plain text `"restricted"` (invisible, `hide`). It
also strips `marks` of type `link` whose `href` is an internal deep link to an invisible object.

### 8.4 Information-leak audit

This section is the reason the document exists. Each row is a channel through which a redacted
view could still disclose a hidden name, its existence, or its shape.

| # | Channel | How it leaks | Mitigation | Enforced by |
|---|---|---|---|---|
| **L1** | **Link endpoint ids** | a link to a hidden table carries the real `to.entityId` | **Accepted and stated:** the id is real (§7.10). A cuid carries no name; ids are per-row so nothing correlates across projects; the stub already discloses that *something* is there, which is the spec's own "faded stub labelled restricted". What must not survive is the **name**, and §8.3 blanks it. No route serves the id (§10.3 step 8) | `redact` blanks `name`; the guard 404s the id |
| **L2** | **Link / FK names** | `fk_orders_employee_salary` contains two hidden names; `engineProps.constraintName` the same | `name: ''` **and** `engineProps: {}` for any link touching a stub entity or a redacted endpoint field; `role` labels dropped | `redact` |
| **L3** | **Index definitions, including expression indexes** | `CREATE INDEX … ON employees ((salary * 12)) WHERE salary > 100000` names and characterises the column without referencing a field id | R27: `IndexColumn.expression` dropped, `engineProps` (the partial `WHERE`) blanked, `name` blanked, index dropped entirely if no key column survives or if any referenced field is hidden | `redact` + doc 04's `refs` |
| **L4** | **Constraint expressions** | `CHECK (salary > 0)`, `EXCLUDE USING gist (employee_id WITH =)` — both in `engineProps.expression` | R27, same rule. **Defence in depth:** in non-production builds `redact` also scans every emitted string for any redacted object's name and throws — a loud dev-time canary for an engine that under-populates `refs`. Explicitly a canary, not the mitigation | `redact` + doc 04's `refs` + dev assertion |
| **L5** | **Default values** | `DEFAULT nextval('employee_salary_seq')`, `DEFAULT (SELECT … FROM hidden_table)` — `engineProps.default` | R27: the *field* survives, its `engineProps` does not, and it is marked `propsRedacted` | `redact` |
| **L6** | **Generated / computed columns** | `GENERATED ALWAYS AS (base + bonus)` on a visible field referencing restricted ones — `engineProps.generatedExpression` | identical to L5, same rule, same mark | `redact` |
| **L7** | **Error messages** | `column "salary" does not exist`, `duplicate key value violates constraint "uq_employee_salary"`, a Postgres error echoed from the parser | **No schema identifier is ever string-interpolated into an error message.** Errors carry `{ code, objectIds? }`; the API layer resolves ids to names **through the filter**, so an unresolvable id renders as `"restricted"`. Engine/parser errors map to a fixed code list; raw driver text never reaches a response | global `ExceptionFilter`; an ESLint rule bans template literals containing `.name` inside `throw` expressions in the error modules |
| **L8** | **Counts and aggregates** | "300 tables", coverage `42/300`, pagination `total`, "3 comments" | **every aggregate is computed post-redaction**, over the redacted model, never with a `COUNT(*)` on raw rows. Coverage lives in the **response envelope**, not on the model (doc 04's `SchemaModel` has no such key) | counters derived from `redact`'s output; a repository count method is banned from controllers by §8.6 |
| **L9** | **Search results** | `GET /search?q=sal` returning a hit and then filtering it, or returning `totalHits` | **filter-then-search, never search-then-filter**: the SQL carries `entity_id = ANY($visibleIds) AND (is_restricted = false OR entity_id = ANY($restrictedOkIds))` in the `WHERE`, so the database never sees a hidden row as a candidate. No `totalHits` above the returned page | `SearchService` takes `VisibilityContext` as a required first argument |
| **L10** | **Activity log** | `"Ana renamed employee_salary to salary"`, or timestamps revealing activity on a table you cannot see | rows whose target is invisible are **omitted, not stubbed** — a stub with a timestamp leaks work patterns. Row text is templated from ids, never stored as prose (L7). For guests, actor identity falls back to `"A team member"` unless the actor shares a visible resource | `redactRefs` |
| **L11** | **Export output** | a DDL export that includes hidden tables, or a header comment `-- 14 objects omitted` | exports run on `RedactedModel` only, with `hide` semantics for fields (a masked column is not valid DDL), and **one un-quantified notice**: `-- Some objects are not included because of your access level.` No counts, no names. Export jobs **re-resolve permissions at run time**, not at enqueue time, so a grant revoked between enqueue and run takes effect. The S3 object gets a 10-minute signed URL bound to the requesting user | `ExportProcessor` takes `Subject`, calls `computeContext` itself, and calls `assertRedacted` explicitly (§8.6) |
| **L12** | **AI request context** | the model is given the whole schema and asked to "ignore" parts | the context is `aiProfile.serializeContext(redactedModel, …)` — hidden objects are **not in the string at all**. There is no "ignore these" instruction because there is nothing to ignore. The system prompt includes: *"If answering requires a table or column that is not listed above, say so instead of guessing."* | the `RedactedModel` parameter type is the enforcement |
| **L13** | **AI responses and the validator probe** | the model hallucinates a real hidden name and thereby "confirms" it | a hallucinated name is a guess, not a disclosure — and `queryValidator` runs against the **redacted** model, so such an identifier is flagged `unknown identifier` exactly like a typo. **Core passes `restrictedProbe: undefined`** (doc 03 makes it optional), so the two cases are indistinguishable in the response. Doc 03's `'hidden'` verdict — "this object exists but is not shared with you" — is a straight existence oracle and is strictly more disclosure than the canvas, which only ever stubs *linked* hidden entities and says nothing about unlinked ones. §14 Q12(h) | `AiModule` constructs `QueryValidationInput` without a probe |
| **L14** | **Autocomplete** | a separate "all identifiers in this project" endpoint for the query editor and for `@`-mentions | **there is no such endpoint.** Autocomplete is served from the same redacted payload the canvas already has, client-side. Adding an identifier endpoint would be a new escape hatch | architecture; the boot sweep classifies every route |
| **L15** | **Realtime events** | the socket broadcasts `entity.renamed` for a hidden table to every subscriber of the project room | one project room, but **redaction at emit time per socket**: `redactPatch(patch, ctxForThatSocket)`; `null` means do not emit. Per-entity rooms are *not* the mechanism because room membership goes stale the moment a grant changes; the per-socket context is refreshed on the `permissions:changed` signal (§9.3) | `RealtimeGateway.emitToProject` takes an `IrPatch`, never a pre-serialised payload |
| **L16** | **Presence** | another user's cursor / selection carries the id of a hidden entity | presence payloads carry `{ userId, entityId?, fieldId? }` and go through `redactRefs`; a peer selecting an invisible object is broadcast as `{ userId, at: null }` ("elsewhere in the project"). Share-link subjects receive no presence at all (R21 allow-list) | `RealtimeGateway` |
| **L17** | **Notifications and their emails** | a mention email quotes a comment on a table the recipient cannot see | the body is rendered **per recipient** through that recipient's `VisibilityContext` at send time; if the target is invisible the notification is not sent at all, and the mention UI warns the author: *"Bob cannot see this table — they will not be notified."* | `NotificationService` |
| **L18** | **Snapshots, diffs, migrations, restore** | a snapshot taken when you had wider access is replayed; a diff shows a hidden table being added; a migration script `DROP`s what you cannot see; **a restore silently un-restricts a column** | snapshots are redacted with the **current** context, never the capture-time one. Diffs are computed **between two redacted models**. Migration generation and restore require R21′. **R28 (below)** stops restore from rewriting access-control attributes | `HistoryService` |
| **L19** | **Import** | pasted DDL colliding with a hidden table name, or overwriting it | same rule as L18 — import requires the full view (R21′) | `ImportService` |
| **L20** | **Full-list write endpoints** *(integrity, not confidentiality — same root cause)* | `PUT /entities/:id { fields: [...] }` from a redacted client **deletes the fields it could not see**; a reorder sending a dense ordinal array clobbers a hidden field's position | **R22 — no write endpoint accepts a full-list replacement of a redactable collection.** Field reorder is `POST /fields/:id/move { beforeFieldId \| null }` and the server recomputes ordinals over the true list. Entity update never accepts `fields[]`. Index column order is `{ fieldId, ordinal }` pairs applied as a patch | DTO shape; a zod schema with no array-replacement member |
| **L21** | **Name-collision oracle** | in `hide` mode, creating a field named `salary` fails with a unique violation, proving it exists | irreducible — the namespace is genuinely shared. Mitigated to a generic `422 name_unavailable` with no detail, and this is the stated reason `mask` is the default (§6.3). Documented for the customer rather than pretended away | `FieldService` + product documentation |
| **L22** | **Ordering and position gaps** | fields `0,1,3,4` in `hide` mode reveal that slot 2 exists | ordinals are **densely renumbered per sibling group** — per `(entityId, parentFieldId)`, not per entity, because doc 04 scopes ordinal uniqueness to siblings and renumbering across a whole entity would corrupt every nested field. Entities need no equivalent (canvas positions are absolute; a stub occupies its real coordinate by design) | `redact`; P9 |
| **L23** | **Timing** | a request touching many hidden objects takes measurably longer | redaction is `O(objects)` with no per-hidden-object I/O, and the mode is a *project* setting, so two users of the same project have the same work profile. Not a hard guarantee; accepted residual risk for a schema-design tool | noted, not mitigated |
| **L24** | **Cached responses** | a redacted model cached under a project-only key and served to a second user | **redacted output is never cached** (§9.5), and every schema response carries `Cache-Control: private, no-store` plus `Vary: Cookie`. Redis holds permission maps and the subject-independent skeleton — never redacted content | response interceptor sets the headers globally for `/projects/**` |
| **L25** | **Saved queries and AI transcripts** | the body of a saved query is literally `SELECT salary FROM employees`. An analyst with full access in March saves it, is narrowed to Billing in April, opens the query library, and reads Catalog table names and the salary column in plain text. Worse for threads: turn 1's SQL is re-sent to the provider on every follow-up (defeating L12) and re-rendered on reload | a row survives only if every `touchedEntityIds` id is visible and no `touchedFieldIds` id is masked or hidden; otherwise **omitted entirely, not stubbed**. Both arrays are persisted at write time from `QueryValidationResult` (§6.3), so the check is a set test, not a parse. **Thread replay rebuilds history from rows passing the filter under the *current* context**; a thread with any failing message is omitted whole and 404s, because a transcript with holes produces nonsense and a partial replay is what leaks | `VisibilityFilter.filterQueryRows`; `AiThreadService` re-filters before every provider call |
| **L26** | **Free-text documentation** | a human writes "joins to the payroll table" in an entity's TipTap doc, and the doc ships to someone who cannot see `payroll` | structured `mention` nodes are redacted (`redactRichText`); **free prose is irreducible** and is stated rather than pretended away, in the same class as L21. Mitigated at authoring time: the docs editor warns when an @-mention targets an object some project collaborators cannot see, which is where the sensitive references actually come from. A masked or stub object's `doc` is `null` outright | `redactRichText` + authoring-time warning |
| **L27** | **Engine diagnostics stream** | diagnostics are computed once per project, cached, and broadcast to every socket in the project room — so `"salary (numeric) is not compatible with employees.id"`, or a quick-fix labelled `Rename to employee_salary`, reaches a subject who cannot see either object. A rendered string is unredactable after the fact | **nothing is rendered before it is cached.** The cache holds doc 03 §2.4's structured form only — `{ code, params, target }`, which is subject-independent and therefore legitimately shared — and `renderDiagnostic(messages, bundle, diagnostic, resolveRef)` runs **per recipient** on the way out. `VisibilityFilter` drops every diagnostic whose `target` that subject cannot see and rewrites the `params` of the survivors; core supplies `resolveRef`, which returns `null` for a ref the subject may not see and renders as the core term for a restricted object. Quick fixes carry the same treatment, because a fix label carries a name | `renderDiagnostic` is the only renderer and takes `resolveRef`; `VisibilityFilter.filterDiagnostics` runs before it; the diagnostics cache stores structured rows only |

**R21′ — the no-partial-view rule.** Operations that regenerate or overwrite the whole project
require an **unredacted** view: `ctx.visibleEntityIds.size === ctx.totalEntityCount` **and**
`ctx.entitiesWithRestrictedFields ⊆ ctx.restrictedOkEntityIds` **and** the relevant atom. They
are: **DDL import, snapshot restore, and migration-script generation.** Anything less returns
`403 requires_full_project_access` (this message may be explicit — it discloses only that your
view is partial, which you already know). Without this rule, a freelancer generating a migration
from a Billing-only view produces a script that drops every table they cannot see.

**Autolayout is not on that list.** An earlier draft included it, and the stated rationale — "a
migration generated from a partial view drops tables you cannot see" — simply does not apply to
an operation that writes `position` values. The cost was concrete: the Billing-only freelancer of
the spec's own workflow #2 could not auto-arrange their three tables, and the error they saw was
`403 requires_full_project_access`, which reads as a bug. **Autolayout requires `schema:edit` and
lays out `visibleEntityIds` only, leaving every other entity's `position` untouched.** Stubs
already carry their real coordinates, so the result stays coherent for everyone.

**R28 — restore never writes access-control attributes.** Snapshot restore requires `schema:edit`
+ R21′, which is one rung below `sharing:manage` — so without this rule a February snapshot
restored in April silently un-restricts a column a manager marked Restricted in March, bypassing
R20, and re-parents 40 entities without any of §7.11's move preview. Therefore: **`isRestricted`
and `Entity.areaId` are preserved from the live rows across a restore and are never taken from
the snapshot.** A restored field whose live row is gone defaults to `isRestricted = true`; a
restored entity whose live row is gone defaults to `areaId = null`. Both defaults are fail-closed.
The restore diff UI shows these two columns as "preserved, not restored" so nobody is surprised.

### 8.5 Exactly what survives — the three redacted shapes

All three are valid `SchemaModel` members: they satisfy `IrBase` and pass doc 04's zod schema.

```jsonc
// entity stub — everything the canvas needs to draw a faded connected box, and nothing else
{
  "id": "ent_prod",                 // REAL: links must point somewhere, and "Request access
                                    //   to this table" (§7.13) needs a target
  "name": "",                       // the UI supplies the label "Restricted"
  "version": 0,                     // constant: a real version is an edit-activity signal
  "doc": null,
  "engineProps": {},                // unlogged, partitionBy, viewDefinition all leak
  "namespaceId": "ns_public",       // REAL: so it lands in the right visual group
  "kind": "table",                  // REAL: shape only, says nothing about content
  "areaId": null,                   // a stub never keeps an area alive (§8.3)
  "position": { "x": 1240, "y": 380 },   // REAL: the diagram must not reflow per viewer
  "restricted": true
}

// masked field (mask mode only) — the slot, and nothing that describes it
{
  "id": "fld_sal",                  // REAL
  "name": "",                       // NOT the real name — see §7.10, "Why a masked field
                                    //   discloses no name"
  "version": 0,
  "doc": null,
  "engineProps": {},
  "entityId": "ent_emp",            // REAL
  "parentFieldId": null,            // REAL: the tree must stay walkable (R24)
  "ordinal": 2,                     // REAL in mask mode; the slot is the disclosure
  "type": { "name": "", "display": "" },   // constant
  "isNullable": true,               // constant
  "isRestricted": true,
  "isPii": false,                   // constant: the real flag is a classification signal
  "isDeprecated": false,            // constant
  "restricted": true
}

// index or constraint that survives only to render a badge
{
  "id": "cst_emp_pk", "name": "", "version": 0, "doc": null, "engineProps": {},
  "entityId": "ent_emp", "kind": "primaryKey", "fieldIds": ["fld_emp_id"],
  "restricted": true
}
```

No real name, no type, no counts, no area, no namespace on a field, no docs, no comment count, no
`createdAt`. The UI renders the entity stub as a faded box labelled **Restricted** with the
standard lock glyph, per SPEC §5, and the masked field as a greyed row labelled **Restricted**.

### 8.6 The single-path rule

SPEC §10 requires that `VisibilityFilter` is the only path for schema data leaving the server.

**The mechanism an earlier draft proposed did not work.** It declared
`class RawSchemaIR { constructor(readonly ir: SchemaIR) {} }` — a *public* field. The mistake it
claimed to catch, "a handler that forgot to redact and returned the loader's output directly", is
realistically written `const { ir } = await loader.load(id); return ir;`, and that value is a
plain `SchemaModel` with no class identity and no brand. It sails past an `instanceof` check and
ships the entire unredacted schema. The branded return type only helps when the handler declares
one. So the thing the document called "enforced by the type system, not by discipline" was
enforced by discipline.

**The fix is to make the payload genuinely unreachable, which is why `redact` lives in
`schema-model` next to it (§8.1).** Same module, hash-private field, no accessor, no lint rule:

```ts
// packages/schema-model/src/redact.ts — ONE module holds the box and the only key
export class RawSchemaModel {
  readonly #model: SchemaModel;          // truly private: no accessor exists anywhere
  constructor(model: SchemaModel) { this.#model = model; }

  /** Any accidental serialization fails loudly instead of leaking. */
  toJSON(): never { throw new Error('raw_ir_escaped'); }

  /** Module-private. Not exported from the package's index; `redact` below is its only caller. */
  static [UNWRAP](raw: RawSchemaModel): SchemaModel { return raw.#model; }
}

export function redact(raw: RawSchemaModel, ctx: VisibilityContext): RedactedModel {
  const model = RawSchemaModel[UNWRAP](raw);
  /* …§8.3… */
  return { ...out, redacted: true } as RedactedModel;   // the only cast in the codebase
}
```

There is no `.ir`, no getter and no exported unwrap, so `return raw.ir` does not compile and
`JSON.stringify(raw)` throws. The remaining hole is a deliberate `as unknown as RedactedModel`,
which the backstop catches:

```ts
// apps/api — one check per response
export function assertRedacted(v: unknown): void {
  if (v instanceof RawSchemaModel) throw new InternalServerErrorException('raw_ir_escaped');
  if (isSchemaModelShaped(v) && (v as SchemaModel).redacted !== true)
    throw new InternalServerErrorException('unredacted_model');     // doc 04's runtime flag
  if (Array.isArray(v)) { for (const x of v) assertRedacted(x); return; }
  if (v && typeof v === 'object' && 'data' in v) assertRedacted((v as any).data);
}

const isSchemaModelShaped = (v: unknown) =>
  !!v && typeof v === 'object' && 'irVersion' in v && 'objects' in v;
```

`NoRawIrInterceptor` applies `assertRedacted` to every HTTP response. **Nest interceptors do not
cover the other two exits**, so each calls it directly — an earlier draft claimed the interceptor
covered them, which is not true of Nest:

```ts
// RealtimeGateway.emitToProject — before socket.emit
assertRedacted(payload);
// ExportProcessor.process — before writing the artefact to S3
assertRedacted(redactedModel);
```

Deliberately **not** done: a deep recursive walk of every response (cost on a 300-entity payload
for a case the shape check already covers), and a lint rule banning repository imports in
controllers. *Skipped: the lint rule — add it the first time a review finds an
`as unknown as RedactedModel`.*

---

## 9. Caching and invalidation

### 9.1 What is cached

| Key | Value | TTL | Scope |
|---|---|---|---|
| `${REDIS_KEY_PREFIX}cache:perm:3:{projectId}:{subjectKey}:{og}.{pg}.{sg}` | `ProjectPermissionMap` as JSON | `min(PERM_TTL_MS, validUntil − now)`, capped at **300 s** | per subject per project |
| `${REDIS_KEY_PREFIX}cache:skel:3:{projectId}:{pg}` | `ProjectSkeleton` | **600 s** | shared across all subjects |
| `${REDIS_KEY_PREFIX}cache:orgmem:3:{orgId}:{userId}:{og}.{sg}` | `{ role, groupIds }` | **300 s** | per user per org |

`REDIS_KEY_PREFIX` is doc 01 §4.4's mandatory prefix on all three Redis clients — the
test-isolation backstop — and `cache:` is the client namespace these three keys live in. Neither
is optional, and neither varies per key; the shapes are written unprefixed everywhere below for
readability. `subjectKey` is `u:{userId}` or `sl:{shareLinkId}`. The `3` is a schema version for the cached
shape — bumping it invalidates every entry on deploy, which is what you want when the map's shape
changes (and this revision changed it: `entityOverrides` replaced `entityAtoms`).

**The three generation values are read from Postgres on every resolve, in one round trip:**

```sql
SELECT (SELECT perm_generation FROM projects      WHERE id = $1) AS pg,
       (SELECT perm_generation FROM organizations WHERE id = $2) AS og,
       COALESCE((SELECT perm_generation FROM users WHERE id = $3), 0) AS sg;
--  $3 is NULL for a share_link subject, so sg = 0. That is safe: a share link has no
--  user-scoped state, and every share-link write bumps the project counter instead.
```

**There is no Redis mirror of the counters, and that is a deliberate deletion.** An earlier draft
mirrored them with a 10 s TTL and wrote back any miss from Postgres. That write-back races the
revoke `DEL` on *every* revoke under concurrent load, not just in the "Redis unreachable" case
§9.4 was bounding:

> Request A misses `gen:proj` and reads `42` from Postgres. The revoke transaction commits `43`
> and issues `DEL gen:proj`, which is a no-op because the key is already absent. A then writes
> `SETEX gen:proj 42` with a 10 s TTL. For the next ten seconds every request in every process
> reads `42`, builds the **pre-revoke** cache key, and hits the still-present pre-revoke map.
> **The revoked grant keeps working** — which is precisely the revoked-grant-resurrection failure
> §9.2 says the Postgres-resident counter exists to prevent, and it falsifies the §9.4 headline.

The fix is the one §9.4 already concedes is affordable: read the authoritative counters every
time. It is one indexed round trip returning three integers, amortised across every user of the
project, and it makes the staleness bound genuinely "the next request" instead of "the next
request, unless you lost a race". The alternative — a compare-and-set Lua script plus a re-read
after computing the map — is more moving parts for a saving nobody has measured.
*Skipped: the mirror. Add it back only when a flame graph shows the counter read, and then only
with CAS semantics.*

**The map's own freshness is re-checked on every cache read:**

```ts
const cached = await redis.get(key);
if (cached) {
  const map = deserialize(cached);
  if (map.validUntil > Date.now()) return map;    // §7.12: a link expiring in 30 s
  await redis.del(key);                           //   must not leave a 300 s map live
}
```

`validUntil` is `min(now + PERM_TTL_MS, nextExpiryOf(grants))` where `nextExpiryOf` reads both
`access_grants.expires_at` and `share_links.expires_at` (§7.5). The Redis TTL is
`min(PERM_TTL_MS, validUntil − now)` — normative, not "capped by `validUntil`" in prose.

### 9.2 Generation counters live in Postgres

This is the important decision. Counters are **`Int` columns on `Organization`, `Project` and
`User`, incremented inside the same transaction as the change.**

Why not `INCR` in Redis:
- a lost `INCR` (Redis restart, failover, network blip after the DB commit) leaves the old
  generation live, so a revoked grant keeps working until the 300 s map TTL;
- worse, an **evicted or reset** counter goes back to `0`, and stale maps cached under `…:0.0.0`
  become reachable again — a revoked grant resurrecting itself is the worst failure mode this
  system can have.

With Postgres as the source of truth, the counter cannot be lost, cannot go backwards, and is
bumped atomically with the change. Redis holds only derived values keyed *by* it.

### 9.3 Invalidation triggers

The write path is always: **mutate + audit row + `permGeneration++` in one transaction → commit →
`DEL` the dependent cache keys → respond.**

| Trigger | Bump |
|---|---|
| Grant created / role changed / modifiers changed / expiry changed / deleted | `Project.permGeneration` |
| **A group's grant created, changed or deleted** | **`Project.permGeneration`** (that grant's project) |
| Custom role's atoms edited, or a custom role deleted | `Organization.permGeneration` |
| Group **created or deleted** | `Organization.permGeneration` |
| Group membership added / removed (one user) | that `User.permGeneration` |
| Group membership bulk change (> 20 users) | `Organization.permGeneration` (cheaper than 200 row updates) |
| Org role changed for a user | that `User.permGeneration` |
| User removed from / added to an org | that `User.permGeneration` |
| Entity created, deleted, or moved between areas | `Project.permGeneration` |
| Area created or deleted | `Project.permGeneration` |
| `field.isRestricted` toggled | `Project.permGeneration` |
| `project.restrictedFieldMode` changed | `Project.permGeneration` |
| Share link created / revoked / expiry or password changed | `Project.permGeneration` |
| Access request approved | `Project.permGeneration` (it is a grant write) |
| Project soft-deleted / restored | `Project.permGeneration` |
| Org soft-deleted | `Organization.permGeneration` |
| Invitation accepted (R11) | that `User.permGeneration` |

**A group's *grant* change bumps the project, not the org.** An earlier draft sent it to
`Organization.permGeneration`. Group creation and deletion genuinely are org-wide, but a group's
grant row carries a `projectId` — and adding "Analysts" as viewer on one project is the single
most frequent sharing operation the spec describes. Bumping the org counter for it invalidates
every permission map **and** every org-membership entry for every user in the org: on a 200-user
org with 50 projects, one project-scoped change forces a cold start of one grants query plus one
skeleton per user per open project. It is an ordinary grant write and belongs in the first row.

**Nothing else bumps anything.** Canvas positions, entity/field renames, type changes, docs,
comments, snapshots and imports-in-progress do **not** touch `permGeneration`. The only schema
writes that do are the three that change what the skeleton says: entity create/delete, entity
`areaId`, and area create/delete — plus `isRestricted`, which changes field visibility.

**R29 — a bulk operation bumps exactly once.** A 300-table DDL import, a snapshot restore, or any
multi-object transaction bumps `permGeneration` **once, at the end of its transaction**, and
emits **one** `permissions:changed`. Bumping per object would produce 300 generation rolls, 300
skeleton rebuilds, 300 broadcasts and 300 map recomputes for what is one logical change. This is
also what keeps the single hot-row counter cheap: the row is updated a handful of times a minute
by ordinary editing, not once per keystroke, so the row lock is never a contention point in
practice. *Splitting the counter in two — one for grants, one for the skeleton — was considered
and rejected: it doubles the cache-key algebra to remove contention nobody has measured on a
schema designer's write rate.*

`skel:` is keyed by `pg` alone, so every project-generation bump also rolls the skeleton — which
is correct, since entity/area/restricted-field changes are exactly what the skeleton holds, and
nothing else bumps `pg`.

Realtime sockets additionally receive a `permissions:changed { projectId }` broadcast on a
project bump; each connected socket drops its cached `VisibilityContext` and re-computes on the
next event. Without this, a long-lived socket would keep emitting under a stale context.

### 9.4 The staleness bound

> **A revoked grant stops working for every request whose resolve begins after the transaction
> commits. There is no window.**

The chain: the transaction commits the new counter → the next resolve reads the authoritative
counter from Postgres (§9.1, no mirror) → computes a new cache key → misses the map → re-runs the
hot query → sees the grant is gone. The 300 s map TTL is **memory reclamation, never
correctness**: a stale map is unreachable the moment the generation moves, because the generation
is part of the key.

The cost is one indexed three-integer read per resolve, and resolves are themselves cached per
subject per generation. That is the cheapest correctness this design buys, and it is the reason
the mirror is gone.

### 9.5 Stampede, and what is never cached

**Stampede:** no distributed lock. A cold key costs one small query plus a pure function, about
5 ms; a thundering herd of 50 costs 50 of those. What *is* worth having is **per-process
in-flight deduplication**, because the real herd is one request resolving the same key many
times:

```ts
private readonly inFlight = new Map<string, Promise<ProjectPermissionMap>>();

private single(key: string, fn: () => Promise<ProjectPermissionMap>) {
  const existing = this.inFlight.get(key);
  if (existing) return existing;
  const p = fn().finally(() => this.inFlight.delete(key));
  this.inFlight.set(key, p);
  return p;
}
```

*Skipped: a Redis single-flight lock — add it when a flame graph shows resolve cost, not before.*

On top of that, a **request-scoped memo**: `PermissionGuard` and `VisibilityFilter` share one
`ProjectPermissionMap` per `(request, projectId)` via a `REQUEST`-scoped provider. 300
`@RequirePermission` checks in one request hit Redis once.

**Never cached, under any key:**

1. **The redacted model, or any redacted payload.** It is cheap to recompute and a mis-keyed
   content cache is precisely how a salary column leaks (L24). If profiling ever demands it, the
   key must include `subjectKey` *and* the full generation triple, and that decision needs its
   own review.
2. **Raw schema rows outside the request.** The skeleton is cached; entity/field *content* is not.
3. **Share-link tokens, their hashes, or password-verification outcomes.** Only the minted,
   signed, short-lived session cookie, which carries no secret material.
4. **Authentication state** (sessions, refresh tokens, 2FA). Different lifecycle, different
   module, must be revocable instantly; it does not ride the permission generation.
5. **Anything in the browser, a CDN or a proxy.** `Cache-Control: private, no-store` +
   `Vary: Cookie` on every `/projects/**`, `/entities/**`, `/ai/**`, `/exports/**` response.
6. **Cross-org anything.** Every key is prefixed with a project or org id; there is no global key.

---

## 10. Enforcement plumbing

### 10.1 `@RequirePermission` and `@RequirePermissionAll`

```ts
export type ResourceLocator =
  | { project: string }   // { project: 'projectId' } or { project: 'body.projectId' }
  | { area:    string }
  | { entity:  string };
// the string names a route param by default; prefix 'body.' or 'query.' to look elsewhere.

export const RequirePermission = (atom: PermissionAtom, where: ResourceLocator) =>
  applyDecorators(SetMetadata(PERM_META, { atom, wheres: [where] }), UseGuards(PermissionGuard));

/** R19's "both endpoints" case. ALL locators must hold the atom; any miss fails the request. */
export const RequirePermissionAll = (atom: PermissionAtom, wheres: ResourceLocator[]) =>
  applyDecorators(SetMetadata(PERM_META, { atom, wheres }), UseGuards(PermissionGuard));
```

```ts
@Patch('entities/:id')
@RequirePermission('schema:edit', { entity: 'id' })
update(@Param('id') id: string, @Body() dto: UpdateEntityDto) { … }

@Post('projects/:projectId/areas')
@RequirePermission('schema:edit', { project: 'projectId' })
createArea(…) { … }

@Post('links')
@RequirePermissionAll('schema:edit', [
  { entity: 'body.from.entityId' },
  { entity: 'body.to.entityId' },
])                                  // R19: both endpoints, doc 04's from/to naming
createLink(…) { … }
```

Extraction walks the **whole** dotted path. An earlier draft used `spec.split('.', 2)`, which
silently truncates anything deeper than one segment — so `body.from.entityId`, the natural
locator for doc 04's link shape, resolved to `req.body.from` and threw `missing_resource_id`:

```ts
function extract(req: Request, where: ResourceLocator): ResourceRef {
  const [type, spec] = Object.entries(where)[0] as [ResourceRef['type'], string];
  const path = spec.includes('.') ? spec.split('.') : ['params', spec];
  const id = path.reduce<any>((acc, key) => acc?.[key], req);
  if (typeof id !== 'string' || !id) throw new BadRequestException({ code: 'missing_resource_id' });
  return { type, id };
}
```

### 10.2 `@RequireProjectAccess` and `@RequireOrgRole`

```ts
@Get('projects/:projectId/ir')
@RequireProjectAccess('projectId')          // canOpenProject (§7.9); the response is redacted
getIr(…) { … }

@Post('organizations/:orgId/groups')
@RequireOrgRole('orgId', ['owner', 'admin'])
createGroup(…) { … }
```

Four decorators total, counting `@RequirePermissionAll`. They read differently at the call site,
which is the point: a reviewer can see whether a route is atom-gated, view-gated or org-gated
without opening the guard.

### 10.3 `PermissionGuard` flow

1. **Fail closed, and classify everything.** A route under `/api/**` with no
   `@RequirePermission`, `@RequirePermissionAll`, `@RequireProjectAccess`, `@RequireOrgRole` or
   explicit `@Public()` is **denied**, and a boot-time reflection sweep over the route table
   throws on startup if any route is unannotated. The same sweep asserts every route is
   classified as share-link-reachable or not against `SHARE_LINK_ROUTES` (R21), so a new surface
   cannot silently become a public-link leak. An unguarded or unclassified route is a deploy
   failure, not a runtime surprise. **This is on from the first Phase 1 commit.**
2. **Build the subject** from `req.user` (JWT cookie) or the `sl_session` cookie. Both present →
   the user wins. Neither → `401`.
3. **Extract every `ResourceRef`** (§10.1).
4. **Find the project id** for the refs: from the request-scoped `ResourceIndex` (built from the
   skeleton, so an entity→project lookup costs no query), falling back to a single indexed
   `SELECT project_id` for a cold id. Unknown id → `404`. Refs spanning two projects → `400`.
5. **Share-link checks:** `session.pid === projectId` (§7.12 step 4), and the route is in
   `SHARE_LINK_ROUTES` — otherwise `404`.
6. `map = await resolver.resolveProject(subject, projectId)` — request-memoised;
   `skel = await resolver.skeleton(projectId)`.
7. **Decide:** every ref must satisfy `resolver.atomsAt(map, skel, ref).has(atom)`. Because
   step 4b of the resolver has already unioned `sharing:manage` downward (R5), this plain lookup
   is the correct decision for that atom too — no special case.
8. **Deny shape.** If the subject cannot `schema:view` the resource → **`404`**, identical body
   and shape to a genuinely missing resource. If they can see it but lack the atom → **`403`**
   with `{ code, atom, resource }`. This single rule is what stops the API from being an
   existence oracle, and it is asserted by a property test (P8).
9. **Attach** `map`, `skel` and the derived `VisibilityContext` to the request for the handler and
   the response interceptor.

### 10.4 Bulk, list, and the N+1 problem

**Guards never loop.** That is the whole design.

- **List / read endpoints** (`GET /projects/:id/ir` with 300 entities): the guard checks
  `canOpenProject` only. All 300 per-entity decisions come out of one `ProjectPermissionMap` plus
  the cached skeleton — **one org-membership lookup, one generation read, one grants query, one
  cached skeleton**, then pure set operations. There is no N+1 because there is no N calls: the
  resolver's unit of work is a *project*, not a *resource*.
- **Bulk writes** (`POST /entities/bulk-delete { ids: [...] }`): the guard validates the project
  ref; the service calls

  ```ts
  resolver.assertAll(map, skel, ids.map(id => ({ type: 'entity', id })), 'schema:edit');
  ```

  which is N set lookups against the already-resolved map. **All-or-nothing:** if any ref is
  denied the whole request fails (`403`, or `404` if any ref is invisible), inside a transaction,
  so there is no partial-success oracle.
- **Cross-project bulk** is not supported. A bulk endpoint takes ids from exactly one project,
  validated against the map's `projectId`.
- **`GET /projects`** (the sidebar): one query over `access_grants` by principal set
  (`@@index([principalType, principalId])`) plus the org-role short-circuit for owners/admins,
  returning candidate project ids; then one resolve per *candidate project* — typically 3–20, and
  each is a cache hit after the first load. `canOpenProject` reads off the map with no skeleton
  (§7.5), so the listing does not pay for 20 skeletons. §7.11's entity-grant cleanup is what
  keeps the candidate list honest.

### 10.5 Audit logging

- **Written by services, inside the transaction**, never by an interceptor. An interceptor cannot
  join the transaction and would happily log a change that rolled back. See §7.14 for the shape.
- **Audited actions:** every write to `AccessGrant`, `Role`, `UserGroup`, `GroupMember`,
  `OrgMember`, `ShareLink`, `AccessRequest`; `field.isRestricted` toggles;
  `project.restrictedFieldMode` changes; `entity.area_changed`; area deletion and entity deletion
  (with the before-image of every grant removed with them); invitation acceptance and its merge
  reviews (R11a); share-link **unlock** (successful password entry, with IP); export job
  completion (what was exported, by whom, under which generation).
- **Restricted-field reads under the org-admin override (R13)** write one audit row per request
  that actually returned restricted field content, flagged `admin_override: true`. One row per
  request, not per field.
- **Denials** are *not* written to `audit_log` (volume, and it is attacker-controlled). They go to
  pino at `warn` with `{ requestId, subjectKey, projectId, ref, atom, outcome }`, and a Redis
  counter raises an alert on a burst from one subject (an enumeration attempt). The
  data-integrity warnings of §7.15 use the same channel with their own counters.
- `audit_log` is append-only: no `UPDATE` or `DELETE` grant for the application's database role,
  enforced at the Postgres role level, not in application code.

---

## 11. Testing

SPEC §10 asks for "a full permission matrix" for `PermissionResolver`. Here is what that means
concretely.

### 11.1 The golden matrix

A hand-written case per combination is
`5 roles × 4 org roles × 6 principal configurations × 2 modifier flags × 3 grant levels ×
2 restricted-field modes × 2 subject kinds × 9 atoms = 25,920` cases — unmaintainable, and
nobody reads it. Instead:

- **One fixture world** — the §7.6 fixture, built in memory. The resolver is pure given its
  inputs, so the tests feed `(org role, group memberships, live grants, skeleton, mode, now)`
  directly; no database.
- **12 subjects:** org owner, org admin, org member with no grant, guest with no grant, project
  viewer, project editor + AI, project manager, area editor (the freelancer), entity viewer,
  project editor **+** entity viewer (E1), project manager **+** group entity viewer (E5), share
  link (viewer, on the project).
- **8 resources:** the project, both areas, all five entities.
- **11 predicates per cell:** the 9 atoms, plus `canOpenProject` and `fieldVisibility(fld_sal)`.
- That is `12 × 8 × 11 = 1,056` assertions, generated by a loop and **snapshotted to a committed
  CSV** (`test/fixtures/permission-matrix.csv`). Any resolver change surfaces as a reviewable
  diff in that file. A diff with no corresponding intentional change fails review, not just CI.
- Run once per `restrictedFieldMode` → **2,112 rows**.

The CSV is committed and reviewed as a diff. *Skipped: rendering it into the docs site — a
2,112-row table is a test artefact, not documentation, and nobody reads it there either.*

### 11.2 Hand-written cases

Every row of §7.6 (E1–E15) becomes a named test, verbatim, with the table's "Rule" column as the
test description. These are the cases a future reader will argue about; they get names, not a row
in a CSV. E12 gets **both** directions: delete succeeds (R4a), in-place widening returns
`403 escalation` with `remedy: 'delete_narrowing_grant'`.

Plus the enforcement cases:

- 404-vs-403 shape (§10.3 step 8) and the identical-body assertion.
- Share-link cross-project rejection; a share-link request to a route outside `SHARE_LINK_ROUTES`
  returns 404 (R21).
- Attenuation (R4) and delete-without-attenuation (R4a).
- Ancestor `sharing:manage` (R5, E12) and area `sharing:manage` not reaching upward (R6, E13).
- R21′ on import, restore and migration generation — and **autolayout succeeding** for the
  area-only freelancer, laying out only their three entities.
- R28: restore does not clear `isRestricted` and does not change `areaId`.
- R19 delete cases: the Billing-only editor cannot delete the Billing **area** (authorised at the
  project), and cannot delete a **link** whose far endpoint is a stub (`403
  link_endpoint_not_permitted`, not 404).
- R11a both branches: two built-ins collapse to the higher role; a custom role on either side
  keeps the existing grant and writes a review row. Plus: an invitee who was not an org member
  becomes one **before** the grant is converted, and resolves to real access on the next request.
- R25: deleting a share link's grant is not reachable from the access dialog; revoking the link
  removes both rows.
- L25: a saved query touching a hidden entity is absent from the library listing and 404s on
  read; an AI thread whose first message touched a now-hidden field is absent whole.

### 11.3 Property-based invariants (fast-check)

| # | Invariant | Why it matters |
|---|---|---|
| **P1** | A subject with **no live grants and org role `guest`** yields an empty visible set and `canOpenProject = false`, for every generated world. | The base case of the whole system. |
| **P2** | `redact(new RawSchemaModel(redact(m, ctx)), ctx)` deep-equals `redact(m, ctx)` (G3). | Stub handling is the easiest place to write a non-idempotent transform, and non-idempotence usually means a stub is being treated as real. |
| **P3** | `redact` alters a surviving object **only** as the §8.3 table says: the test compares against an oracle derived from that table, per object kind, not against the raw object (G4). | Catches over-eager redaction, which is a silent data-loss bug on export — while still allowing the name-drop on a stub-touching link and the `engineProps` blanking of R27. |
| **P4** | **The soundness test.** For every generated world and subject: no `name`, `doc.plainText`, `TypeRef.display`, `engineProps` string value or `IndexColumn.expression` of a redacted object appears as a substring of `JSON.stringify(redact(…))`. Names are generated as distinctive tokens (`zzq-<n>`) so substring matching has no false positives. | This single test covers L1–L6 and most of L22 mechanically, and it keeps covering them when someone adds a new IR field. |
| **P5** | **Monotone in principals.** Adding a principal to a subject never removes an atom at any resource. | The invariant R16 exists to provide. Its violation is the "my group grant demoted me" bug. |
| **P6** | **Locality.** Adding or removing a grant at resource `X` changes the result only at `X` and its descendants. | Catches accidental global state in the cascade. |
| **P7** | **Ceilings hold.** For every generated grant configuration, a `share_link` subject's atoms at every resource are a subset of `{ schema:view }`, and a guest never holds `sharing:manage`. | R17 is the last line of defence against a mis-configured link. |
| **P8** | **No existence oracle.** For every (subject, resource) where the subject lacks `schema:view`, the guard's response status is `404` and its body is byte-identical to the body for a random non-existent id of the same type. | §10.3 step 8. Holds unqualified because core passes no `restrictedProbe` (L13). |
| **P9** | **Dense sibling ordinals, and no dangling parent.** In `hide` mode, every surviving field's ordinals are exactly `0…n-1` **within each `(entityId, parentFieldId)` group**, and every surviving `parentFieldId` resolves to a field that is also present. | L22 + R24. Renumbering across a whole entity instead of per sibling group corrupts every nested field. |
| **P10** | **Cache coherence** (model-based): for any sequence of mutations each followed by its documented invalidation, `resolve` with the cache enabled equals `resolve` with the cache bypassed. | The §9.3 table is the part most likely to go stale as features land, and three of this revision's fixes were in it. |
| **P11** | **Attenuation is closed:** no sequence of grant writes performed by a non-admin subject can produce, for any subject, an atom the writer did not hold at that resource. Runs against the **real service with the §7.14 lock**, interleaved, not against a simulated resolver. | R4 + R26. A pure-function property test would pass while the service raced. |
| **P12** | **The R5 downward union never widens visibility.** For every generated world, the set of entities with `schema:view` is identical with and without step 4b. | The Lemma in §4.2. If this ever fails, `sharing:manage` has become a read grant. |
| **P13** | **The two directions agree.** For every world, subject and resource, `resolveResource(ref).get(subjectKey)` equals `atomsAt(resolveProject(subject), ref)`. | §7.7. Two implementations of one rule set is exactly how they drift. |

### 11.4 Integration and e2e

- Two Playwright e2e specs mirroring §12: the freelancer (cannot see Catalog, sees a masked
  `salary` with no name, gets 403 on edit, 403 on AI, **succeeds** at autolayout) and the
  share-link guest (sees stubs, no comments, no presence; revoking the link mid-session kills the
  next request).
- One integration test per side-channel a unit test cannot reach: export output, SSE AI context
  (assert the hidden name is absent from the prompt bytes actually sent to the provider — with a
  stubbed `AiProvider` that records its input), socket emission, search SQL, notification
  rendering, and the saved-query library after a narrowing grant (L25).

---

## 12. Worked traces

### 12.1 Workflow #2 — the freelancer with Billing-only Editor access

**Setup.** Dana is an org `guest` in `org_acme`. One grant:
`{ resourceType: 'area', resourceId: 'ar_bill', principalType: 'user', principalId: 'usr_dana',
roleId: role_editor, canUseAi: false, canViewRestricted: false, expiresAt: null }`.
`prj_shop.restrictedFieldMode = 'mask'`. Dana is in no groups. Fixture as in §7.6.

**Request:** `GET /api/projects/prj_shop/ir`, annotated `@RequireProjectAccess('projectId')`.

| Step | Input | State / output |
|---|---|---|
| 1 | cookies | `Subject { kind: 'user', userId: 'usr_dana', orgId: 'org_acme' }` |
| 2 | guard reads metadata | mode = project-access, ref = `{ project: 'prj_shop' }` |
| 3 | generation read (one round trip) | `pg = 42, og = 11, sg = 4` |
| 4 | `orgmem:3:org_acme:usr_dana:11.4` | HIT → `{ role: 'guest', groupIds: [] }`. Not owner/admin → no short-circuit |
| 5 | `GET perm:3:prj_shop:u:usr_dana:11.42.4` | **MISS** → run the resolver |
| 6 | `skel:3:prj_shop:42` | HIT → areas `[ar_bill, ar_cat]`; entities `[inv→bill, pay→bill, emp→bill, prod→cat, aud→null]`; `entitiesWithRestrictedFields = {ent_emp}` |
| 7 | hot query, principals `['user:usr_dana']` | 1 row: area `ar_bill`, `editor`, both modifiers false, no expiry, no link expiry |
| 8 | per-principal cascade, `p = user:usr_dana` | `pProject = ∅`. `pArea[ar_bill] = {schema:view, export:run, comment:create, docs:edit, schema:edit, history:view}`; `pArea[ar_cat] = pProject = ∅`. `pEntity`: `inv/pay/emp → pArea[ar_bill]`; `prod → ∅`; `aud → pProject = ∅` (no area, §7.11) |
| 8b | step 4b (R5) | `sharing:manage` held nowhere → no union |
| 9 | union across principals (only one) | unchanged |
| 10 | ceiling: guest | subtract `sharing:manage` — already absent |
| 11 | overrides | every entity equals what it inherits → `entityOverrides = {}`. Derived: `visibleEntityIds = {ent_inv, ent_pay, ent_emp}`, `restrictedOkEntityIds = ∅`, `projectAtoms = ∅`, `canOpenProject = true` (an area set is non-empty) |
| 12 | `SETEX perm:… 300` | `validUntil = now + 300 s` (no grant or link expiry to cap it), so the TTL is the full 300 s |
| 13 | guard decision | `canOpenProject === true` → **pass**. Note `projectAtoms.has('schema:view')` is `false` — this is exactly the case §7.9 exists for |
| 14 | `SchemaLoader.load('prj_shop')` | a `RawSchemaModel` — 5 entities, 10 fields, 3 links, 1 index, 2 constraints |
| 15 | `redact(raw, ctx)` | below |
| 16 | response | `Cache-Control: private, no-store`, `Vary: Cookie`; `assertRedacted` passes (`redacted === true`) |

**The redacted `SchemaModel` Dana receives** — doc 04's shape exactly, no elisions:

```jsonc
{
  "irVersion": 1,
  "projectId": "prj_shop",
  "engineId": "postgresql",
  "engineVersion": "16",
  "redacted": true,
  "objects": {
    "area": {
      "ar_bill": { "id": "ar_bill", "name": "Billing", "version": 3, "doc": null,
                   "color": "indigo", "rect": { "x": 80, "y": 60, "width": 900, "height": 620 } }
      // ar_cat: dropped — no visible entity and Dana holds nothing there (§8.3 area rule)
    },
    "namespace": {
      "ns_public": { "id": "ns_public", "name": "public", "version": 1, "doc": null,
                     "engineProps": {} }
    },
    "customType": {},
    "entity": {
      "ent_inv": { "id": "ent_inv", "name": "invoices", "version": 7,
                   "doc": { "id": "doc_inv", "plainText": "One row per issued invoice." },
                   "engineProps": {}, "namespaceId": "ns_public", "kind": "table",
                   "areaId": "ar_bill", "position": { "x": 160, "y": 140 } },
      "ent_pay": { "id": "ent_pay", "name": "payments", "version": 4, "doc": null,
                   "engineProps": {}, "namespaceId": "ns_public", "kind": "table",
                   "areaId": "ar_bill", "position": { "x": 520, "y": 140 } },
      "ent_emp": { "id": "ent_emp", "name": "employees", "version": 11,
                   "doc": { "id": "doc_emp", "plainText": "Staff records." },
                   "engineProps": {}, "namespaceId": "ns_public", "kind": "table",
                   "areaId": "ar_bill", "position": { "x": 160, "y": 440 } },
      "ent_prod": { "id": "ent_prod", "name": "", "version": 0, "doc": null, "engineProps": {},
                    "namespaceId": "ns_public", "kind": "table", "areaId": null,
                    "position": { "x": 1240, "y": 380 },
                    "restricted": true }
      // ent_aud: absent entirely — invisible and nothing surviving references it
    },
    "field": {
      "fld_inv_id":  { "id": "fld_inv_id", "name": "id", "version": 1, "doc": null,
                       "engineProps": {}, "entityId": "ent_inv", "parentFieldId": null,
                       "ordinal": 0, "type": { "name": "uuid", "display": "uuid" },
                       "isNullable": false, "isRestricted": false, "isPii": false,
                       "isDeprecated": false },
      "fld_inv_emp": { "id": "fld_inv_emp", "name": "employee_id", "version": 1,
                       "doc": { "id": "doc_fie", "plainText": "Issuing employee." },
                       "engineProps": {}, "entityId": "ent_inv", "parentFieldId": null,
                       "ordinal": 1, "type": { "name": "uuid", "display": "uuid" },
                       "isNullable": true, "isRestricted": false, "isPii": false,
                       "isDeprecated": false },
      "fld_pay_id":  { "id": "fld_pay_id", "name": "id", "version": 1, "doc": null,
                       "engineProps": {}, "entityId": "ent_pay", "parentFieldId": null,
                       "ordinal": 0, "type": { "name": "uuid", "display": "uuid" },
                       "isNullable": false, "isRestricted": false, "isPii": false,
                       "isDeprecated": false },
      "fld_pay_inv": { "id": "fld_pay_inv", "name": "invoice_id", "version": 1, "doc": null,
                       "engineProps": {}, "entityId": "ent_pay", "parentFieldId": null,
                       "ordinal": 1, "type": { "name": "uuid", "display": "uuid" },
                       "isNullable": true, "isRestricted": false, "isPii": false,
                       "isDeprecated": false },
      "fld_emp_id":  { "id": "fld_emp_id", "name": "id", "version": 1, "doc": null,
                       "engineProps": {}, "entityId": "ent_emp", "parentFieldId": null,
                       "ordinal": 0, "type": { "name": "uuid", "display": "uuid" },
                       "isNullable": false, "isRestricted": false, "isPii": false,
                       "isDeprecated": false },
      "fld_emp_name":{ "id": "fld_emp_name", "name": "name", "version": 2,
                       "doc": { "id": "doc_fen", "plainText": "Display name." },
                       "engineProps": {}, "entityId": "ent_emp", "parentFieldId": null,
                       "ordinal": 1, "type": { "name": "text", "display": "text" },
                       "isNullable": false, "isRestricted": false, "isPii": true,
                       "isDeprecated": false },
      "fld_sal":     { "id": "fld_sal", "name": "", "version": 0, "doc": null,
                       "engineProps": {}, "entityId": "ent_emp", "parentFieldId": null,
                       "ordinal": 2, "type": { "name": "", "display": "" },
                       "isNullable": true, "isRestricted": true, "isPii": false,
                       "isDeprecated": false,
                       "restricted": true }
      // ent_prod's and ent_aud's fields: omitted — a stub entity has no fields
    },
    "constraint": {
      "cst_emp_pk":  { "id": "cst_emp_pk", "name": "employees_pkey", "version": 1, "doc": null,
                       "engineProps": {}, "entityId": "ent_emp", "kind": "primaryKey",
                       "fieldIds": ["fld_emp_id"] },
      "cst_sal_pos": { "id": "cst_sal_pos", "name": "", "version": 0, "doc": null,
                       "engineProps": {},            // held "salary > 0" — R27 / L4
                       "entityId": "ent_emp", "kind": "check", "fieldIds": ["fld_sal"],
                       "restricted": true }
    },
    "index": {
      // idx_emp_comp had exactly one column, an expression "(salary * 12)" whose refs name
      // fld_sal. R27 drops the expression column; no key column survives; the index is absent.
      // Note it references NO field id, which is why the earlier "drop any index referencing an
      // invisible fieldId" rule would have shipped it verbatim.
    },
    "link": {
      "lnk_pay_inv": { "id": "lnk_pay_inv", "name": "payments_invoice_id_fkey", "version": 1,
                       "doc": null, "engineProps": { "onDelete": "restrict" },
                       "kind": "foreignKey", "cardinality": "N:1",
                       "from": { "entityId": "ent_pay", "fieldIds": ["fld_pay_inv"] },
                       "to":   { "entityId": "ent_inv", "fieldIds": ["fld_inv_id"] } },
      "lnk_inv_emp": { "id": "lnk_inv_emp", "name": "invoices_employee_id_fkey", "version": 1,
                       "doc": null, "engineProps": { "onDelete": "setNull" },
                       "kind": "foreignKey", "cardinality": "N:1",
                       "from": { "entityId": "ent_inv", "fieldIds": ["fld_inv_emp"] },
                       "to":   { "entityId": "ent_emp", "fieldIds": ["fld_emp_id"] } },
      "lnk_prod_emp":{ "id": "lnk_prod_emp", "name": "", "version": 0, "doc": null,
                       "engineProps": {},            // held onDelete + the constraint name — L2
                       "kind": "foreignKey", "cardinality": "N:1",
                       "from": { "entityId": "ent_prod", "fieldIds": [] },
                       "to":   { "entityId": "ent_emp",  "fieldIds": [] },
                       "restricted": true }
      // BOTH endpoints lose their fieldIds, not just the hidden side: doc 04 pairs
      // from.fieldIds[i] with to.fieldIds[i] by index, so dropping one side alone would
      // break the equal-length invariant. Composite links follow the same rule.
    }
  }
}
```

**The response envelope** — `coverage` is *not* a key on `SchemaModel` (doc 04 has no such field),
so it rides beside it and is computed post-redaction (L8):

```jsonc
{
  "data": { /* the model above */ },
  "meta": {
    "coverage": { "documented": 4, "total": 9 }
    // total  = 3 surviving real entities + 6 non-masked fields.
    //          ent_prod (stub) and fld_sal (masked) are in neither numerator nor denominator.
    // documented = ent_inv, ent_emp, fld_inv_emp, fld_emp_name.
  }
}
```

**Follow-on requests in the same session** (all reuse the request-memoised map, then the cached
one):

| Request | Resolution | Result |
|---|---|---|
| `PATCH /api/fields/fld_sal` | guard: ref → entity `ent_emp` (via `ResourceIndex`), atom `schema:edit` → **held**. Service: `fieldVisibility = 'masked'` | **`403 restricted_field`** — the guard passes and the *field* rule denies. Existence is already disclosed by the mask, so 403 is honest |
| `POST /api/fields/fld_emp_name/move { beforeFieldId: 'fld_sal' }` | `schema:edit` at `ent_emp` → held; naming a masked field as the neighbour is allowed (§7.10) | **`200`** — the server recomputes ordinals over the true field list (R22) |
| `PATCH /api/entities/ent_prod` | `atomsAt(ent_prod) = ∅`, no `schema:view` | **`404`**, identical body to a nonexistent id (§10.3 step 8, P8) |
| `DELETE /api/links/lnk_prod_emp` | R19: `schema:edit` required at **both** endpoints; `ent_prod` is a stub | **`403 link_endpoint_not_permitted`** — and the UI never offered the button |
| `POST /api/ai/threads` selecting `ent_inv` | atom `ai:use` at each selected entity → absent (`canUseAi` false, `editor` has no `ai:use`) | **`403`** |
| `POST /api/projects/prj_shop/autolayout` | `schema:edit`; **not** subject to R21′ | **`200`** — lays out `ent_inv`, `ent_pay`, `ent_emp`; `ent_prod` and `ent_aud` keep their positions |
| `POST /api/entities { areaId: 'ar_bill' }` | R19: parent = area `ar_bill`, `schema:edit` → held | **`201`** |
| `POST /api/entities { areaId: null }` | R19: parent = project, `projectAtoms = ∅` | **`403`** |
| `DELETE /api/areas/ar_bill` | R19: area delete is authorised **at the project** | **`403`** — she cannot dismantle the boundary she lives inside |
| `POST /api/projects/prj_shop/exports { format: 'ddl' }` | `export:run` at project → `projectAtoms = ∅` | **`403`** — flagged §14 Q6 |
| `POST /api/projects/prj_shop/import` | `schema:edit` at project absent; R21′ would reject anyway | **`403 requires_full_project_access`** |
| `GET /api/organizations/org_acme/members` | `@RequireOrgRole(['owner','admin'])`; Dana is `guest` | **`403`** |
| `GET /api/projects` | candidate grants → `prj_shop`; resolve → `canOpenProject` off the map, no skeleton | `[{ id: 'prj_shop', name: 'Shop', engineId: 'postgresql' }]` |

**Now the analyst from the same workflow.** Ana is an org `member` with
`{ project prj_shop, user:usr_ana, viewer, canUseAi: true, canViewRestricted: false }`.
Her map: `projectAtoms = {schema:view, export:run, ai:use}`, `areaAtoms` both equal to it,
`entityOverrides = {}`, so every entity is visible and `restrictedOkEntityIds = ∅`. She sees every
table including `products` and `audit_events` — no stubs, because nothing is hidden from her —
and `salary` as the same anonymous masked slot. Her AI request builds context via
`aiProfile.serializeContext(redactedModel, selection)`; the string sent to Claude contains
`employees(id uuid, name text)` and **no token of the word "salary"** (L12). If she asks for
"average salary by department" the model answers that the schema it was given has no salary
column (L12's prompt clause), and if it guesses one anyway, `queryValidator` — run against the
same redacted model, with **no `restrictedProbe`** (L13) — flags it as an unknown identifier,
indistinguishable from a typo.

**And in April, after she is narrowed to Billing.** Her March saved query
`SELECT p.name, e.salary FROM products p JOIN employees e …` carries
`touchedEntityIds = [ent_prod, ent_emp]` and `touchedFieldIds = [fld_prod_id, fld_sal]`.
`ent_prod` is no longer in `visibleEntityIds` and `fld_sal` is masked, so the row is **omitted
from the library listing and 404s on read** (L25). Its AI thread is omitted whole, so turn 1 is
never replayed to the provider on a follow-up.

### 12.2 Workflow #4 — the guest on an invite link

The spec's workflow #4 has two readings. Both are traced; the share link is the harder one.

**(a) Share link — unauthenticated.** `shl_demo` on `area ar_bill`, password set, expires in
7 days. Its grant carries the built-in `viewer` (R25 — there is no role picker).

| Step | Input | State / output |
|---|---|---|
| 1 | `GET /s/8f2c…` | `sha256(token)` → `ShareLink` lookup on the unique index. Found, `revokedAt` null, not expired. (Any failure → **`404`**, one body, no reason.) |
| 2 | `passwordHash != null` | render the unlock form. No project name, no org name on this page — those are names |
| 3 | `POST /s/8f2c…/unlock { password }` | argon2id verify; rate limit 5/min/IP + 20/h/link; uniform failure response |
| 4 | success | mint `sl_session = { sub: 'share_link:shl_demo', pid: 'prj_shop', rid: 'ar_bill', exp: min(link.expiresAt, now+12h) }`, httpOnly / Secure / SameSite=Lax / **`Path=/`** (a `/s`-scoped cookie is never sent to `/api/**`, so every step below would 401). `useCount++`, `lastUsedAt` (async). Audit row `share_link.unlocked` with IP. Redirect to `/s/8f2c…/p/prj_shop` |
| 5 | `GET /api/projects/prj_shop/ir` with the cookie | `Subject { kind: 'share_link', shareLinkId: 'shl_demo', projectId: 'prj_shop' }` |
| 6 | guard | `session.pid === 'prj_shop'` ✓ (mismatch → `404`); route ∈ `SHARE_LINK_ROUTES` ✓ (R21) |
| 7 | generation read | `pg = 42, og = 11, sg = 0` (no user → `sg = 0`, §9.1) |
| 8 | resolve | principals `['share_link:shl_demo']`; the hot query joins `share_links` for liveness and returns `link_expires_at = now + 7d` → 1 row: area `ar_bill`, `viewer` |
| 9 | cascade | `pProject = ∅`; `pArea[ar_bill] = {schema:view, export:run}`; `pArea[ar_cat] = ∅`; entities as in 12.1 |
| 10 | **ceiling (R17)** | intersect with `{schema:view}` → `export:run` **dropped**. `visibleEntityIds = {inv, pay, emp}`, `restrictedOkEntityIds = ∅`, `canOpenProject = true` |
| 11 | `validUntil` | `min(now + 300 s, link_expires_at)` — and had the link expired in 30 s, the TTL would be 30 s, not 300 (§7.12, §9.1) |
| 12 | redact | byte-identical to Dana's model in 12.1 |
| 13 | `POST /api/comments` | route not in `SHARE_LINK_ROUTES` | **`404`** (not 403 — the surface does not exist for this subject) |
| 14 | `POST /api/projects/prj_shop/exports` | route not in the allow-list, and `export:run` was removed by the ceiling anyway | **`404`** |
| 15 | `WS project:subscribe prj_shop` | in the allow-list; patches pass through `redactPatch`; presence suppressed (L16 + R21) | read-only live view |

**Revocation, mid-session:** a manager clicks Revoke in the "Links" section (the only place it is
offered — R25).

```
tx: UPDATE share_links SET revoked_at = now() WHERE id = 'shl_demo';
    DELETE FROM access_grants WHERE principal_type = 'share_link' AND principal_id = 'shl_demo';
    INSERT INTO audit_log (action = 'share_link.revoked', before = <grant image>, …);
    UPDATE projects SET perm_generation = perm_generation + 1 WHERE id = 'prj_shop';
commit
DEL skel:3:prj_shop:42          -- and every perm key rolls by generation, no DEL needed
WS broadcast permissions:changed { projectId: 'prj_shop' }
```

The visitor's next request reads `pg = 43` from Postgres (there is no mirror to race — §9.1),
builds key `perm:3:prj_shop:sl:shl_demo:11.43.0`, misses, runs the hot query, finds no row
(the grant is gone; the `share_links` liveness predicate would also have failed), and gets
`EMPTY_MAP` → `canOpenProject = false` → **`404`**. Their open socket received
`permissions:changed`, dropped its context, recomputed, got an empty visible set, and
disconnected with `4403`. **Elapsed: one request. No window.**

**(b) Email invite — becomes an ordinary guest.** `POST /invite/:token` → the invitee signs up or
logs in → email verification → `acceptInvitation` (R11) runs one transaction: **`OrgMember`
upsert first** (without it R12.2 kills the grant and the invitee lands on a 404 — the happy path,
broken), then the `email_invite` grant is repointed at the new user id, or collapsed onto an
existing user grant by R11a, then the invitation is marked accepted and `User.permGeneration` is
bumped. They land on `rid`. From that request on they are an ordinary org `guest` user subject —
Dana's path in 12.1 exactly, with whatever role the invite carried. No share-link ceiling applies,
so an invited guest *can* be an editor; a share-link visitor never can. That asymmetry is
deliberate and is the reason the two flows exist.

---

## Key decisions

*(This is §13; the Open questions below are §14, which is how cross-references in the text read.)*

1. **Nine atoms, closure applied at write time (R1).** Resolution is then pure set algebra with no
   rule evaluation, which is what makes the whole matrix snapshot-testable without a database.
2. **Built-in roles form a strict chain: viewer ⊂ commenter ⊂ documenter ⊂ editor ⊂ manager (R2).**
   A totally ordered ladder is explainable in one sentence, makes "a more specific grant overrides"
   a well-defined strengthening or weakening, and makes R11a's collapse rule a one-liner.
3. **`ai:use` reconciled as an additive-only grant modifier (R7),** with `canViewRestricted` as its
   symmetric twin (R8). The boolean can only add, never remove, so the spec's two representations
   cannot contradict each other.
4. **No deny grants (R14); per-principal nearest-level-wins, then union across principals
   (R15 + R16).** Monotone in principals, so group unions are safe and caching is sound. The
   resulting footgun — a narrowing grant defeated by a group — is surfaced as an API warning
   computed by `resolveResource`, not hidden.
5. **R5 is implemented by unioning `sharing:manage` downward inside the resolver (step 4b), not by
   a special case in the guard.** The ancestor-OR was previously stated as a rule and implemented
   nowhere; now `atomsAt(...).has('sharing:manage')` *is* the rule, and P12 proves the union never
   widens visibility.
6. **Attenuation is measured at the resource exactly (R4), and grant deletion is exempt (R4a).**
   That makes delete-then-regrant the single, stated escape hatch from a self-narrowing grant, and
   the 403 body names it — instead of two implementers guessing differently (E12).
7. **Org owner/admin is an unconditional short-circuit (R13), and the skeleton is loaded before
   it.** Loading the skeleton after the short-circuit gave every org owner an empty visible set
   and made `VisibilityFilter` redact the whole schema away from the people holding all nine
   atoms.
8. **Share links are an ordinary `AccessGrant` with a code-level ceiling of `{schema:view}` and an
   allow-list of reachable routes (R17, R21).** Creation always writes the built-in `viewer`, the
   link is the single source of its own target (R25), and revoking it deletes both rows in one
   transaction — so a manager tidying the access dialog can no longer strand a visitor in a
   successful unlock followed by 404s.
9. **The allow-list replaced a deny-list.** `schema:view` is deliberately fat, so every future
   surface built on it was a share-link leak by default; the boot sweep now asserts every route is
   classified.
10. **Ids in a redacted model are real; confidentiality lives in the blanked properties.** The
    HMAC stub-token scheme is deleted: it bought nothing a cuid does not already give (no name, no
    cross-project correlation, 404 on every route) and it broke "Request access" and field reorder,
    and required a key-derivation path and a rotation story nobody had.
11. **A masked field discloses no name and no type (§7.10, §8.5).** SchemaLoom stores no data, so
    names and types *are* the content; a mask that keeps them makes `field:viewRestricted`
    decorative. This is the one substantive disagreement with doc 04 and it is argued, not
    asserted.
12. **One expression rule (R27) over one new optional IR field (`IrBase.refs`)** closes L3–L6
    uniformly — expression indexes, partial predicates, CHECK bodies, defaults and generated
    columns — instead of three parallel `*ReferencedIds` arrays that still missed
    `CREATE INDEX ON employees ((salary * 12))`.
13. **Restriction is inherited down the field subtree (R24), and hide-mode renumbering is per
    `(entityId, parentFieldId)` sibling group (L22).** Nested fields are in the spec and in doc 04;
    entity-wide renumbering would have corrupted every one of them.
14. **Restore never writes `isRestricted` or `areaId` (R28).** Otherwise a feature gated at
    `schema:edit` silently un-restricts a column that R20 says needs `sharing:manage`.
15. **Generation counters live in Postgres and are read on every resolve; the Redis mirror is
    deleted (§9.1, §9.2).** The mirror's write-back raced every revoke under load and resurrected
    revoked grants for up to ten seconds. The bound is now genuinely "the next request".
16. **`validUntil` folds in `share_links.expires_at`, and the Redis TTL is derived from it** — an
    expiring link can no longer leave a 300-second map alive behind it.
17. **The permission map stores `entityOverrides`, not a full `entityAtoms` map (§7.5).** Same
    semantics, ~2 KB instead of ~50 KB per subject per project, and one shape rather than four
    derived fields to keep in sync. `ProjectSkeleton.fieldsByEntity` is deleted outright: nothing
    read it.
18. **A group's grant change bumps the project, not the org (§9.3), and a bulk operation bumps
    exactly once (R29).** The most frequent sharing operation in the product no longer cold-starts
    every cache in a 200-user org, and a 300-table import produces one invalidation, not 300.
19. **Every access-control write takes a project advisory lock, re-resolves inside it, and commits
    the change, audit row and generation bump together (R26)** — and access-control rows carry no
    `version Int`, a deliberate, stated C7 deviation, because the lock guards *sequences* and a
    per-row version cannot.
20. **`resolveResource` is a named algorithm, not a hand-wave (R23).** Three shipped features and
    two more need the inverse direction; two queries serve all of them, and P13 asserts the two
    directions agree.
21. **R19 covers update and delete, not just create (§7.8).** Area delete is authorised at the
    project (so the Billing-only editor cannot delete the boundary she lives in) and link delete
    requires both endpoints (so she cannot drop a foreign key on a table she cannot see).
22. **Entity deletion hard-deletes that entity's grants, with a before-image, in the same
    transaction (§7.11),** plus a weekly sweep. Orphaned grants were making `GET /projects`
    resolve dead projects on every page load.
23. **Saved queries and AI transcripts are filtered by their touched-id arrays, and omitted whole
    when they fail (L25).** Their body *is* the payload; SQL text cannot be partially redacted, and
    a thread with holes replays nonsense to the provider.
24. **Core passes no `restrictedProbe` (L13).** Doc 03's `'hidden'` verdict is an existence oracle
    and is strictly more disclosure than the canvas, which only stubs *linked* hidden entities.
25. **The raw model is unreachable, not merely discouraged (§8.6).** `redact` moves into
    `schema-model` beside a hash-private `RawSchemaModel` with a throwing `toJSON`, so
    `return raw.ir` no longer compiles; the interceptor also rejects any `SchemaModel`-shaped value
    whose `redacted !== true`, and the socket and export paths call it explicitly because Nest
    interceptors do not cover them.
26. **404 for invisible, 403 for visible-but-forbidden, with byte-identical 404 bodies (§10.3).**
    Asserted by a property test, because this is the difference between a permission system and an
    existence oracle.
27. **`restrictedFieldMode` defaults to `mask`, as a real enum column (§6.3).** `hide` has an
    irreducible name-collision oracle (L21) and produces a schema the user can act on wrongly.
28. **R21′ covers import, restore and migration generation — and not autolayout.** Laying out
    boxes cannot drop a table you cannot see; including it only gave the spec's own freelancer a
    403 that reads as a bug.
29. **No write endpoint accepts a full-list replacement of a redactable collection (R22 / L20),**
    and `beforeFieldId` may name a masked field, because otherwise a redacted client cannot reach
    the end of its own field list.
30. **The permission matrix is a generated, committed CSV snapshot (§11.1),** 1,056 assertions per
    mode, reviewed as a diff — not 25,920 hand-written cases nobody reads.

## Open questions

*(This is §14.)*

1. **`canViewRestricted` is an extra column neither doc 02 nor the spec's sketch has (R8).**
   Confirm. The alternative — requiring a custom role for every person who may see a salary column
   — makes the spec's own workflow #2 clumsy. If a third modifier ever appears, both booleans
   should become a constrained `extraAtoms PermissionAtom[]`.
2. **Workspaces are not grantable**, because C5 fixes the grantable set to `project | area | entity`.
   "Share this whole workspace with the Analysts group" therefore expands to N project grants,
   which do not auto-apply to projects created later in that workspace. If workspace-level sharing
   is wanted, C5 needs a fourth resource type and this document needs one more level in the chain
   — a cheap change now, an expensive one after launch. **Please decide before implementation.**
3. **Org admins can always see restricted fields (R13).** Some compliance regimes require
   "administrators cannot read PII". Supporting that means either a break-glass flow (self-elevate,
   time-boxed, loudly audited) or a genuine deny mechanism, which R14 rejects. Out of scope for v1
   unless you say otherwise.
4. **`export:run` is in every built-in role, including `viewer` (§3.1).** A viewer can already read
   everything on screen, so withholding export is theatre. If you want a no-export viewer as a
   *built-in*, the R2 chain breaks and the matrix gets a second axis. Recommendation: leave it, and
   let a custom role cover the DLP case.
5. **The `Restricted` flag lives under "structured field docs" in SPEC §6.2**, which implies
   `docs:edit`. R20 deliberately requires more: `schema:edit` + `field:viewRestricted` to set it,
   `sharing:manage` to unset it. A documenter marking a column as PII is a plausible workflow this
   blocks; if you want it, splitting into "propose restricted" (documenter) + "confirm" (manager)
   is the smallest fix.
6. **Exports are project-scoped**, so the Billing-only freelancer cannot export at all (§12.1). An
   area-scoped export (`POST /areas/:id/exports`) would fix it and is a small addition, but it is
   not in the spec. Worth it?
7. **Composite custom types are not redacted (§8.3).** A composite type whose attributes mirror a
   hidden entity's columns is a real leak vector, but type *names* are shared vocabulary across the
   project and hiding them would break visible entities that use them. v1 keeps all custom types
   visible to anyone who can see any entity. If PostgreSQL composite types turn out to be used to
   model private records, this needs revisiting.
8. **One IR addition I need from doc 04, and it is a hard dependency:** `IrBase.refs?: ObjectRefs`
   (`{ entityIds, fieldIds }`), populated by the engine for any object whose `engineProps` or
   `IndexColumn.expression` textually references another object, plus a second optional flag
   `propsRedacted?: true` on `IrBase`, beside the flat `restricted?: true` doc 04 already carries.
   Without it, redaction of an expression degrades to a string scan, which
   I am only willing to run as a dev-time canary (L4), never as the mitigation. This replaces the
   three separate arrays an earlier draft asked for, and it is strictly less work for doc 04.
9. **Two engine-SDK signatures must take `RedactedModel`, not `SchemaModel`** — `Exporter.export`'s
   `ExportInput.model` and `AiProfile.serializeContext` — and `redact` / `RawSchemaModel` /
   `VisibilityContext` must live in `packages/schema-model` so the brand and the private payload
   share one module (§8.6, C10-compliant). **Doc 03 and doc 04 both need to agree.** Doc 03's prose
   already says the model is "ALREADY redacted"; this makes the compiler say it.
10. **Deliberately small, flagged per C12.** `AccessRequest.requestedRoleKey` is barely used
    (approvers almost always pick their own) and could go; I kept doc 02's column rather than ask
    for a removal. `ShareLink.useCount` / `lastUsedAt` are doc 02's and nothing in this document
    reads them. `email_invite` as a `PrincipalType` earns its place only because invites must exist
    before the account does, and doc 02's separate `Invitation` model already carries the invite
    itself — if you would rather drop the principal type to three values, R11 becomes "invitation
    accepted → write grants" and nothing else in this document changes. C5 names the fourth value,
    so I kept it.
11. **Not designed here, deliberately:** rate-limit *tiers* per role (the spec puts AI rate limits
    per user and per org, not per role), and permission-expiry *notifications* ("your access
    expires in 3 days"). Both are easy additions later and neither changes the resolver.
12. **Conflicts with the sibling documents, each needing one decision.** This table is exhaustive:
    every place this document and a sibling disagree is a row here, and nothing outside it is in
    dispute. Where redaction is concerned this document should generally win, because it is the one
    written against the leak audit — but (f) and (g) go in opposite directions and both are argued.

    | # | Sibling says | This document says | Resolution I propose |
    |---|---|---|---|
    | a | `04 §10.1`: in `hide` mode, surviving fields **keep their original `ordinal`** — "ordinal gaps are normal in a redacted model" | **L22 / P9:** densely renumbered within each `(entityId, parentFieldId)` sibling group | **Mine.** An ordinal gap *is* the leak — it says "a column you cannot see sits here". If the validator must tolerate gaps for other reasons, tolerate them; the filter must not produce them. |
    | b | `04 §10.1`: an index or constraint referencing **only masked** fields is **kept**, "so the PK badge still renders" | **§8.3:** kept, with `name: ''`, `engineProps: {}`, expression columns dropped, `restricted: true` | **Both, and we agree on the intent.** The object survives so the badge renders; what does not survive is the name (`idx_emp_salary`), the partial predicate and the CHECK body. Doc 04's wording should say so. |
    | c | `02 §7`: `restrictedFieldMode` lives in `projects.settings` JSONB via `projectSettingsSchema` | a real `RestrictedFieldMode` enum column on `Project` (§6.3) | **Mine.** It is read on every resolve and it is security-relevant; C2 explicitly allows a Prisma enum for a closed set the database should enforce, and C4's JSONB rule is about *engine*-specific props. |
    | d | `02`: `AccessGrant` has `canUseAi` only; no `permGeneration` columns anywhere | `canViewRestricted` (R8) plus `permGeneration Int` on `Organization` / `Project` / `User` (§6.3) | **Add all four columns to doc 02.** The generation columns are the revocation mechanism (§9.4); without them the cache falls back to a 300 s staleness window. |
    | e | `03 §13`: `serializeContext(model: SchemaModel, …)`; `ExportInput.model: SchemaModel` | both must take `RedactedModel` (§8.6) | **Mine.** The signature *is* the single-path enforcement; a plain `SchemaModel` parameter means the compiler cannot tell a redacted model from a raw one. |
    | **f** | `04 §10.1`: a **masked field keeps `name`, `ordinal`, `type` and `isNullable`** — "keeping name and type is the point of masked" | §7.10 / §8.5: keeps `id`, `entityId`, `parentFieldId` and `ordinal`; blanks `name`, `type`, `isNullable`, the flags, `doc` and `engineProps` | **Mine, and this is the single most security-relevant disagreement in the product.** SchemaLoom stores no data: names, types and docs *are* the content. A mask that keeps the name leaves the freelancer of the spec's own workflow #2 reading `salary numeric(10,2)`, and `field:viewRestricted` protects nothing. **Doc 04 §10.1's "Masked field" paragraph must change.** |
    | **g** | `04 §10.1`: a **stub entity keeps its real `id`, real `kind` and real `namespaceId`** ("request access to this table needs a target") | §7.10 / §8.5: **agreed — real id, real kind, real namespaceId** | **Doc 04's, adopted in full.** An earlier draft of this document HMAC'd the id and dropped kind and namespace; that bought nothing (a cuid carries no name, ids do not correlate across projects, every route 404s) and broke both "Request access" and field reorder. The HMAC scheme, `stubKey` and the `*st_` DTO ban are deleted. |
    | **h** | `03 §12.1`: `QueryValidationInput.restrictedProbe` returns `'hidden'`, rendered as "this object exists but is not shared with you"; "core implements it against the unredacted model" | L13 / §10.3 step 8 / P8: the two cases must be indistinguishable | **Core hard-wires it off** by passing `restrictedProbe: undefined` — doc 03 already makes the field optional, so **no doc 03 change is needed**, only the removal of the sentence implying core will implement it. The probe is strictly more disclosure than the canvas (which stubs only *linked* hidden entities and says nothing about unlinked ones) and is a straight oracle in `hide` mode. If a customer wants the friendlier message, it becomes a per-project setting later; it must not be the default. |
    | **i** | `02` **final**: `AccessRequest` uses `requestedById` / `requestedRoleKey` / `decisionNote`; `AccessGrant` uses `createdById` and `note`, and **carries `organizationId`**; the enum is `ResourceType`; `Role` uses `atoms String[]` / `isBuiltIn` / `isArchived`; `ShareLink` uses `lastUsedAt` / `useCount` / `label` and carries **no** resource pointer; `AccessRequestStatus` includes `withdrawn`, not `cancelled` | an earlier draft invented `requesterId`, `requestedRoleId`, `denyReason`, `grantedById`, `GrantResourceType`, `RoleScope`, `lastAccessedAt`, `accessCount`, a resource pointer on `ShareLink`, and dropped `AccessGrant.organizationId` | **Doc 02's, adopted wholesale — there is nothing left to decide here.** §6 of this revision uses doc 02's final names throughout, including `ResourceType`, `createdById`, `note`, `withdrawn`, `Role.atoms` and `Role.isArchived`. **`AccessGrant.organizationId` is present**, derived at write time: it is the C6 denormalisation the offboarding liveness rule (doc 02 Key decision 20) reads, and this document no longer proposes removing it. The `ShareLink` resource pointer stays dropped (R25: the grant is the single source). The only column this document still asks doc 02 to add is row (d). |
    | **j** | `02`: `AccessRequest` has no four-column `@@unique`; the partial index `access_requests_pending_uq` lives in the hand-written migration | an earlier draft had `@@unique([resourceType, resourceId, requesterId, status])` | **Doc 02's, and this document now cites it.** The four-column unique permits exactly one *denied* row per (resource, requester) for all time, so the second denial is a permanent 500 on the Deny button — and Prisma cannot express a partial unique index anyway. |

13. **Naming, no semantics at stake.** This revision uses doc 04's `SchemaModel` everywhere (the
    earlier `SchemaIR` is gone) and `RedactedModel` for the brand. Every reference to doc 03 and
    doc 04 in §1.1 has been corrected — an earlier draft had the two files swapped, so its IR
    requests were addressed to the engine SDK and vice versa.
14. **Two residual leaks are stated, not solved, and the customer should know about both.**
    L21: in `hide` mode, creating a field whose name collides with a hidden one must fail, which
    proves the hidden one exists — irreducible, and the reason `mask` is the default. L26: free
    prose in documentation can name an object the reader cannot see; structured `@`-mentions are
    redacted and the editor warns at authoring time, but nothing can redact an English sentence.
    Both belong in the product's security documentation, not only here.
