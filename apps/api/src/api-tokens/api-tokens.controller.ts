import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  Authenticated,
  RequirePermission,
  RequireProjectAccess,
  getAccessContext,
} from '../access';
import { getSubject } from '../auth';
import { CreateApiTokenDto } from './api-tokens.dto';
import {
  ApiTokensService,
  type ApiTokenView,
  type CreatedApiToken,
  type TokenSelfView,
} from './api-tokens.service';

/**
 * Phase 11 §6. Only `GET /token` is in `API_TOKEN_ROUTES`: a token can't mint, list or
 * revoke tokens, and none of these is share-link-reachable.
 */
@ApiTags('api-tokens')
@Controller()
export class ApiTokensController {
  constructor(private readonly tokens: ApiTokensService) {}

  @ApiOperation({ summary: 'The API token making this request (CLI only)' })
  @Authenticated()
  @Get('token')
  self(@Req() req: Request): Promise<TokenSelfView> {
    const token = req.auth?.kind === 'user' ? req.auth.token : undefined;
    if (token === undefined) throw new NotFoundException({ code: 'not_found' });
    return this.tokens.self(token);
  }

  @ApiOperation({ summary: 'Your API tokens' })
  @Authenticated()
  @Get('me/api-tokens')
  mine(@Req() req: Request): Promise<ApiTokenView[]> {
    return this.tokens.listMine(user(req).userId);
  }

  @ApiOperation({ summary: 'Create an API token for this project; the secret is shown once' })
  @RequireProjectAccess('projectId')
  @Post('projects/:projectId/api-tokens')
  create(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: CreateApiTokenDto,
  ): Promise<CreatedApiToken> {
    const access = getAccessContext(req);
    if (access === null) throw new ForbiddenException({ code: 'route_not_classified' });
    return this.tokens.create(user(req).userId, projectId, access.map, body);
  }

  @ApiOperation({ summary: 'Every API token on this project' })
  @RequirePermission('sharing:manage', { project: 'projectId' })
  @Get('projects/:projectId/api-tokens')
  forProject(@Param('projectId') projectId: string): Promise<ApiTokenView[]> {
    return this.tokens.listForProject(projectId);
  }

  @ApiOperation({ summary: 'Revoke an API token (yours, or any on a project you manage)' })
  @Authenticated()
  @Delete('api-tokens/:id')
  @HttpCode(204)
  async revoke(@Req() req: Request, @Param('id') id: string): Promise<void> {
    await this.tokens.revoke(user(req), id);
  }
}

/** Token routes are a user's; a share-link subject is 404'd by the guard first. */
function user(req: Request) {
  const subject = getSubject(req);
  if (subject?.kind !== 'user') throw new NotFoundException({ code: 'not_found' });
  return subject;
}
