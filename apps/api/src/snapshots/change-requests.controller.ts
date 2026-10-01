import { Body, Controller, Get, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Authenticated, RequirePermission } from '../access';
import { getSubject } from '../auth';
import {
  ChangeRequestsService,
  type ChangeRequestDetail,
  type ChangeRequestSummary,
} from './change-requests.service';
import { snapshotContext } from './snapshots.controller';

export const createChangeRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(10_000).optional(),
    reviewerIds: z.array(z.string().min(1).max(64)).max(20).optional(),
  })
  .strict();
export class CreateChangeRequestDto extends createZodDto(createChangeRequestSchema) {}

/**
 * Phase 10 §7. The routes that name a project carry its marker; the id-addressed ones are
 * `@Authenticated()` and the service derives the project from the row and answers 404
 * unless the caller has a complete view of it (§3), like exports do. None is in
 * `SHARE_LINK_ROUTES`.
 */
@ApiTags('change-requests')
@Controller()
export class ChangeRequestsController {
  constructor(private readonly requests: ChangeRequestsService) {}

  @ApiOperation({ summary: 'Propose a change: copies the project into a hidden draft' })
  @RequirePermission('comment:create', { project: 'projectId' })
  @Post('projects/:projectId/change-requests')
  create(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: CreateChangeRequestDto,
  ): Promise<ChangeRequestSummary> {
    return this.requests.create(snapshotContext(req, projectId), body);
  }

  @ApiOperation({ summary: "The project's change requests (empty without a complete view)" })
  @RequirePermission('schema:view', { project: 'projectId' })
  @Get('projects/:projectId/change-requests')
  list(
    @Req() req: Request,
    @Param('projectId') projectId: string,
  ): Promise<ChangeRequestSummary[]> {
    return this.requests.list(snapshotContext(req, projectId));
  }

  @ApiOperation({ summary: 'One change request, with its diff' })
  @Authenticated()
  @Get('change-requests/:id')
  get(@Req() req: Request, @Param('id') id: string): Promise<ChangeRequestDetail> {
    return this.requests.get(subjectOf(req), id);
  }
}

const subjectOf = (req: Request) => {
  const subject = getSubject(req);
  if (subject === null) throw new NotFoundException({ code: 'not_found' });
  return subject;
};
