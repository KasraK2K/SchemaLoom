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
import type { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Authenticated, RequirePermission } from '../access';
import { getSubject } from '../auth';
import { OrgTemplatesService, type OrgTemplateView } from './org-templates.service';
import { snapshotContext } from './snapshots.controller';

const name = z.string().trim().min(1).max(200);
const summary = z.string().trim().max(2000);

export const saveOrgTemplateSchema = z
  .object({
    name,
    summary: summary.optional(),
    includeDocs: z.boolean().default(true),
    includeLayout: z.boolean().default(true),
    replaceId: z.string().min(1).max(64).optional(),
  })
  .strict();
export class SaveOrgTemplateDto extends createZodDto(saveOrgTemplateSchema) {}

export const updateOrgTemplateSchema = z.object({ name, summary }).partial().strict();
export class UpdateOrgTemplateDto extends createZodDto(updateOrgTemplateSchema) {}

/**
 * Roadmap 12c §2.3. Saving names a project, so it carries that project's marker
 * (`sharing:manage`; the service adds the complete-view check). The org routes are
 * addressed by slug, so they are `@Authenticated()` and the service checks membership,
 * like the role routes. None is in `SHARE_LINK_ROUTES`.
 */
@ApiTags('org-templates')
@Controller()
export class OrgTemplatesController {
  constructor(private readonly templates: OrgTemplatesService) {}

  @ApiOperation({ summary: 'Save the project as an org template, or replace one saved from it' })
  @RequirePermission('sharing:manage', { project: 'projectId' })
  @Post('projects/:projectId/save-as-template')
  save(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: SaveOrgTemplateDto,
  ): Promise<OrgTemplateView> {
    return this.templates.save(snapshotContext(req, projectId), body);
  }

  @ApiOperation({ summary: "The org's templates, without their models ([] for a guest)" })
  @Authenticated()
  @Get('organizations/:orgSlug/templates')
  list(@Req() req: Request, @Param('orgSlug') orgSlug: string): Promise<OrgTemplateView[]> {
    return this.templates.list(userId(req), orgSlug);
  }

  @ApiOperation({ summary: 'Rename a template (its saver, owners and admins)' })
  @Authenticated()
  @Patch('organizations/:orgSlug/templates/:id')
  update(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Param('id') id: string,
    @Body() body: UpdateOrgTemplateDto,
  ): Promise<OrgTemplateView> {
    return this.templates.update(userId(req), orgSlug, id, body);
  }

  @ApiOperation({ summary: 'Delete a template (its saver, owners and admins)' })
  @Authenticated()
  @HttpCode(204)
  @Delete('organizations/:orgSlug/templates/:id')
  async remove(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.templates.remove(userId(req), orgSlug, id);
  }
}

function userId(req: Request): string {
  const subject = getSubject(req);
  if (subject?.kind !== 'user') throw new ForbiddenException({ code: 'route_not_classified' });
  return subject.userId;
}
