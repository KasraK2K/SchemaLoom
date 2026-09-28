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
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { QueryValidationResult } from '@schemaloom/engine-sdk';
import type { Request } from 'express';
import {
  Authenticated,
  RequireProjectAccess,
  getAccessContext,
  type ProjectPermissionMap,
  type Subject,
} from '../access';
import { getSubject } from '../auth';
import { CreateSavedQueryDto, UpdateSavedQueryDto, ValidateQueryDto } from './saved-queries.dto';
import { SavedQueriesService, type SavedQueryView } from './saved-queries.service';

/**
 * The saved-query library (doc 02 `SavedQuery`, doc 05 L25).
 *
 * MARKERS, as in `SharingController`: routes under `/projects/:projectId` carry
 * `@RequireProjectAccess` (R1: opening a project means holding `schema:view` somewhere
 * in it), and the per-row answer is `filterQueryRows`. Routes addressed by a query id name
 * no project, so they are `@Authenticated()` and the service derives the project from the
 * row, answering 404 for anything the caller cannot see. None is in `SHARE_LINK_ROUTES`.
 */
@ApiTags('saved-queries')
@Controller()
export class SavedQueriesController {
  constructor(private readonly queries: SavedQueriesService) {}

  @ApiOperation({ summary: 'Saved queries the caller may see, newest updated first' })
  @RequireProjectAccess('projectId')
  @Get('projects/:projectId/saved-queries')
  async list(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Query('tag') tag: string | undefined,
  ): Promise<{ queries: SavedQueryView[] }> {
    return { queries: await this.queries.list(subjectOf(req), projectId, mapFor(req, projectId), tag) };
  }

  @ApiOperation({ summary: 'Save a query; its identifiers are resolved against the caller’s view' })
  @RequireProjectAccess('projectId')
  @Post('projects/:projectId/saved-queries')
  create(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: CreateSavedQueryDto,
  ): Promise<SavedQueryView> {
    return this.queries.create(subjectOf(req), projectId, mapFor(req, projectId), body);
  }

  @ApiOperation({ summary: 'Resolve a query’s identifiers for the editor (no save)' })
  @RequireProjectAccess('projectId')
  @HttpCode(200)
  @Post('projects/:projectId/queries/validate')
  validate(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: ValidateQueryDto,
  ): Promise<QueryValidationResult> {
    return this.queries.validate(subjectOf(req), projectId, mapFor(req, projectId), body.query);
  }

  @ApiOperation({ summary: 'One saved query' })
  @Authenticated()
  @Get('saved-queries/:id')
  get(@Req() req: Request, @Param('id') id: string): Promise<SavedQueryView> {
    return this.queries.get(subjectOf(req), id);
  }

  @ApiOperation({ summary: 'Edit a saved query (creator or project sharing:manage)' })
  @Authenticated()
  @Patch('saved-queries/:id')
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: UpdateSavedQueryDto,
  ): Promise<SavedQueryView> {
    return this.queries.update(subjectOf(req), id, body);
  }

  @ApiOperation({ summary: 'Delete a saved query (creator or project sharing:manage)' })
  @Authenticated()
  @HttpCode(204)
  @Delete('saved-queries/:id')
  remove(@Req() req: Request, @Param('id') id: string): Promise<void> {
    return this.queries.remove(subjectOf(req), id);
  }
}

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
