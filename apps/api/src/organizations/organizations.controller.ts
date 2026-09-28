import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Authenticated } from '../access';
import { getPrincipal } from '../auth';
import type { ProjectSummary } from '../projects';
import {
  CreateOrganizationDto,
  CreateRoleDto,
  CreateWorkspaceDto,
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
