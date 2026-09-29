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
import type { Request } from 'express';
import {
  Authenticated,
  RequireProjectAccess,
  getAccessContext,
  type ProjectPermissionMap,
  type Subject,
} from '../access';
import { getSubject } from '../auth';
import { CommentTargetQueryDto, CreateCommentDto, UpdateCommentDto } from './comments.dto';
import { CommentsService, type CommentView, type MentionCandidate } from './comments.service';

/**
 * Phase 4 DESIGN §3.1. MARKERS as in `SavedQueriesController`: `/projects/:projectId/...`
 * carries `@RequireProjectAccess` (R1) and the service answers per target (404 when the
 * caller cannot see it); routes addressed by a comment id name no project, so they are
 * `@Authenticated()` and the service derives it from the row. None is in
 * `SHARE_LINK_ROUTES` (R21).
 */
@ApiTags('comments')
@Controller()
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @ApiOperation({ summary: 'Every comment on one table or column, oldest first' })
  @RequireProjectAccess('projectId')
  @Get('projects/:projectId/comments')
  list(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Query() query: CommentTargetQueryDto,
  ): Promise<{ comments: CommentView[] }> {
    return this.comments.list(
      subjectOf(req),
      projectId,
      mapFor(req, projectId),
      query.targetType,
      query.targetId,
    );
  }

  @ApiOperation({ summary: 'Open threads per table, over tables the caller can see (L8)' })
  @RequireProjectAccess('projectId')
  @Get('projects/:projectId/comments/counts')
  counts(
    @Req() req: Request,
    @Param('projectId') projectId: string,
  ): Promise<{ counts: Record<string, number> }> {
    return this.comments.counts(projectId, mapFor(req, projectId));
  }

  @ApiOperation({ summary: 'People who can see the target, for @-mentions (doc 05 §7.7)' })
  @RequireProjectAccess('projectId')
  @Get('projects/:projectId/comments/mention-candidates')
  mentionCandidates(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Query() query: CommentTargetQueryDto,
  ): Promise<{ users: MentionCandidate[] }> {
    return this.comments.mentionCandidates(
      subjectOf(req),
      projectId,
      mapFor(req, projectId),
      query.targetType,
      query.targetId,
    );
  }

  @ApiOperation({ summary: 'Comment, or reply, on a table or column (`comment:create`)' })
  @RequireProjectAccess('projectId')
  @Post('projects/:projectId/comments')
  create(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: CreateCommentDto,
  ): Promise<CommentView> {
    return this.comments.create(subjectOf(req), projectId, mapFor(req, projectId), body);
  }

  @ApiOperation({ summary: 'Edit your own comment' })
  @Authenticated()
  @Patch('comments/:id')
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: UpdateCommentDto,
  ): Promise<CommentView> {
    return this.comments.update(subjectOf(req), id, body.content);
  }

  @ApiOperation({ summary: 'Delete your own comment (a tombstone while it has replies)' })
  @Authenticated()
  @HttpCode(204)
  @Delete('comments/:id')
  remove(@Req() req: Request, @Param('id') id: string): Promise<void> {
    return this.comments.remove(subjectOf(req), id);
  }

  @ApiOperation({ summary: 'Resolve the thread (own thread, or `docs:edit`)' })
  @Authenticated()
  @HttpCode(204)
  @Post('comments/:id/resolve')
  resolve(@Req() req: Request, @Param('id') id: string): Promise<void> {
    return this.comments.setResolved(subjectOf(req), id, true);
  }

  @ApiOperation({ summary: 'Reopen the thread (own thread, or `docs:edit`)' })
  @Authenticated()
  @HttpCode(204)
  @Post('comments/:id/reopen')
  reopen(@Req() req: Request, @Param('id') id: string): Promise<void> {
    return this.comments.setResolved(subjectOf(req), id, false);
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
  if (context?.projectId !== projectId)
    throw new ForbiddenException({ code: 'route_not_classified' });
  return context.map;
}
