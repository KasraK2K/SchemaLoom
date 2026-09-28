import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BUILT_IN_ROLE_ORDER,
  PERMISSION_ATOMS,
  closeAtoms,
  type OrgRole,
  type PermissionAtom,
} from '@schemaloom/contracts';
import { PermissionResolver } from '../access';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { slugify } from './organizations.service';
import type { CreateRoleDto, UpdateRoleDto } from './organizations.dto';

const UNIQUE_VIOLATION = 'P2002';

export interface RoleView {
  id: string;
  key: string;
  name: string;
  description: string | null;
  atoms: string[];
  builtIn: boolean;
  archived: boolean;
}

/** Doc 05 §3.2 — custom roles are managed by owners and admins. A non-member gets the
 *  same 404 as a missing org. */
export function assertRoleAdmin(orgRole: OrgRole | null): void {
  if (orgRole === null) throw new NotFoundException({ code: 'not_found' });
  if (orgRole !== 'owner' && orgRole !== 'admin') {
    throw new ForbiddenException({ code: 'forbidden_org_role', required: ['owner', 'admin'] });
  }
}

/**
 * Doc 05 §4.2, V1-V4, in that order. V1 first: never validate input on behalf of someone
 * who may not be here. The stored array is closed (R1), deduplicated and in
 * `PERMISSION_ATOMS` order, so two roles with the same atoms compare equal.
 */
export function validateCustomRole(
  input: { atoms: readonly string[] },
  orgRole: OrgRole | null,
): PermissionAtom[] {
  assertRoleAdmin(orgRole); // V1
  const known = PERMISSION_ATOMS as readonly string[];
  const unknown = input.atoms.filter((a) => !known.includes(a));
  if (unknown.length > 0) throw new BadRequestException({ code: 'unknown_atom', unknown }); // V2
  const atoms = [...closeAtoms(input.atoms as PermissionAtom[])].sort(
    (a, b) => known.indexOf(a) - known.indexOf(b),
  ); // V3
  if (atoms.length === 0) throw new BadRequestException({ code: 'empty_role' }); // V4
  return atoms;
}

/**
 * Doc 05 §4 (R3) — org-scoped custom roles. Built-in rows are immutable and belong to no
 * org, so every lookup here is `organizationId = this org` and a built-in id is a 404.
 *
 * Atom edits and deletes bump `Organization.permGeneration` in the same transaction
 * (§9.3): a role is shared by every grant that names it, across every project in the org.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
  ) {}

  /**
   * Built-ins in R2 order, then custom roles by name. Owners and admins also see archived
   * roles (to unarchive them); members see what the pickers offer. A guest's access is
   * grant-only and it never shares, so a guest — like a non-member — gets `[]`.
   */
  async list(userId: string, orgSlug: string): Promise<RoleView[]> {
    const member = await this.membership(userId, orgSlug);
    if (member === null || member.role === 'guest') return [];
    const admin = member.role === 'owner' || member.role === 'admin';
    const rows = await this.prisma.role.findMany({
      where: {
        OR: [
          { organizationId: null, isBuiltIn: true },
          { organizationId: member.organizationId, ...(admin ? {} : { isArchived: false }) },
        ],
      },
      select: ROLE,
      orderBy: { name: 'asc' },
    });
    const order = BUILT_IN_ROLE_ORDER as readonly string[];
    const builtIns = rows
      .filter((r) => r.isBuiltIn && order.includes(r.key))
      .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    return [...builtIns, ...rows.filter((r) => !r.isBuiltIn)].map(toView);
  }

  async create(userId: string, orgSlug: string, dto: CreateRoleDto): Promise<RoleView> {
    const { organizationId, role: orgRole } = await this.admin(userId, orgSlug);
    const atoms = validateCustomRole(dto, orgRole);

    // A custom key must never shadow a built-in one: grant writes look roles up by key.
    const slug = slugify(dto.name);
    const base = slug === '' || (BUILT_IN_ROLE_ORDER as readonly string[]).includes(slug) ? `${slug || 'role'}-custom` : slug;
    for (let attempt = 0; ; attempt++) {
      const key = attempt === 0 ? base : `${base}-${randomBytes(3).toString('hex')}`;
      try {
        return await this.prisma.$transaction(async (tx) => {
          const role = await tx.role.create({
            data: { organizationId, key, name: dto.name, description: dto.description ?? null, atoms },
            select: ROLE,
          });
          await audit(tx, organizationId, userId, 'role.created', role.id, { key, atoms });
          return toView(role);
        });
      } catch (error) {
        if ((error as { code?: unknown }).code !== UNIQUE_VIOLATION) throw error;
        // `roles_custom_name_uq` and `roles_custom_key_uq` both surface as P2002. A name
        // clash is the caller's to fix; a key clash is ours, so retry with a suffix.
        if (await this.nameTaken(organizationId, dto.name)) {
          throw new ConflictException({ code: 'role_name_taken' });
        }
        if (attempt >= 3) throw error;
      }
    }
  }

  /** Name, description, atoms and archival. The key is stable: it is what grants send. */
  async update(userId: string, orgSlug: string, roleId: string, dto: UpdateRoleDto): Promise<RoleView> {
    const { organizationId, role: orgRole } = await this.admin(userId, orgSlug);
    const atoms = dto.atoms === undefined ? undefined : validateCustomRole({ atoms: dto.atoms }, orgRole);
    const before = await this.customRole(organizationId, roleId);
    const atomsChanged = atoms !== undefined && atoms.join() !== before.atoms.join();

    let after;
    try {
      after = await this.prisma.$transaction(async (tx) => {
        const role = await tx.role.update({
          where: { id: roleId },
          data: {
            name: dto.name,
            description: dto.description,
            atoms,
            isArchived: dto.archived,
          },
          select: ROLE,
        });
        if (atomsChanged) {
          await tx.organization.update({
            where: { id: organizationId },
            data: { permGeneration: { increment: 1 } },
          });
        }
        await audit(tx, organizationId, userId, 'role.updated', roleId, {
          before: toView(before) as unknown as Prisma.InputJsonValue,
          after: toView(role) as unknown as Prisma.InputJsonValue,
        });
        return role;
      });
    } catch (error) {
      if ((error as { code?: unknown }).code === UNIQUE_VIOLATION) {
        throw new ConflictException({ code: 'role_name_taken' });
      }
      throw error;
    }
    if (atomsChanged) await this.resolver.invalidate({ org: organizationId });
    return toView(after);
  }

  /**
   * Refused while any grant names the role (`access_grants.role_id` is NO ACTION, doc 02
   * §8.6): deleting would have to delete access nobody reviewed. The 409 says how many and
   * offers Archive, which retires the role without touching anyone's access.
   *
   * ponytail: count-then-delete. A grant attached in between fails the FK at commit and
   * surfaces as a 500; a row lock on the role would close it if that ever happens.
   */
  async remove(userId: string, orgSlug: string, roleId: string): Promise<void> {
    const { organizationId } = await this.admin(userId, orgSlug);
    const role = await this.customRole(organizationId, roleId);

    await this.prisma.$transaction(async (tx) => {
      const grants = await tx.accessGrant.count({ where: { roleId } });
      if (grants > 0) throw new ConflictException({ code: 'role_in_use', grants, remedy: 'archive' });
      await tx.role.delete({ where: { id: roleId } });
      await tx.organization.update({
        where: { id: organizationId },
        data: { permGeneration: { increment: 1 } },
      });
      await audit(tx, organizationId, userId, 'role.deleted', roleId, { key: role.key, atoms: role.atoms });
    });
    await this.resolver.invalidate({ org: organizationId });
  }

  private async customRole(organizationId: string, roleId: string) {
    const role = await this.prisma.role.findFirst({ where: { id: roleId, organizationId }, select: ROLE });
    if (role === null) throw new NotFoundException({ code: 'not_found', resourceType: 'role', id: roleId });
    return role;
  }

  private async nameTaken(organizationId: string, name: string): Promise<boolean> {
    const clash = await this.prisma.role.findFirst({
      where: { organizationId, name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
    return clash !== null;
  }

  /** V1 for every write: the caller's membership, owner or admin, or the 404/403. */
  private async admin(userId: string, orgSlug: string): Promise<{ organizationId: string; role: OrgRole }> {
    const member = await this.membership(userId, orgSlug);
    if (member === null) throw new NotFoundException({ code: 'not_found' });
    assertRoleAdmin(member.role);
    return member;
  }

  private membership(userId: string, orgSlug: string) {
    return this.prisma.orgMember.findFirst({
      where: { userId, organization: { slug: orgSlug, deletedAt: null } },
      select: { organizationId: true, role: true },
    });
  }
}

const ROLE = {
  id: true,
  key: true,
  name: true,
  description: true,
  atoms: true,
  isBuiltIn: true,
  isArchived: true,
} as const;

function toView(r: {
  id: string;
  key: string;
  name: string;
  description: string | null;
  atoms: string[];
  isBuiltIn: boolean;
  isArchived: boolean;
}): RoleView {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    atoms: r.atoms,
    builtIn: r.isBuiltIn,
    archived: r.isArchived,
  };
}

function audit(
  tx: Prisma.TransactionClient,
  organizationId: string,
  actorUserId: string,
  action: string,
  roleId: string,
  metadata: Prisma.InputJsonValue,
): Promise<unknown> {
  return tx.auditLog.create({
    data: { organizationId, actorUserId, action, resourceType: 'role', resourceId: roleId, metadata },
  });
}
