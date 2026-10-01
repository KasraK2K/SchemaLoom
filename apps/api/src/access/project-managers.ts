import type { PrismaService } from '../prisma/prisma.service';
import type { PermissionResolver } from './permission-resolver.service';
import { splitPrincipalKey, type ResourceRef } from './types';

/**
 * The users who hold `sharing:manage` on `ref` (the project by default): who approves an
 * access request (doc 05 §7.13) and who hears about drift (Phase 6d). Falls back to the org's
 * owners when nobody holds it. Owners only: an admin may not be able to see this project (R13
 * is owner-only), and telling them it exists would be the disclosure the resolver prevented.
 */
export async function projectManagers(
  resolver: PermissionResolver,
  prisma: PrismaService,
  projectId: string,
  organizationId: string,
  ref: ResourceRef = { type: 'project', id: projectId },
): Promise<string[]> {
  const byPrincipal = await resolver.resolveResource(projectId, ref);
  const users = [...byPrincipal]
    .filter(([, atoms]) => atoms.has('sharing:manage'))
    .map(([key]) => splitPrincipalKey(key))
    .filter((p) => p.kind === 'user')
    .map((p) => p.id);
  if (users.length > 0) return users;
  const owners = await prisma.orgMember.findMany({
    where: { organizationId, role: 'owner' },
    select: { userId: true },
  });
  return owners.map((o) => o.userId);
}
