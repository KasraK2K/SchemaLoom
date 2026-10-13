import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Authenticated, RequirePermission, RequireProjectAccess } from '../access';
import { getPrincipal, getSubject } from '../auth';
import { PrismaService } from '../prisma/prisma.service';
import { AI_ABILITIES, isAiAbility, type AiAbility } from './abilities';
import {
  ChoiceDto,
  CreateIntegrationDto,
  GrantDto,
  MyChoiceDto,
  UpdateIntegrationDto,
} from './ai-integrations.dto';
import {
  AiIntegrationsService,
  type ChoiceView,
  type GrantView,
  type IntegrationView,
  type MeChoicesView,
} from './ai-integrations.service';
import { AiRouter } from './ai-router.service';

/**
 * Roadmap 24 §5.1 — AI integrations, grants and ability choices. Org routes are addressed by
 * slug, so they are `@Authenticated()` and `AiIntegrationsService` admits owners and admins,
 * answering 404 to anyone else; `/me` routes only ever touch the caller's own rows.
 */
@ApiTags('ai-integrations')
@Controller('organizations/:orgSlug/ai')
export class OrgAiIntegrationsController {
  constructor(private readonly svc: AiIntegrationsService) {}

  private owner(req: Request, orgSlug: string) {
    return { kind: 'org' as const, userId: userIdOf(req), orgSlug };
  }

  @ApiOperation({ summary: 'The org’s AI integrations, no keys (owner/admin)' })
  @Authenticated()
  @Get('integrations')
  list(@Req() req: Request, @Param('orgSlug') orgSlug: string): Promise<IntegrationView[]> {
    return this.svc.list(this.owner(req, orgSlug));
  }

  @ApiOperation({ summary: 'Add an AI integration (owner/admin)' })
  @Authenticated()
  @Post('integrations')
  create(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Body() body: CreateIntegrationDto,
  ): Promise<IntegrationView> {
    return this.svc.create(this.owner(req, orgSlug), body);
  }

  @ApiOperation({ summary: 'Edit or rotate the key of an AI integration (owner/admin)' })
  @Authenticated()
  @Patch('integrations/:id')
  update(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Param('id') id: string,
    @Body() body: UpdateIntegrationDto,
  ): Promise<IntegrationView> {
    return this.svc.update(this.owner(req, orgSlug), id, body);
  }

  @ApiOperation({ summary: 'Delete an AI integration (owner/admin)' })
  @Authenticated()
  @HttpCode(204)
  @Delete('integrations/:id')
  async remove(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.svc.remove(this.owner(req, orgSlug), id);
  }

  @ApiOperation({ summary: 'Probe an AI integration and refresh its status (owner/admin)' })
  @Authenticated()
  @HttpCode(200)
  @Post('integrations/:id/test')
  test(@Req() req: Request, @Param('orgSlug') orgSlug: string, @Param('id') id: string) {
    return this.svc.test(this.owner(req, orgSlug), id);
  }

  @ApiOperation({ summary: 'Who may use an AI integration (owner/admin)' })
  @Authenticated()
  @Get('integrations/:id/grants')
  grants(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Param('id') id: string,
  ): Promise<GrantView[]> {
    return this.svc.listGrants(userIdOf(req), orgSlug, id);
  }

  @ApiOperation({ summary: 'Grant an AI integration to the org, a project or a user' })
  @Authenticated()
  @Post('integrations/:id/grants')
  addGrant(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Param('id') id: string,
    @Body() body: GrantDto,
  ): Promise<GrantView> {
    return this.svc.addGrant(userIdOf(req), orgSlug, id, body);
  }

  @ApiOperation({ summary: 'Revoke a grant' })
  @Authenticated()
  @HttpCode(204)
  @Delete('integrations/:id/grants/:grantId')
  async removeGrant(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Param('id') id: string,
    @Param('grantId') grantId: string,
  ): Promise<void> {
    await this.svc.removeGrant(userIdOf(req), orgSlug, id, grantId);
  }

  @ApiOperation({ summary: 'The org-level ability choices (owner/admin)' })
  @Authenticated()
  @Get('choices')
  async choices(@Req() req: Request, @Param('orgSlug') orgSlug: string): Promise<ChoiceView[]> {
    return this.svc.listChoices({
      kind: 'org',
      userId: userIdOf(req),
      orgSlug,
    });
  }

  @ApiOperation({ summary: 'Set an org-level ability choice (owner/admin)' })
  @Authenticated()
  @Put('choices')
  putChoice(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Body() body: ChoiceDto,
  ): Promise<ChoiceView> {
    return this.svc.putChoice({ kind: 'org', userId: userIdOf(req), orgSlug }, body);
  }

  @ApiOperation({ summary: 'Clear an org-level ability choice (owner/admin)' })
  @Authenticated()
  @HttpCode(204)
  @Delete('choices')
  async clearChoice(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Query('ability') ability: string,
  ): Promise<void> {
    await this.svc.clearChoice({ kind: 'org', userId: userIdOf(req), orgSlug }, abilityOf(ability));
  }
}

@ApiTags('ai-integrations')
@Controller('me/ai')
export class MyAiIntegrationsController {
  constructor(private readonly svc: AiIntegrationsService) {}

  @ApiOperation({ summary: 'The caller’s personal AI integrations, no keys' })
  @Authenticated()
  @Get('integrations')
  list(@Req() req: Request): Promise<IntegrationView[]> {
    return this.svc.list({ kind: 'me', userId: userIdOf(req) });
  }

  @ApiOperation({ summary: 'Add a personal AI integration' })
  @Authenticated()
  @Post('integrations')
  create(@Req() req: Request, @Body() body: CreateIntegrationDto): Promise<IntegrationView> {
    return this.svc.create({ kind: 'me', userId: userIdOf(req) }, body);
  }

  @ApiOperation({ summary: 'Edit or rotate the key of a personal AI integration' })
  @Authenticated()
  @Patch('integrations/:id')
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: UpdateIntegrationDto,
  ): Promise<IntegrationView> {
    return this.svc.update({ kind: 'me', userId: userIdOf(req) }, id, body);
  }

  @ApiOperation({ summary: 'Delete a personal AI integration' })
  @Authenticated()
  @HttpCode(204)
  @Delete('integrations/:id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<void> {
    await this.svc.remove({ kind: 'me', userId: userIdOf(req) }, id);
  }

  @ApiOperation({ summary: 'Probe a personal AI integration and refresh its status' })
  @Authenticated()
  @HttpCode(200)
  @Post('integrations/:id/test')
  test(@Req() req: Request, @Param('id') id: string) {
    return this.svc.test({ kind: 'me', userId: userIdOf(req) }, id);
  }

  @ApiOperation({ summary: 'The caller’s ability choices and the integrations they may pick' })
  @Authenticated()
  @Get('choices')
  async choices(
    @Req() req: Request,
    @Query('orgSlug') orgSlug: string,
    @Query('projectId') projectId?: string,
  ): Promise<MeChoicesView> {
    return this.svc.listChoices({
      kind: 'me',
      userId: userIdOf(req),
      orgSlug: requiredQuery(orgSlug, 'orgSlug'),
      projectId: projectId ?? null,
    });
  }

  @ApiOperation({ summary: 'Set one of the caller’s ability choices' })
  @Authenticated()
  @Put('choices')
  putChoice(@Req() req: Request, @Body() { orgSlug, projectId, ...choice }: MyChoiceDto) {
    return this.svc.putChoice({ kind: 'me', userId: userIdOf(req), orgSlug, projectId }, choice);
  }

  @ApiOperation({ summary: 'Clear one of the caller’s ability choices' })
  @Authenticated()
  @HttpCode(204)
  @Delete('choices')
  async clearChoice(
    @Req() req: Request,
    @Query('orgSlug') orgSlug: string,
    @Query('ability') ability: string,
    @Query('projectId') projectId?: string,
  ): Promise<void> {
    await this.svc.clearChoice(
      {
        kind: 'me',
        userId: userIdOf(req),
        orgSlug: requiredQuery(orgSlug, 'orgSlug'),
        projectId: projectId ?? null,
      },
      abilityOf(ability),
    );
  }
}

@ApiTags('ai-integrations')
@Controller('projects/:projectId/ai')
export class ProjectAiController {
  constructor(
    private readonly svc: AiIntegrationsService,
    private readonly router: AiRouter,
    private readonly prisma: PrismaService,
  ) {}

  @ApiOperation({ summary: 'The project-level ability choices (sharing:manage)' })
  @RequirePermission('sharing:manage', { project: 'projectId' })
  @Get('choices')
  async choices(@Req() req: Request, @Param('projectId') projectId: string): Promise<ChoiceView[]> {
    return this.svc.listChoices({
      kind: 'project',
      userId: userIdOf(req),
      projectId,
    });
  }

  @ApiOperation({ summary: 'Set a project-level ability choice (sharing:manage)' })
  @RequirePermission('sharing:manage', { project: 'projectId' })
  @Put('choices')
  putChoice(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: ChoiceDto,
  ): Promise<ChoiceView> {
    return this.svc.putChoice({ kind: 'project', userId: userIdOf(req), projectId }, body);
  }

  @ApiOperation({ summary: 'Clear a project-level ability choice (sharing:manage)' })
  @RequirePermission('sharing:manage', { project: 'projectId' })
  @HttpCode(204)
  @Delete('choices')
  async clearChoice(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Query('ability') ability: string,
  ): Promise<void> {
    await this.svc.clearChoice(
      { kind: 'project', userId: userIdOf(req), projectId },
      abilityOf(ability),
    );
  }

  @ApiOperation({ summary: 'The models the caller may pick for each ability in this project' })
  @RequireProjectAccess('projectId')
  @Get('options')
  async options(@Req() req: Request, @Param('projectId') projectId: string) {
    // A share-link subject passes the project marker but has no AI surface.
    if (getSubject(req)?.kind !== 'user') throw new NotFoundException({ code: 'not_found' });
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { organizationId: true },
    });
    if (project === null) throw new NotFoundException({ code: 'not_found' });
    return this.router.options(userIdOf(req), projectId, project.organizationId);
  }
}

@ApiTags('ai-integrations')
@Controller('ai')
export class AiAbilitiesController {
  @ApiOperation({ summary: 'Every server-side AI ability' })
  @Authenticated()
  @Get('abilities')
  list(): { abilities: typeof AI_ABILITIES } {
    return { abilities: AI_ABILITIES };
  }
}

function userIdOf(req: Request): string {
  const principal = getPrincipal(req);
  if (principal?.kind !== 'user') throw new UnauthorizedException({ code: 'NOT_AUTHENTICATED' });
  return principal.userId;
}

function abilityOf(ability: string): AiAbility {
  if (!isAiAbility(ability)) throw new BadRequestException({ code: 'invalid_ability' });
  return ability;
}

function requiredQuery(value: string | undefined, name: string): string {
  if (!value) throw new BadRequestException({ code: `${name}_required` });
  return value;
}
