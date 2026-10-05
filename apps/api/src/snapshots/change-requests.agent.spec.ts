import { describe, expect, it, vi } from 'vitest';
import type { PermissionResolver, ProjectPermissionMap, ProjectSkeleton } from '../access';
import type { PrismaService } from '../prisma/prisma.service';
import {
  AGENT_OPEN_PROPOSALS,
  ChangeRequestsService,
  type ChangeRequestSummary,
} from './change-requests.service';
import type { ImportPreview, SnapshotContext, SnapshotsService } from './snapshots.service';

/**
 * Roadmap 21b §9.3 — `proposeFromAgent` on its own. The gate in front of it (`ai:use`, the
 * AI switch) is `ai.service.spec.ts`; the real fork, import and merge are e2e workflow 22.
 */

// An empty project is a complete view; the right to comment is the only atom it reads.
const CTX: SnapshotContext = {
  projectId: 'prj_1',
  subject: { kind: 'user', userId: 'usr_ana', orgId: 'org_1' },
  actorUserId: 'usr_ana',
  map: { projectAtoms: new Set(['comment:create']) } as unknown as ProjectPermissionMap,
  skel: { entities: [], entitiesWithRestrictedFields: new Set() } as unknown as ProjectSkeleton,
};

const INPUT = { tokenId: 'tok_1', title: 'Add invoices', sql: 'CREATE TABLE invoices (id int);' };

function harness(openProposals: number, preview: Partial<ImportPreview> = {}) {
  let revision = 1n;
  const prisma = {
    changeRequest: { count: vi.fn(() => Promise.resolve(openProposals)) },
    project: {
      findMany: vi.fn(() => Promise.resolve([{ id: 'prj_draft', schemaRevision: revision }])),
      findUniqueOrThrow: vi.fn(() => Promise.resolve({ organization: { slug: 'acme' } })),
      delete: vi.fn(() => Promise.resolve({})),
    },
  };
  const snapshots = {
    preview: vi.fn(() =>
      Promise.resolve({
        creates: [],
        existing: [],
        renameCandidates: [],
        notApplied: [],
        ...preview,
      }),
    ),
    importSource: vi.fn(() => {
      revision += 1n;
      return Promise.resolve({});
    }),
  };
  const resolver = {
    resolveProject: vi.fn(() => Promise.resolve(CTX.map)),
    skeleton: vi.fn(() => Promise.resolve(CTX.skel)),
  };
  const service = new ChangeRequestsService(
    prisma as unknown as PrismaService,
    resolver as unknown as PermissionResolver,
    {} as never,
    {} as never,
    {} as never,
    snapshots as unknown as SnapshotsService,
    {} as never,
  );
  const create = vi
    .spyOn(service, 'create')
    .mockResolvedValue({ id: 'cr_1', draftProjectId: 'prj_draft' } as ChangeRequestSummary);
  return { service, prisma, snapshots, create };
}

describe('ChangeRequestsService.proposeFromAgent (roadmap 21b)', () => {
  it(`refuses the proposal after ${String(AGENT_OPEN_PROPOSALS)} open ones from the same token, before anything runs`, async () => {
    const full = harness(AGENT_OPEN_PROPOSALS);
    await expect(full.service.proposeFromAgent(CTX, INPUT)).rejects.toMatchObject({
      status: 409,
      response: { code: 'too_many_proposals', max: AGENT_OPEN_PROPOSALS },
    });
    expect(full.prisma.changeRequest.count).toHaveBeenCalledWith({
      where: { viaTokenId: 'tok_1', status: { in: ['draft', 'open'] } },
    });
    expect(full.snapshots.preview).not.toHaveBeenCalled();
    expect(full.create).not.toHaveBeenCalled();

    const room = harness(AGENT_OPEN_PROPOSALS - 1, { creates: ['invoices'] });
    await expect(room.service.proposeFromAgent(CTX, INPUT)).resolves.toMatchObject({
      changeRequestId: 'cr_1',
    });
  });

  it('a name the agent cannot see is skipped exactly like a visible one, and still proposes', async () => {
    // `payroll` exists but has no ai:use for this user; `customers` is in the agent's view.
    // The preview runs on the whole project, so both are just "already exists".
    const { service, create } = harness(0, {
      creates: ['invoices'],
      existing: ['customers', 'payroll'],
    });
    const result = await service.proposeFromAgent(CTX, {
      ...INPUT,
      sql: `${INPUT.sql}\nCREATE TABLE customers (id int);\nCREATE TABLE payroll (id int);`,
    });
    expect(result).toEqual({
      changeRequestId: 'cr_1',
      path: '/acme/p/prj_1/changes/cr_1',
      created: ['invoices'],
      skipped: ['customers', 'payroll'],
      notApplied: [],
    });
    expect(create).toHaveBeenCalledWith(CTX, expect.objectContaining({ viaTokenId: 'tok_1' }));
  });
});
