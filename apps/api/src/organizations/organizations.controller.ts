import { Controller, Get, Param, Req, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Authenticated } from '../access';
import { getPrincipal } from '../auth';
import type { ProjectSummary } from '../projects';
import { OrganizationsService } from './organizations.service';
import type { OrganizationSummary } from './organizations.types';

@ApiTags('organizations')
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

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
