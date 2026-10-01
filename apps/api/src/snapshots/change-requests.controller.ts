import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
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
  type UpdateFromMainResult,
} from './change-requests.service';
import { MigrationQueryDto } from './snapshots.dto';
import type { MigrationView } from './snapshots.service';
import { snapshotContext } from './snapshots.controller';

export const createChangeRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(10_000).optional(),
    reviewerIds: z.array(z.string().min(1).max(64)).max(20).optional(),
  })
  .strict();
export class CreateChangeRequestDto extends createZodDto(createChangeRequestSchema) {}

export const reviewChangeRequestSchema = z
  .object({
    verdict: z.enum(['approved', 'changes_requested']),
    note: z.string().max(10_000).optional(),
  })
  .strict();
export class ReviewChangeRequestDto extends createZodDto(reviewChangeRequestSchema) {}

/** `draftRevision` from the detail the merger looked at (§7). */
export const mergeChangeRequestSchema = z
  .object({ expectedDraftRevision: z.string().regex(/^\d{1,20}$/) })
  .strict();
export class MergeChangeRequestDto extends createZodDto(mergeChangeRequestSchema) {}

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

  @ApiOperation({ summary: 'One change request, with its diff, conflicts and merge state' })
  @Authenticated()
  @Get('change-requests/:id')
  get(@Req() req: Request, @Param('id') id: string): Promise<ChangeRequestDetail> {
    return this.requests.get(subjectOf(req), id);
  }

  @ApiOperation({ summary: 'Migration SQL for merging the request into the project' })
  @Authenticated()
  @Get('change-requests/:id/migration')
  migration(
    @Req() req: Request,
    @Param('id') id: string,
    @Query() query: MigrationQueryDto,
  ): Promise<MigrationView> {
    return this.requests.migration(subjectOf(req), id, query);
  }

  @ApiOperation({ summary: 'Approve or request changes' })
  @Authenticated()
  @Post('change-requests/:id/reviews')
  review(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: ReviewChangeRequestDto,
  ): Promise<ChangeRequestSummary> {
    return this.requests.review(subjectOf(req), id, body);
  }

  @ApiOperation({ summary: 'Merge the draft into the project' })
  @Authenticated()
  @HttpCode(200)
  @Post('change-requests/:id/merge')
  merge(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: MergeChangeRequestDto,
  ): Promise<ChangeRequestSummary> {
    return this.requests.merge(subjectOf(req), id, body.expectedDraftRevision);
  }

  @ApiOperation({ summary: "Bring the project's changes since the start into the draft" })
  @Authenticated()
  @HttpCode(200)
  @Post('change-requests/:id/update-from-main')
  updateFromMain(@Req() req: Request, @Param('id') id: string): Promise<UpdateFromMainResult> {
    return this.requests.updateFromMain(subjectOf(req), id);
  }

  @ApiOperation({ summary: 'Close the request; the draft stays, read-only' })
  @Authenticated()
  @HttpCode(200)
  @Post('change-requests/:id/close')
  close(@Req() req: Request, @Param('id') id: string): Promise<ChangeRequestSummary> {
    return this.requests.setOpen(subjectOf(req), id, false);
  }

  @ApiOperation({ summary: 'Reopen a closed request' })
  @Authenticated()
  @HttpCode(200)
  @Post('change-requests/:id/reopen')
  reopen(@Req() req: Request, @Param('id') id: string): Promise<ChangeRequestSummary> {
    return this.requests.setOpen(subjectOf(req), id, true);
  }
}

const subjectOf = (req: Request) => {
  const subject = getSubject(req);
  if (subject === null) throw new NotFoundException({ code: 'not_found' });
  return subject;
};
