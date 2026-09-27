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
} from '../access';
import { getSubject } from '../auth';
import { userSubject } from './access-write';
import { AccessRequestsService, type AccessRequestView } from './access-requests.service';
import { GrantsService, type AccessList } from './grants.service';
import { ShareLinksService, type ShareLinkView } from './share-links.service';
import {
  ApproveAccessRequestDto,
  CreateGrantDto,
  CreateShareLinkDto,
  DenyAccessRequestDto,
  RequestAccessDto,
  UpdateGrantDto,
} from './sharing.dto';

/**
 * Doc 05 §7.7, §7.12-§7.14 — the routes `apps/web/src/features/sharing` calls.
 *
 * MARKERS. Routes under `/projects/:projectId` carry `@RequireProjectAccess`: it 404s a
 * subject who cannot open the project before any work is done. It is NOT the
 * authorisation for the writes — `canOpenProject` never is (§7.9). Every write re-resolves
 * the actor inside the project advisory lock and applies R4/R4a there (`AccessWriter`),
 * which is stronger than any guard-time check could be. Routes addressed by a grant,
 * link or request id name no project in the URL, so they are `@Authenticated()` and the
 * service derives the project from the row.
 *
 * None of these is in `SHARE_LINK_ROUTES`: a share-link subject gets a 404 from the guard.
 */
@ApiTags('sharing')
@Controller()
export class SharingController {
  constructor(
    private readonly grants: GrantsService,
    private readonly links: ShareLinksService,
    private readonly requests: AccessRequestsService,
  ) {}

  @ApiOperation({ summary: 'Who has access: resources, roles, and people with their grants' })
  @RequireProjectAccess('projectId')
  @Get('projects/:projectId/access')
  access(@Req() req: Request, @Param('projectId') projectId: string): Promise<AccessList> {
    return this.grants.accessList(projectId, mapFor(req, projectId));
  }

  @ApiOperation({ summary: 'Users and groups of the org matching a query' })
  @RequireProjectAccess('projectId')
  @Get('projects/:projectId/access/candidates')
  candidates(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Query('q') q: string | undefined,
  ) {
    return this.grants.candidates(projectId, mapFor(req, projectId), q ?? '');
  }

  @ApiOperation({ summary: 'Create or replace the grant for one (resource, principal)' })
  @RequireProjectAccess('projectId')
  @Post('projects/:projectId/grants')
  createGrant(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: CreateGrantDto,
  ): Promise<{ id: string }> {
    return this.grants.create(userSubject(getSubject(req)), projectId, body);
  }

  @ApiOperation({ summary: 'Change a grant’s role or toggles' })
  @Authenticated()
  @Patch('grants/:grantId')
  updateGrant(
    @Req() req: Request,
    @Param('grantId') grantId: string,
    @Body() body: UpdateGrantDto,
  ): Promise<{ id: string }> {
    return this.grants.update(userSubject(getSubject(req)), grantId, body);
  }

  @ApiOperation({ summary: 'Delete a grant (R4a: subject to R5 only)' })
  @Authenticated()
  @HttpCode(204)
  @Delete('grants/:grantId')
  deleteGrant(@Req() req: Request, @Param('grantId') grantId: string): Promise<void> {
    return this.grants.remove(userSubject(getSubject(req)), grantId);
  }

  @ApiOperation({ summary: 'Live share links on resources the caller manages' })
  @RequireProjectAccess('projectId')
  @Get('projects/:projectId/share-links')
  shareLinks(
    @Req() req: Request,
    @Param('projectId') projectId: string,
  ): Promise<{ links: ShareLinkView[] }> {
    return this.links.list(projectId, mapFor(req, projectId));
  }

  @ApiOperation({ summary: 'Create a share link; the URL is returned once' })
  @RequireProjectAccess('projectId')
  @Post('projects/:projectId/share-links')
  createShareLink(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: CreateShareLinkDto,
  ): Promise<{ link: ShareLinkView; url: string }> {
    return this.links.create(userSubject(getSubject(req)), projectId, body);
  }

  @ApiOperation({ summary: 'Revoke a share link and delete its grant' })
  @Authenticated()
  @HttpCode(204)
  @Delete('share-links/:linkId')
  revokeShareLink(@Req() req: Request, @Param('linkId') linkId: string): Promise<void> {
    return this.links.revoke(userSubject(getSubject(req)), linkId);
  }

  @ApiOperation({ summary: 'Pending access requests on resources the caller manages' })
  @RequireProjectAccess('projectId')
  @Get('projects/:projectId/access-requests')
  accessRequests(
    @Req() req: Request,
    @Param('projectId') projectId: string,
  ): Promise<{ requests: AccessRequestView[] }> {
    return this.requests.list(projectId, mapFor(req, projectId));
  }

  /** §7.13 — 202 unconditionally. Not an enumeration oracle, so there is no other answer. */
  @ApiOperation({ summary: 'Ask for access to a project, area or entity' })
  @Authenticated()
  @HttpCode(202)
  @Post('access-requests')
  async requestAccess(@Req() req: Request, @Body() body: RequestAccessDto): Promise<void> {
    const subject = getSubject(req);
    if (subject?.kind === 'user') await this.requests.request(subject, body);
  }

  @ApiOperation({ summary: 'Approve an access request (an ordinary grant write)' })
  @Authenticated()
  @HttpCode(204)
  @Post('access-requests/:requestId/approve')
  approve(
    @Req() req: Request,
    @Param('requestId') requestId: string,
    @Body() body: ApproveAccessRequestDto,
  ): Promise<void> {
    return this.requests.approve(userSubject(getSubject(req)), requestId, body.roleKey);
  }

  @ApiOperation({ summary: 'Deny an access request' })
  @Authenticated()
  @HttpCode(204)
  @Post('access-requests/:requestId/deny')
  deny(
    @Req() req: Request,
    @Param('requestId') requestId: string,
    @Body() body: DenyAccessRequestDto,
  ): Promise<void> {
    return this.requests.deny(userSubject(getSubject(req)), requestId, body.decisionNote);
  }
}

/** The map the guard already resolved (§10.4: no second resolve per request). */
function mapFor(req: Request, projectId: string): ProjectPermissionMap {
  const context = getAccessContext(req);
  if (context?.projectId !== projectId) throw new ForbiddenException({ code: 'route_not_classified' });
  return context.map;
}
