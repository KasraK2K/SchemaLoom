import { Body, Controller, ForbiddenException, Get, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { OrgRole } from '@schemaloom/contracts';
import type { Request } from 'express';
import { RequireOrgRole, RequireProjectAccess, getAccessContext } from '../access';
import { getSubject } from '../auth';
import type { ProjectDetail } from './project-views';
import { CreateProjectDto } from './projects.dto';
import { ProjectsService } from './projects.service';

/**
 * Doc 05 §3.2's project-creation row: owner, admin and member — **not guest**. A guest is
 * a normal user whose access comes entirely from grants (R9/§3.2), and a principal who
 * can mint a project becomes `manager` on it, which would hand a guest an org-scoped
 * capability the whole guest role exists to withhold.
 */
const MAY_CREATE_PROJECT: readonly OrgRole[] = ['owner', 'admin', 'member'];

@ApiTags('projects')
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  /**
   * MARKER: `@RequireProjectAccess('projectId')`, and it is not a free choice.
   * `GET /projects/:id` is in `SHARE_LINK_ROUTES` (R21) — it is "the shell: name, engine
   * badge, terminology" — and the boot sweep REFUSES TO START a process in which an
   * allow-listed route is org-gated or `@Public()`. It also happens to be the right
   * marker on its own terms: §7.9 names this route as one `canOpenProject` gates, because
   * the freelancer with only an area grant holds no project-level `schema:view` and must
   * still be able to open the project.
   *
   * The guard resolved the map and attached it, so the handler adds one row read and no
   * second resolve (§10.4). It reads NO schema content, which is what makes it safe for a
   * link holder: `ProjectDetail` carries the name, the engine and the caller's own atoms.
   */
  @ApiOperation({ summary: 'Project shell: name, engine badge and the caller’s access' })
  @RequireProjectAccess('projectId')
  @Get(':projectId')
  async detail(
    @Req() req: Request,
    @Param('projectId') projectId: string,
  ): Promise<ProjectDetail> {
    const context = getAccessContext(req);
    if (context?.projectId !== projectId) {
      throw new ForbiddenException({ code: 'route_not_classified' });
    }
    return this.projects.detail(projectId, context.map);
  }

  /**
   * MARKER: `@RequireOrgRole('body.organizationId', …)`. Creation names no project — the
   * project does not exist yet — so there is nothing for `@RequirePermission` or
   * `@RequireProjectAccess` to resolve against, and §10.2 reserves `@RequireOrgRole` for
   * exactly this: org-scoped administration, never a project resource.
   *
   * The locator reads the BODY, which `readLocatorId` supports and body-parser has
   * already populated (middleware runs before guards). One consequence is worth stating
   * because it is the guard's rule and not this route's: `checkOrgRole` requires
   * `subject.orgId === organizationId`, so a project is created in the session's ACTIVE
   * organisation. Switching orgs is a session concern, not a body field.
   */
  @ApiOperation({ summary: 'Create a project in a workspace' })
  @RequireOrgRole('body.organizationId', MAY_CREATE_PROJECT)
  @Post()
  async create(@Req() req: Request, @Body() body: CreateProjectDto): Promise<ProjectDetail> {
    const subject = getSubject(req);
    // A share-link subject cannot reach an org-gated route at all (the guard 404s it
    // before this runs); the narrowing is what gives us a `userId` to own the grant.
    if (subject?.kind !== 'user') {
      throw new ForbiddenException({ code: 'route_not_classified' });
    }
    return this.projects.create(body, subject.userId);
  }
}
