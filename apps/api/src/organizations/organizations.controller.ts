import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Authenticated } from '../access';
import { getPrincipal } from '../auth';
import type { ProjectSummary } from '../projects';
import { AuditLogService, auditFilters, type AuditRow } from './audit-log.service';
import { GroupsService, type GroupView } from './groups.service';
import { MemberInvitesService, type PendingInvite } from './member-invites.service';
import { MembersService, type MemberView } from './members.service';
import {
  AddGroupMemberDto,
  AuditQueryDto,
  CreateGroupDto,
  CreateInviteDto,
  CreateOrganizationDto,
  CreateRoleDto,
  CreateWorkspaceDto,
  UpdateGroupDto,
  UpdateMemberDto,
  UpdateRoleDto,
} from './organizations.dto';
import { OrganizationsService } from './organizations.service';
import type { OrganizationSummary, WorkspaceSummary } from './organizations.types';
import { RolesService, type RoleView } from './roles.service';

@ApiTags('organizations')
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly organizations: OrganizationsService,
    private readonly roles: RolesService,
    private readonly members: MembersService,
    private readonly groups: GroupsService,
    private readonly invites: MemberInvitesService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * MARKER: `@Authenticated()` on both routes, and the alternative was considered and is
   * wrong. `@RequireOrgRole(param, roles)` compares `subject.orgId` with the locator and
   * `404`s on a mismatch, so it can only ever admit the session's ACTIVE organisation —
   * which makes it unable to express either of these routes. The list has no org
   * parameter at all, and the per-org list must answer for every org the user belongs to
   * or the switcher can never switch.
   *
   * It also produces the wrong status. `toSubject` returns `null` for a user with no
   * organisation, and every resource marker turns that into a `404`; `@Authenticated()`
   * is the marker that reaches the handler, and "you belong to nowhere yet" is an empty
   * list plus a create prompt, not an error.
   *
   * It is not a weaker gate than it looks: a share-link subject never arrives, because
   * `PermissionGuard` `404`s any route outside `SHARE_LINK_ROUTES` for a link session
   * (R21) before this marker is read. Both routes scope their answer to the caller's own
   * `OrgMember` rows, so there is no resource here for a decorator to name.
   */
  @ApiOperation({ summary: 'Organisations the signed-in user belongs to' })
  @Authenticated()
  @Get()
  async list(@Req() req: Request): Promise<OrganizationSummary[]> {
    return this.organizations.listForUser(this.userId(req));
  }

  /**
   * `@Authenticated()` for the same reason as the list: the caller this exists for is the
   * one with no organisation yet, whom every org-scoped marker would 404. The session's
   * `orgId` claim is NOT updated here — the client refreshes its session afterwards, and
   * refresh re-resolves the active org.
   */
  @ApiOperation({ summary: 'Create an organisation owned by the caller' })
  @Authenticated()
  @Post()
  async create(
    @Req() req: Request,
    @Body() dto: CreateOrganizationDto,
  ): Promise<OrganizationSummary> {
    return this.organizations.create(this.userId(req), dto.name);
  }

  /**
   * Only the projects the caller can open. The filter is `PermissionResolver`'s, applied
   * server-side over ONE batch resolve — never "return the rows and let the client sort
   * it out", which would leak every project name in the org to an area-scoped freelancer.
   */
  @ApiOperation({ summary: 'Projects in the organisation the caller may open' })
  @Authenticated()
  @Get(':orgSlug/projects')
  async projects(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
  ): Promise<ProjectSummary[]> {
    return this.organizations.listProjects(this.userId(req), orgSlug);
  }

  /** Same marker and the same membership-first rule as the project list; the role rules
   *  (doc 05 §3.2) are the service's, because no locator here names the active org. */
  @ApiOperation({ summary: 'Workspaces in the organisation' })
  @Authenticated()
  @Get(':orgSlug/workspaces')
  async workspaces(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
  ): Promise<WorkspaceSummary[]> {
    return this.organizations.listWorkspaces(this.userId(req), orgSlug);
  }

  @ApiOperation({ summary: 'Create a workspace (owner or admin)' })
  @Authenticated()
  @Post(':orgSlug/workspaces')
  async createWorkspace(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Body() dto: CreateWorkspaceDto,
  ): Promise<WorkspaceSummary> {
    return this.organizations.createWorkspace(this.userId(req), orgSlug, dto.name);
  }

  /**
   * Doc 05 §4 — custom roles. Same marker and membership-first rule as the workspace
   * routes: `@RequireOrgRole` locates an org by id and admits only the session's active
   * one, and these are addressed by slug. `RolesService` applies V1 (owner/admin) to every
   * write; the list answers any non-guest member, because the role picker needs it.
   */
  @ApiOperation({ summary: 'Built-in and custom roles of the organisation' })
  @Authenticated()
  @Get(':orgSlug/roles')
  async listRoles(@Req() req: Request, @Param('orgSlug') orgSlug: string): Promise<RoleView[]> {
    return this.roles.list(this.userId(req), orgSlug);
  }

  @ApiOperation({ summary: 'Create a custom role (owner or admin)' })
  @Authenticated()
  @Post(':orgSlug/roles')
  async createRole(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Body() dto: CreateRoleDto,
  ): Promise<RoleView> {
    return this.roles.create(this.userId(req), orgSlug, dto);
  }

  @ApiOperation({ summary: 'Edit, archive or unarchive a custom role (owner or admin)' })
  @Authenticated()
  @Patch(':orgSlug/roles/:roleId')
  async updateRole(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Param('roleId') roleId: string,
    @Body() dto: UpdateRoleDto,
  ): Promise<RoleView> {
    return this.roles.update(this.userId(req), orgSlug, roleId, dto);
  }

  @ApiOperation({ summary: 'Delete an unused custom role (owner or admin)' })
  @Authenticated()
  @HttpCode(204)
  @Delete(':orgSlug/roles/:roleId')
  async deleteRole(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Param('roleId') roleId: string,
  ): Promise<void> {
    await this.roles.remove(this.userId(req), orgSlug, roleId);
  }

  /**
   * Doc 05 §3.2 members and groups. Same marker and membership-first rule as the role
   * routes. Listing answers owner/admin/member (the §3.2 table; the §12.1 example's
   * `['owner','admin']` decorator predates it and agrees on the guest's 403); every write
   * is owner/admin, applied by the services.
   */
  /**
   * Roadmap 14 §2 — the audit log. Same marker and membership-first rule as the member
   * routes; `AuditLogService` admits owners and admins, and an admin reads only org-level
   * rows and rows of projects they can open (R13).
   */
  @ApiOperation({ summary: 'Audit log, newest first (owner or admin)' })
  @Authenticated()
  @Get(':orgSlug/audit-log')
  auditLog(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Query() query: AuditQueryDto,
  ): Promise<{ rows: AuditRow[]; nextCursor: string | null }> {
    return this.audit.page(this.userId(req), orgSlug, auditFilters(query));
  }

  @ApiOperation({ summary: 'The audit log as CSV, same filters (owner or admin)' })
  @Authenticated()
  @Get(':orgSlug/audit-log.csv')
  async auditCsv(
    @Req() req: Request,
    @Res() res: Response,
    @Param('orgSlug') orgSlug: string,
    @Query() query: AuditQueryDto,
  ): Promise<void> {
    const lines = this.audit.csv(this.userId(req), orgSlug, auditFilters(query));
    // The first line comes after the role check, so a refusal is still a plain status.
    const first = await lines.next();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${orgSlug}.csv"`);
    if (first.done !== true) res.write(first.value);
    for await (const line of lines) res.write(line);
    res.end();
  }

  @ApiOperation({ summary: 'Members of the organisation with their org role' })
  @Authenticated()
  @Get(':orgSlug/members')
  async listMembers(@Req() req: Request, @Param('orgSlug') orgSlug: string): Promise<MemberView[]> {
    return this.members.list(this.userId(req), orgSlug);
  }

  @ApiOperation({ summary: 'Change a member’s org role (owner or admin; owners only for owners)' })
  @Authenticated()
  @Patch(':orgSlug/members/:userId')
  async updateMember(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Param('userId') userId: string,
    @Body() dto: UpdateMemberDto,
  ): Promise<MemberView> {
    return this.members.setRole(this.userId(req), orgSlug, userId, dto.role);
  }

  @ApiOperation({ summary: 'Remove a member from the organisation (owner or admin)' })
  @Authenticated()
  @HttpCode(204)
  @Delete(':orgSlug/members/:userId')
  async removeMember(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Param('userId') userId: string,
  ): Promise<void> {
    await this.members.remove(this.userId(req), orgSlug, userId);
  }

  /**
   * Roadmap 16 — org invites. Same marker and membership-first rule as the member routes;
   * `MemberInvitesService` applies owner/admin, and owners-only for an owner invite.
   */
  @ApiOperation({ summary: 'Pending org invitations (owner or admin)' })
  @Authenticated()
  @Get(':orgSlug/invitations')
  async listInvites(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
  ): Promise<PendingInvite[]> {
    return this.invites.list(this.userId(req), orgSlug);
  }

  @ApiOperation({ summary: 'Invite someone to the organisation by email (owner or admin)' })
  @Authenticated()
  @Post(':orgSlug/invitations')
  async createInvite(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Body() dto: CreateInviteDto,
  ): Promise<PendingInvite> {
    return this.invites.create(this.userId(req), orgSlug, dto.email, dto.role);
  }

  @ApiOperation({ summary: 'Send an org invitation again with a new link (owner or admin)' })
  @Authenticated()
  @HttpCode(200)
  @Post(':orgSlug/invitations/:invitationId/resend')
  async resendInvite(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Param('invitationId') invitationId: string,
  ): Promise<PendingInvite> {
    return this.invites.resend(this.userId(req), orgSlug, invitationId);
  }

  @ApiOperation({ summary: 'Revoke an org invitation (owner or admin)' })
  @Authenticated()
  @HttpCode(204)
  @Delete(':orgSlug/invitations/:invitationId')
  async revokeInvite(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Param('invitationId') invitationId: string,
  ): Promise<void> {
    await this.invites.revoke(this.userId(req), orgSlug, invitationId);
  }

  @ApiOperation({ summary: 'Groups of the organisation with their members' })
  @Authenticated()
  @Get(':orgSlug/groups')
  async listGroups(@Req() req: Request, @Param('orgSlug') orgSlug: string): Promise<GroupView[]> {
    return this.groups.list(this.userId(req), orgSlug);
  }

  @ApiOperation({ summary: 'Create a group (owner or admin)' })
  @Authenticated()
  @Post(':orgSlug/groups')
  async createGroup(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Body() dto: CreateGroupDto,
  ): Promise<GroupView> {
    return this.groups.create(this.userId(req), orgSlug, dto);
  }

  @ApiOperation({ summary: 'Rename or describe a group (owner or admin)' })
  @Authenticated()
  @Patch(':orgSlug/groups/:groupId')
  async updateGroup(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Param('groupId') groupId: string,
    @Body() dto: UpdateGroupDto,
  ): Promise<GroupView> {
    return this.groups.update(this.userId(req), orgSlug, groupId, dto);
  }

  @ApiOperation({ summary: 'Delete a group and its grants (owner or admin)' })
  @Authenticated()
  @HttpCode(204)
  @Delete(':orgSlug/groups/:groupId')
  async deleteGroup(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Param('groupId') groupId: string,
  ): Promise<void> {
    await this.groups.remove(this.userId(req), orgSlug, groupId);
  }

  @ApiOperation({ summary: 'Add an org member to a group (owner or admin)' })
  @Authenticated()
  @Post(':orgSlug/groups/:groupId/members')
  async addGroupMember(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Param('groupId') groupId: string,
    @Body() dto: AddGroupMemberDto,
  ): Promise<GroupView> {
    return this.groups.addMember(this.userId(req), orgSlug, groupId, dto.userId);
  }

  @ApiOperation({ summary: 'Remove a user from a group (owner or admin)' })
  @Authenticated()
  @HttpCode(204)
  @Delete(':orgSlug/groups/:groupId/members/:userId')
  async removeGroupMember(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Param('groupId') groupId: string,
    @Param('userId') userId: string,
  ): Promise<void> {
    await this.groups.removeMember(this.userId(req), orgSlug, groupId, userId);
  }

  /**
   * `getPrincipal`, not `getSubject`: a `Subject` requires an `orgId`, and the user this
   * route exists for is precisely the one who has none yet.
   *
   * Unreachable behind `JwtAuthGuard`; kept because a handler that trusts a guard is a
   * handler that opens a route the day that guard moves.
   */
  private userId(req: Request): string {
    const principal = getPrincipal(req);
    if (principal?.kind !== 'user') {
      throw new UnauthorizedException({ code: 'NOT_AUTHENTICATED' });
    }
    return principal.userId;
  }
}
