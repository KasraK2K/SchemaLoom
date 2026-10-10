import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Authenticated } from '../access';
import { getPrincipal } from '../auth';
import type { PostResult } from './audit-stream.core';
import { AuditStreamDto } from './audit-stream.dto';
import { AuditStreamService, type AuditStreamView } from './audit-stream.service';

/**
 * Roadmap 14d §4 — the org's audit stream. `@Authenticated()` like the other org routes
 * addressed by slug; `AuditStreamService` admits owners only and 404s everyone else.
 */
@ApiTags('organizations')
@Controller('organizations/:orgSlug/audit-stream')
export class AuditStreamController {
  constructor(private readonly streams: AuditStreamService) {}

  @ApiOperation({ summary: 'Audit stream settings and status, no secrets (owner)' })
  @Authenticated()
  @Get()
  get(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
  ): Promise<{ stream: AuditStreamView | null }> {
    return this.streams.get(userIdOf(req), orgSlug);
  }

  @ApiOperation({ summary: 'Create or update the audit stream (owner)' })
  @Authenticated()
  @Put()
  put(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Body() body: AuditStreamDto,
  ): Promise<{ stream: AuditStreamView; signingSecret?: string }> {
    return this.streams.put(userIdOf(req), orgSlug, body);
  }

  @ApiOperation({ summary: 'Send one test event to the audit stream (owner)' })
  @Authenticated()
  @HttpCode(200)
  @Post('test')
  test(@Req() req: Request, @Param('orgSlug') orgSlug: string): Promise<PostResult> {
    return this.streams.test(userIdOf(req), orgSlug);
  }

  @ApiOperation({ summary: 'Delete the audit stream and its cursor (owner)' })
  @Authenticated()
  @HttpCode(204)
  @Delete()
  async remove(@Req() req: Request, @Param('orgSlug') orgSlug: string): Promise<void> {
    await this.streams.remove(userIdOf(req), orgSlug);
  }
}

function userIdOf(req: Request): string {
  const principal = getPrincipal(req);
  if (principal?.kind !== 'user') throw new UnauthorizedException({ code: 'NOT_AUTHENTICATED' });
  return principal.userId;
}
