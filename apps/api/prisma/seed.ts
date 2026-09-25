import { BUILTIN_ROLE_IDS } from '@schemaloom/contracts';
import { hashPassword } from '../src/auth/password';
import { PrismaClient } from '../src/generated/prisma/client';
import { OrgRole, PrincipalType, ResourceType } from '../src/generated/prisma/enums';

/**
 * SPEC §10 — "Seed script with a demo org, users of every role, and a sample e-commerce
 * schema."
 *
 * It is also the fixture the e2e suite runs against (doc 01 §12.2): `global-setup.ts`
 * migrates `schemaloom_e2e` and calls `db:seed`, then truncates and reseeds between
 * suites. That is why every id below is a FIXED literal and why the whole thing is
 * idempotent — a test that has to discover the id of the row it is asserting on is a
 * test that fails for two different reasons.
 *
 * The shape is SPEC §8's workflow #2, so the permission e2e specs have a world to run
 * in: Dana is an org `guest` with Editor on the Billing area only; Alex is an org
 * `member` with Viewer + AI on the whole project and NO `canViewRestricted`, so
 * `employees.salary` is masked for them.
 *
 * Run: `pnpm --filter @schemaloom/api db:seed` (needs DATABASE_URL and a migrated
 * database — `prisma migrate deploy` first, for the five built-in roles from 0003).
 */

const prisma = new PrismaClient();

export const DEMO_PASSWORD = 'SchemaLoom!demo1';

/** Fixed ids. Principal ids must match `^[A-Za-z0-9_-]{16,64}$` (migration 0002). */
export const SEED = {
  orgId: 'org_seed_demo_acme_000001',
  workspaceId: 'wsp_seed_demo_commerce_01',
  projectId: 'prj_seed_demo_storefront1',
  namespaceId: 'nsp_seed_demo_public_0001',
  users: {
    owner: { id: 'usr_seed_demo_owner_0001', email: 'owner@acme.test', name: 'Olivia Owner' },
    admin: { id: 'usr_seed_demo_admin_0001', email: 'admin@acme.test', name: 'Adam Admin' },
    member: { id: 'usr_seed_demo_member_001', email: 'analyst@acme.test', name: 'Alex Analyst' },
    guest: { id: 'usr_seed_demo_guest_0001', email: 'dana@contractor.test', name: 'Dana Designer' },
  },
  areas: { billing: 'are_seed_demo_billing_01', catalog: 'are_seed_demo_catalog_01' },
  entities: {
    customers: 'ent_seed_demo_customers1',
    orders: 'ent_seed_demo_orders_0001',
    orderItems: 'ent_seed_demo_orderitem1',
    products: 'ent_seed_demo_products_01',
    employees: 'ent_seed_demo_employees1',
  },
  /** The Restricted column SPEC workflow #2 is built around. */
  salaryFieldId: 'fld_seed_demo_salary_0001',
} as const;

// ---------------------------------------------------------------------------------------
// The sample e-commerce schema, as data. One table per row, one column per tuple.
// ---------------------------------------------------------------------------------------

interface ColumnSeed {
  readonly name: string;
  readonly dataType: string;
  readonly typeArgs?: readonly (string | number)[];
  readonly isNullable?: boolean;
  readonly isRestricted?: boolean;
  readonly isPii?: boolean;
  readonly id?: string;
}

interface TableSeed {
  readonly id: string;
  readonly name: string;
  readonly areaId: string | null;
  readonly x: number;
  readonly y: number;
  readonly columns: readonly ColumnSeed[];
}

const TABLES: readonly TableSeed[] = [
  {
    id: SEED.entities.customers,
    name: 'customers',
    areaId: SEED.areas.billing,
    x: 0,
    y: 0,
    columns: [
      { name: 'id', dataType: 'uuid', isNullable: false },
      { name: 'email', dataType: 'citext', isNullable: false, isPii: true },
      { name: 'full_name', dataType: 'text', isPii: true },
      { name: 'created_at', dataType: 'timestamptz', isNullable: false },
    ],
  },
  {
    id: SEED.entities.orders,
    name: 'orders',
    areaId: SEED.areas.billing,
    x: 360,
    y: 0,
    columns: [
      { name: 'id', dataType: 'uuid', isNullable: false },
      { name: 'customer_id', dataType: 'uuid', isNullable: false },
      { name: 'status', dataType: 'text', isNullable: false },
      { name: 'total_cents', dataType: 'integer', isNullable: false },
      { name: 'placed_at', dataType: 'timestamptz', isNullable: false },
    ],
  },
  {
    id: SEED.entities.orderItems,
    name: 'order_items',
    areaId: SEED.areas.billing,
    x: 720,
    y: 0,
    columns: [
      { name: 'id', dataType: 'uuid', isNullable: false },
      { name: 'order_id', dataType: 'uuid', isNullable: false },
      { name: 'product_id', dataType: 'uuid', isNullable: false },
      { name: 'quantity', dataType: 'integer', isNullable: false },
      { name: 'unit_price', dataType: 'numeric', typeArgs: [10, 2], isNullable: false },
    ],
  },
  {
    id: SEED.entities.products,
    name: 'products',
    areaId: SEED.areas.catalog,
    x: 720,
    y: 320,
    columns: [
      { name: 'id', dataType: 'uuid', isNullable: false },
      { name: 'sku', dataType: 'varchar', typeArgs: [64], isNullable: false },
      { name: 'name', dataType: 'text', isNullable: false },
      { name: 'list_price', dataType: 'numeric', typeArgs: [10, 2], isNullable: false },
    ],
  },
  {
    // No area: the analyst sees it through the project grant, the freelancer never does.
    id: SEED.entities.employees,
    name: 'employees',
    areaId: null,
    x: 0,
    y: 320,
    columns: [
      { name: 'id', dataType: 'uuid', isNullable: false },
      { name: 'full_name', dataType: 'text', isNullable: false, isPii: true },
      {
        id: SEED.salaryFieldId,
        name: 'salary',
        dataType: 'numeric',
        typeArgs: [10, 2],
        isNullable: false,
        isRestricted: true,
      },
    ],
  },
];

/** `[fromTable, fromColumn, toTable, toColumn, name]`. */
const FOREIGN_KEYS = [
  [SEED.entities.orders, 'customer_id', SEED.entities.customers, 'id', 'fk_orders_customer'],
  [SEED.entities.orderItems, 'order_id', SEED.entities.orders, 'id', 'fk_order_items_order'],
  [SEED.entities.orderItems, 'product_id', SEED.entities.products, 'id', 'fk_order_items_product'],
] as const;

// ---------------------------------------------------------------------------------------

const fieldId = (entityId: string, column: ColumnSeed, i: number): string =>
  column.id ?? `${entityId.replace('ent_', 'fld_').slice(0, 20)}_${String(i).padStart(3, '0')}`;

async function main(): Promise<void> {
  // Idempotent by demolition: every seeded row hangs off the org or is one of the four
  // demo users, and both cascade. Upserting a 40-row graph would be more code and would
  // leave anything renamed since the last run behind.
  await prisma.organization.deleteMany({ where: { id: SEED.orgId } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(SEED.users).map((u) => u.id) } } });

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const now = new Date();

  await prisma.user.createMany({
    data: Object.values(SEED.users).map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      passwordHash,
      emailVerifiedAt: now,
    })),
  });

  await prisma.organization.create({
    data: { id: SEED.orgId, name: 'Acme Commerce', slug: 'acme' },
  });

  await prisma.orgMember.createMany({
    data: [
      { organizationId: SEED.orgId, userId: SEED.users.owner.id, role: OrgRole.owner },
      { organizationId: SEED.orgId, userId: SEED.users.admin.id, role: OrgRole.admin },
      { organizationId: SEED.orgId, userId: SEED.users.member.id, role: OrgRole.member },
      { organizationId: SEED.orgId, userId: SEED.users.guest.id, role: OrgRole.guest },
    ],
  });

  await prisma.workspace.create({
    data: {
      id: SEED.workspaceId,
      organizationId: SEED.orgId,
      name: 'Commerce',
      slug: 'commerce',
    },
  });

  await prisma.project.create({
    data: {
      id: SEED.projectId,
      organizationId: SEED.orgId,
      workspaceId: SEED.workspaceId,
      name: 'Storefront',
      slug: 'storefront',
      description: 'Demo e-commerce schema.',
      engineId: 'postgresql',
      engineVersion: '16',
      enginePluginVersion: '1.0.0',
      createdById: SEED.users.owner.id,
    },
  });

  await prisma.namespace.create({
    data: { id: SEED.namespaceId, projectId: SEED.projectId, name: 'public', isDefault: true },
  });

  await prisma.area.createMany({
    data: [
      { id: SEED.areas.billing, projectId: SEED.projectId, name: 'Billing', color: 'indigo', position: 0 },
      { id: SEED.areas.catalog, projectId: SEED.projectId, name: 'Catalog', color: 'grass', position: 1 },
    ],
  });

  await prisma.entity.createMany({
    data: TABLES.map((t) => ({
      id: t.id,
      projectId: SEED.projectId,
      namespaceId: SEED.namespaceId,
      areaId: t.areaId,
      name: t.name,
      kind: 'table',
      positionX: t.x,
      positionY: t.y,
    })),
  });

  await prisma.field.createMany({
    data: TABLES.flatMap((t) =>
      t.columns.map((c, i) => ({
        id: fieldId(t.id, c, i),
        projectId: SEED.projectId,
        entityId: t.id,
        name: c.name,
        dataType: c.dataType,
        typeArgs: [...(c.typeArgs ?? [])],
        position: i,
        isNullable: c.isNullable ?? true,
        isRestricted: c.isRestricted ?? false,
        isPii: c.isPii ?? false,
      })),
    ),
  });

  const columnId = (entityId: string, columnName: string): string => {
    const table = TABLES.find((t) => t.id === entityId);
    const i = table?.columns.findIndex((c) => c.name === columnName) ?? -1;
    const column = table?.columns[i];
    if (column === undefined) throw new Error(`seed: no column ${entityId}.${columnName}`);
    return fieldId(entityId, column, i);
  };

  for (const [fromTable, fromColumn, toTable, toColumn, name] of FOREIGN_KEYS) {
    const link = await prisma.link.create({
      data: {
        projectId: SEED.projectId,
        name,
        kind: 'foreign_key',
        sourceEntityId: fromTable,
        targetEntityId: toTable,
        engineProps: { onDelete: 'restrict' },
      },
    });
    await prisma.linkEndpoint.create({
      data: {
        projectId: SEED.projectId,
        linkId: link.id,
        ordinal: 0,
        sourceFieldId: columnId(fromTable, fromColumn),
        targetFieldId: columnId(toTable, toColumn),
      },
    });
  }

  // SPEC workflow #2's two grants, and nothing else: everyone else's access comes from
  // their ORG role (R13), which is the case the e2e suite needs to exercise.
  await prisma.accessGrant.createMany({
    data: [
      {
        organizationId: SEED.orgId,
        projectId: SEED.projectId,
        resourceType: ResourceType.area,
        resourceId: SEED.areas.billing,
        principalType: PrincipalType.user,
        principalId: SEED.users.guest.id,
        roleId: BUILTIN_ROLE_IDS.editor,
        note: 'Freelancer — Billing only.',
        createdById: SEED.users.owner.id,
      },
      {
        organizationId: SEED.orgId,
        projectId: SEED.projectId,
        resourceType: ResourceType.project,
        resourceId: SEED.projectId,
        principalType: PrincipalType.user,
        principalId: SEED.users.member.id,
        roleId: BUILTIN_ROLE_IDS.viewer,
        canUseAi: true,
        // Deliberately NOT canViewRestricted: `employees.salary` must stay masked.
        note: 'Analyst — read-only plus AI.',
        createdById: SEED.users.owner.id,
      },
    ],
  });

  console.info(`seeded org ${SEED.orgId}, project ${SEED.projectId}, ${String(TABLES.length)} tables`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
