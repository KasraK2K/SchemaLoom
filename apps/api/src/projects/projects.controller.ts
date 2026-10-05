import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { OrgRole } from '@schemaloom/contracts';
import type { Request } from 'express';
import {
  RequireOrgRole,
  RequirePermission,
  RequireProjectAccess,
  getAccessContext,
} from '../access';
import { getSubject } from '../auth';
import { userSubject } from '../sharing/access-write';
import { OrgTemplatesService } from '../snapshots';
import type { ProjectDetail } from './project-views';
import {
  CreateProjectDto,
  ProjectSettingsPatchDto,
  RequireChangeRequestsDto,
  RestrictedFieldModeDto,
  UpdateProjectDto,
} from './projects.dto';
import { ProjectsService, type ProjectSettingsView } from './projects.service';

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
  constructor(
    private readonly projects: ProjectsService,
    private readonly templates: OrgTemplatesService,
  ) {}

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
  async detail(@Req() req: Request, @Param('projectId') projectId: string): Promise<ProjectDetail> {
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
    if (body.orgTemplateId === undefined) return this.projects.create(body, subject.userId);
    // Roadmap 12c: checked before the project exists, filled right after it does.
    const template = await this.templates.forCreate(body.organizationId, body.orgTemplateId);
    const project = await this.projects.create(
      {
        organizationId: body.organizationId,
        workspaceId: body.workspaceId,
        name: body.name,
        description: body.description,
        engineId: template.engineId,
        engineVersion: template.engineVersion,
      },
      subject.userId,
    );
    await this.templates.fill(subject, project.id, template);
    return project;
  }

  /**
   * MARKER: `@RequirePermission('sharing:manage')` at the project. Doc 05 names no atom
   * for project administration; `sharing:manage` is the one only a project's manager (and
   * org owner/admin, R13) holds, which is who may already decide who sees the project at
   * all. Not share-link reachable: neither route is in `SHARE_LINK_ROUTES`.
   */
  @ApiOperation({ summary: 'Rename a project' })
  @RequirePermission('sharing:manage', { project: 'projectId' })
  @Patch(':projectId')
  async update(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: UpdateProjectDto,
  ): Promise<ProjectDetail> {
    const context = getAccessContext(req);
    if (context?.projectId !== projectId) {
      throw new ForbiddenException({ code: 'route_not_classified' });
    }
    await this.projects.rename(projectId, body.name);
    return this.projects.detail(projectId, context.map);
  }

  /**
   * Project settings: restricted-field mode and the AI toggles. `sharing:manage` at the
   * project (doc 05 §2.2 names it for `restrictedFieldMode`; the AI kill switch sits with
   * it, Phase 5 DESIGN §4.2). Kept off `GET /projects/:id`, which a share link can read.
   */
  @ApiOperation({ summary: 'Project settings (restricted-field mode, AI toggles)' })
  @RequirePermission('sharing:manage', { project: 'projectId' })
  @Get(':projectId/settings')
  settings(@Param('projectId') projectId: string): Promise<ProjectSettingsView> {
    return this.projects.settings(projectId);
  }

  @ApiOperation({ summary: 'Change the AI toggles' })
  @RequirePermission('sharing:manage', { project: 'projectId' })
  @Patch(':projectId/settings')
  updateSettings(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: ProjectSettingsPatchDto,
  ): Promise<ProjectSettingsView> {
    return this.projects.updateSettings(userSubject(getSubject(req)), projectId, body);
  }

  @ApiOperation({ summary: 'Mask or hide restricted fields for viewers without the toggle' })
  @RequirePermission('sharing:manage', { project: 'projectId' })
  @Patch(':projectId/restricted-field-mode')
  setRestrictedFieldMode(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: RestrictedFieldModeDto,
  ): Promise<ProjectSettingsView> {
    return this.projects.setRestrictedFieldMode(userSubject(getSubject(req)), projectId, body.mode);
  }

  @ApiOperation({ summary: 'Require change requests for every schema change (Phase 10b)' })
  @RequirePermission('sharing:manage', { project: 'projectId' })
  @Patch(':projectId/require-change-requests')
  setRequireChangeRequests(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: RequireChangeRequestsDto,
  ): Promise<ProjectSettingsView> {
    return this.projects.setRequireChangeRequests(
      userSubject(getSubject(req)),
      projectId,
      body.enabled,
    );
  }

  /** Soft delete (C8 tombstone). The resolver skips tombstoned projects, so every route
   *  answers 404 for it from the next request on, share links included. */
  @ApiOperation({ summary: 'Delete a project' })
  @RequirePermission('sharing:manage', { project: 'projectId' })
  @HttpCode(204)
  @Delete(':projectId')
  async remove(@Param('projectId') projectId: string): Promise<void> {
    await this.projects.softDelete(projectId);
  }
}
