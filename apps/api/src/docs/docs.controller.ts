import { Body, Controller, ForbiddenException, Get, Param, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequireProjectAccess, getAccessContext, type ProjectPermissionMap, type Subject } from '../access';
import { getSubject } from '../auth';
import { WriteDocDto } from './docs.dto';
import { DocsService, type DocView } from './docs.service';

/**
 * Phase 5 DESIGN §1. All three routes are `/projects/:projectId/...` and carry
 * `@RequireProjectAccess` (R1); the service answers per target (404 when the caller
 * cannot see it, 403 for a visible target without `docs:edit`). Only the docs-mode list
 * is in `SHARE_LINK_ROUTES` (R21).
 */
@ApiTags('docs')
@Controller()
export class DocsController {
  constructor(private readonly docs: DocsService) {}

  @ApiOperation({ summary: 'Docs mode: every doc whose target the caller can see' })
  @RequireProjectAccess('projectId')
  @Get('projects/:projectId/docs')
  list(@Req() req: Request, @Param('projectId') projectId: string): Promise<{ docs: DocView[] }> {
    return this.docs.list(subjectOf(req), projectId, mapFor(req, projectId));
  }

  @ApiOperation({ summary: 'One doc (an empty one when the target was never documented)' })
  @RequireProjectAccess('projectId')
  @Get('projects/:projectId/docs/:targetType/:targetId')
  get(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('targetType') targetType: string,
    @Param('targetId') targetId: string,
  ): Promise<DocView> {
    return this.docs.get(subjectOf(req), projectId, targetType, targetId, mapFor(req, projectId));
  }

  @ApiOperation({ summary: 'Write a doc and its structured facts (`docs:edit` at the target)' })
  @RequireProjectAccess('projectId')
  @Put('projects/:projectId/docs/:targetType/:targetId')
  write(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('targetType') targetType: string,
    @Param('targetId') targetId: string,
    @Body() body: WriteDocDto,
  ): Promise<DocView> {
    // The service 404s an unknown type; the cast only meets its exact signature.
    return this.docs.write(subjectOf(req), projectId, targetType as DocTargetType, targetId, body);
  }
}

type DocTargetType = Parameters<DocsService['write']>[2];

function subjectOf(req: Request): Subject {
  const subject = getSubject(req);
  // Unreachable behind the guards; kept so a moved guard cannot open the route.
  if (subject === null) throw new ForbiddenException({ code: 'route_not_classified' });
  return subject;
}

function mapFor(req: Request, projectId: string): ProjectPermissionMap {
  const context = getAccessContext(req);
  if (context?.projectId !== projectId) throw new ForbiddenException({ code: 'route_not_classified' });
  return context.map;
}
