/**
 * The fixed ids `apps/api/prisma/seed.ts` writes and the e2e suite asserts on.
 *
 * ONE SOURCE, imported by both. `e2e/fixtures/seed-ids.ts` used to mirror these by hand
 * and its own header predicted the failure: "a change to the seed's ids has to be made
 * here too". It did, it wasn't, and five specs failed on a drift that no type could
 * catch because the two copies were structurally identical and merely disagreed.
 *
 * ── Why every id here is OPAQUE ──────────────────────────────────────────────────────
 *
 * RECONCILIATION R-2 keeps a redacted object's REAL id, because "Request access" has to
 * name the thing being requested. So an id is part of the payload a user who CANNOT see
 * the object still receives.
 *
 * That makes `ent_seed_demo_products_01` a leak: the freelancer, who must never learn
 * that a `products` table exists, receives a stub carrying that string. Same for
 * `fld_seed_demo_salary_0001`. Redaction blanks `name`, `type` and `engineProps` exactly
 * as designed — and then the id undoes it.
 *
 * Production ids are cuids and carry no name, so this is fixture hygiene rather than a
 * redaction bug. But it generalises into a rule worth stating: NEVER derive an id from a
 * value that may be restricted. Anything readable in an id is readable by everyone who
 * can see a stub of it.
 *
 * The mapping below is the readability these literals used to buy, kept where it costs
 * nothing.
 */

export const DEMO_PASSWORD = 'SchemaLoom!demo1';

export const SEED = {
  orgId: 'org_seed_demo_acme_000001',
  orgSlug: 'acme',
  workspaceId: 'wsp_seed_demo_commerce_01',
  projectId: 'prj_seed_demo_storefront1',
  namespaceId: 'nsp_seed_demo_public_0001',

  users: {
    /** Org owner — R13, sees everything without a single grant. */
    owner: { id: 'usr_seed_demo_owner_0001', email: 'owner@acme.test', name: 'Olivia Owner' },
    admin: { id: 'usr_seed_demo_admin_0001', email: 'admin@acme.test', name: 'Adam Admin' },
    /** Org member, Viewer + AI on the whole project, NO `field:viewRestricted`. */
    member: { id: 'usr_seed_demo_member_001', email: 'analyst@acme.test', name: 'Alex Analyst' },
    /** Org guest, Editor on the Billing area only — SPEC workflow #2's freelancer. */
    guest: { id: 'usr_seed_demo_guest_0001', email: 'dana@contractor.test', name: 'Dana Designer' },
  },

  /** a1 = Billing, a2 = Catalog. Opaque because an area name is a name. */
  areas: {
    billing: 'are_seed_demo_a1_000001',
    catalog: 'are_seed_demo_a2_000001',
  },

  /** t1..t5. The freelancer sees only the Billing ones and gets stubs for the rest. */
  entities: {
    customers: 'ent_seed_demo_t1_000001',
    orders: 'ent_seed_demo_t2_000001',
    orderItems: 'ent_seed_demo_t3_000001',
    /** In the Catalog area: the freelancer must never learn this exists. */
    products: 'ent_seed_demo_t4_000001',
    /** In no area: holds the Restricted column. */
    employees: 'ent_seed_demo_t5_000001',
  },

  /** The Restricted column SPEC workflow #2 is built around (`employees.salary`). */
  salaryFieldId: 'fld_seed_demo_t5_c3_0001',
} as const;

/**
 * Names the freelancer must never read, asserted as raw bytes over the whole response
 * rather than as rendered text — a leak through an id, a diagnostic or an index
 * definition never reaches the DOM, and a DOM assertion would pass while the payload
 * carried the name.
 */
export const HIDDEN_FROM_FREELANCER = ['products', 'list_price', 'sku', 'salary'] as const;

/** Convenience for e2e, which addresses users by email. */
export const SEED_EMAILS = {
  owner: SEED.users.owner.email,
  admin: SEED.users.admin.email,
  analyst: SEED.users.member.email,
  freelancer: SEED.users.guest.email,
} as const;
