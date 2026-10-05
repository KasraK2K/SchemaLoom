import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  Authenticated,
  RequireProjectAccess,
  getAccessContext,
  type ProjectPermissionMap,
  type Subject,
} from '../access';
import { getSubject } from '../auth';
import { CreateThreadDto, DocDraftsDto, DraftSchemaDto, PostMessageDto } from './ai.dto';
import {
  AiService,
  type AiMessageView,
  type AiThreadView,
  type DocDraftView,
  type DraftSchemaResult,
} from './ai.service';

/**
 * DESIGN §4.2 — the AI assistant. Markers as in `SavedQueriesController`: project-scoped
 * routes carry `@RequireProjectAccess` and the service checks `ai:use` at every selected
 * entity (a per-entity answer a route marker cannot give); id-addressed routes are
 * `@Authenticated()` and the service derives the project from the row, answering 404 for
 * anything the caller cannot see. None is in `SHARE_LINK_ROUTES`.
 *
 * `PATCH /projects/:id/settings` (the kill switch) is owned by the projects module.
 */
@ApiTags('ai')
@Controller()
export class AiController {
  constructor(private readonly ai: AiService) {}

  @ApiOperation({ summary: 'The caller’s own AI threads in this project (L25-filtered)' })
  @RequireProjectAccess('projectId')
  @Get('projects/:projectId/ai/threads')
  async listThreads(
    @Req() req: Request,
    @Param('projectId') projectId: string,
  ): Promise<{ threads: AiThreadView[] }> {
    return {
      threads: await this.ai.listThreads(subjectOf(req), projectId, mapFor(req, projectId)),
    };
  }

  @ApiOperation({
    summary: 'Start a thread from a canvas selection (ai:use at every selected entity)',
  })
  @RequireProjectAccess('projectId')
  @Post('projects/:projectId/ai/threads')
  createThread(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: CreateThreadDto,
  ): Promise<AiThreadView> {
    return this.ai.createThread(subjectOf(req), projectId, mapFor(req, projectId), body);
  }

  @ApiOperation({ summary: 'One thread with its messages; not own or failing L25 is 404' })
  @Authenticated()
  @Get('ai/threads/:id')
  getThread(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<AiThreadView & { messages: AiMessageView[] }> {
    return this.ai.getThread(subjectOf(req), id);
  }

  /**
   * SSE: `block-open` / `block-delta` / `block-close` as the model writes, then `done` with the
   * stored assistant message, or `error`. Everything that can refuse the request (404, 403,
   * 409, 429, 503) runs in `prepareTurn`, BEFORE the stream opens, so it is a plain status.
   */
  @ApiOperation({ summary: 'Ask or explain; streams the answer as server-sent events' })
  @Authenticated()
  @Post('ai/threads/:id/messages')
  async postMessage(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id') id: string,
    @Body() body: PostMessageDto,
  ): Promise<void> {
    const turn = await this.ai.prepareTurn(subjectOf(req), id, body);
    const abort = new AbortController();
    res.on('close', () => {
      abort.abort();
    });
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const emit = (event: string, data: unknown): void => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      emit('done', await this.ai.runTurn(turn, emit, abort.signal));
    } catch (error: unknown) {
      emit('error', errorBody(error));
    } finally {
      res.end();
    }
  }

  @ApiOperation({ summary: 'Queue AI doc drafts for the undocumented parts of these entities' })
  @RequireProjectAccess('projectId')
  @HttpCode(202)
  @Post('projects/:projectId/ai/doc-drafts')
  queueDocDrafts(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: DocDraftsDto,
  ): Promise<{ jobId: string }> {
    return this.ai.enqueueDocDrafts(
      subjectOf(req),
      projectId,
      mapFor(req, projectId),
      body.entityIds,
    );
  }

  @ApiOperation({ summary: 'Pending doc drafts on targets the caller can see' })
  @RequireProjectAccess('projectId')
  @Get('projects/:projectId/ai/doc-drafts')
  async listDocDrafts(
    @Req() req: Request,
    @Param('projectId') projectId: string,
  ): Promise<{ drafts: DocDraftView[] }> {
    return {
      drafts: await this.ai.listDocDrafts(subjectOf(req), projectId, mapFor(req, projectId)),
    };
  }

  @ApiOperation({ summary: 'Accept a doc draft (docs:edit at the target)' })
  @Authenticated()
  @HttpCode(200)
  @Post('ai/doc-drafts/:id/accept')
  acceptDocDraft(@Req() req: Request, @Param('id') id: string): Promise<DocDraftView> {
    return this.ai.acceptDocDraft(subjectOf(req), id);
  }

  @ApiOperation({ summary: 'Reject a doc draft (docs:edit at the target)' })
  @Authenticated()
  @HttpCode(200)
  @Post('ai/doc-drafts/:id/reject')
  rejectDocDraft(@Req() req: Request, @Param('id') id: string): Promise<DocDraftView> {
    return this.ai.rejectDocDraft(subjectOf(req), id);
  }

  @ApiOperation({ summary: 'Draft DDL from a description, for the import preview' })
  @RequireProjectAccess('projectId')
  @HttpCode(200)
  @Post('projects/:projectId/ai/draft-schema')
  draftSchema(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: DraftSchemaDto,
  ): Promise<DraftSchemaResult> {
    return this.ai.draftSchema(subjectOf(req), projectId, mapFor(req, projectId), body);
  }
}

/** The stream is already open, so a failure is an `error` event. Only a code goes out:
 *  a provider error message is not ours to forward. */
function errorBody(error: unknown): { code: string } {
  const response = (error as { getResponse?: () => unknown }).getResponse?.();
  const code = (response as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string') return { code };
  return {
    code: (error as { name?: unknown }).name === 'AbortError' ? 'aborted' : 'ai_provider_error',
  };
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
