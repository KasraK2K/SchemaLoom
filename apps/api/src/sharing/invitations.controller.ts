import { Controller, Get, HttpCode, Param, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Authenticated } from '../access';
import { Public, getPrincipal } from '../auth';
import {
  InvitationsService,
  type AcceptedInvitation,
  type InvitationView,
} from './invitations.service';

/**
 * Doc 05 §6.4 (R11) — the two routes `/invite/[token]` calls.
 *
 * MARKERS. The read is `@Public()`: the invitee may not have an account yet, and the token
 * is the whole credential. The accept is `@Authenticated()`, not an org marker, for the
 * reason `OrganizationsController` gives: the caller this exists for usually belongs to no
 * org yet, and every org-scoped marker would 404 them. The service checks the one thing
 * that matters — the signed-in user's VERIFIED email is the invited one.
 */
@ApiTags('sharing')
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @ApiOperation({ summary: 'What an invitation link is for (uniform 404 when dead)' })
  @Public()
  @Get(':token')
  view(@Param('token') token: string): Promise<InvitationView> {
    return this.invitations.view(token);
  }

  @ApiOperation({ summary: 'Accept an invitation as the signed-in user' })
  @Authenticated()
  @HttpCode(200)
  @Post(':token/accept')
  accept(@Req() req: Request, @Param('token') token: string): Promise<AcceptedInvitation> {
    const principal = getPrincipal(req);
    if (principal?.kind !== 'user') throw new UnauthorizedException({ code: 'NOT_AUTHENTICATED' });
    return this.invitations.accept(principal.userId, token);
  }
}
