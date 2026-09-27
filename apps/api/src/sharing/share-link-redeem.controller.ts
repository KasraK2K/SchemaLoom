import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public, cookiePolicyFrom, setShareSessionCookie } from '../auth';
import type { AppEnv } from '../config/env';
import { ShareLinkRedeemService } from './share-link-redeem.service';
import { UnlockShareLinkDto } from './sharing.dto';

/**
 * Doc 05 §7.12 steps 1-3. Both routes are `@Public()`: the visitor has no identity yet —
 * minting one is what these routes are for. `POST …/unlock` is the one unsafe route with
 * no cookie authority, so it is protected by its per-IP and per-link rate limits rather
 * than by CSRF (doc 01 §5.4).
 *
 * The response names ids only, never the project or org name: nothing is disclosed until
 * the cookie exists, and after that the ordinary guarded routes take over.
 */
@ApiTags('sharing')
@Controller('s')
export class ShareLinkRedeemController {
  constructor(
    private readonly redeem: ShareLinkRedeemService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  @ApiOperation({ summary: 'Is this share link live, and does it need a password?' })
  @Public()
  @Get(':token')
  inspect(@Param('token') token: string): Promise<{ needsPassword: boolean }> {
    return this.redeem.inspect(token);
  }

  @ApiOperation({ summary: 'Unlock a share link and receive the sl_session cookie' })
  @Public()
  @HttpCode(200)
  @Post(':token/unlock')
  async unlock(
    @Param('token') token: string,
    @Body() body: UnlockShareLinkDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ projectId: string; resourceType: string; resourceId: string }> {
    const { session, ...target } = await this.redeem.unlock(token, body.password, req.ip);
    setShareSessionCookie(res, cookiePolicyFrom(this.config), session.token, session.ttlSec);
    return target;
  }
}
