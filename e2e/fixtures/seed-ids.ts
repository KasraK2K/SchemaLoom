/**
 * The ids `apps/api/prisma/seed.ts` writes.
 *
 * MIRRORED, not imported: `apps/api` is `private: true` with no `exports` field and is
 * deliberately not importable from here (doc 01 §12.2). The long-term home for these is
 * `packages/contracts/src/fixtures.ts` — §12.2 says so — and the moment that file exists
 * both sides should import it and this one should be deleted. Until then, a change to
 * the seed's ids has to be made here too, and the first spec that opens the project will
 * say so loudly.
 */
export const DEMO_PASSWORD = 'SchemaLoom!demo1';

export const SEED = {
  orgSlug: 'acme',
  projectId: 'prj_seed_demo_storefront1',
  users: {
    /** Org owner — R13, sees everything without a single grant. */
    owner: 'owner@acme.test',
    admin: 'admin@acme.test',
    /** Org member, Viewer + AI on the whole project, NO `field:viewRestricted`. */
    analyst: 'analyst@acme.test',
    /** Org guest, Editor on the Billing area only — SPEC workflow #2's freelancer. */
    freelancer: 'dana@contractor.test',
  },
  areas: { billing: 'are_seed_demo_billing_01', catalog: 'are_seed_demo_catalog_01' },
  entities: {
    customers: 'ent_seed_demo_customers1',
    orders: 'ent_seed_demo_orders_0001',
    orderItems: 'ent_seed_demo_orderitem1',
    /** In the Catalog area: the freelancer must never see it. */
    products: 'ent_seed_demo_products_01',
    /** In no area: holds the Restricted `salary` column. */
    employees: 'ent_seed_demo_employees1',
  },
  salaryFieldId: 'fld_seed_demo_salary_0001',
} as const;

/** Names the freelancer must never read. Asserted as bytes, not as rendered text. */
export const HIDDEN_FROM_FREELANCER = ['products', 'list_price', 'sku'] as const;
