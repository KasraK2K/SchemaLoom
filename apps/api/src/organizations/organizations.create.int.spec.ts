import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PermissionResolver } from '../access';
import { PrismaClient } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { OrganizationsService } from './organizations.service';

/** Roadmap 24 §2.1 against a real Postgres (`DATABASE_URL_TEST`): a new org gets the server integration. */
const url = process.env.DATABASE_URL_TEST;
const USER = 'usr_orgcreate';

describe.skipIf(url === undefined)('OrganizationsService.create (roadmap 24 §2.1)', () => {
  const db = new PrismaClient({ datasourceUrl: url });
  const svc = new OrganizationsService(db as unknown as PrismaService, {} as PermissionResolver);

  const cleanup = async (): Promise<void> => {
    await db.organization.deleteMany({ where: { members: { some: { userId: USER } } } });
    await db.user.deleteMany({ where: { id: USER } });
  };
  beforeAll(async () => {
    await cleanup();
    await db.user.create({ data: { id: USER, email: `${USER}@org.test`, name: USER } });
  });
  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it('gives a new org one server integration granted to everyone', async () => {
    const org = await svc.create(USER, 'Orgcreate Test');
    const rows = await db.aiIntegration.findMany({
      where: { organizationId: org.id },
      include: { grants: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'server', provider: 'anthropic' });
    expect(rows[0]?.grants.map((g) => [g.projectId, g.userId])).toEqual([[null, null]]);
  });
});
