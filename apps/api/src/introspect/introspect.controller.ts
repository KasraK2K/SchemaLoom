import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../access';
import { snapshotContext } from '../snapshots';
import { IntrospectApplyDto, IntrospectDriftDto, IntrospectPreviewDto } from './introspect.dto';
import { IntrospectService, type DriftView, type IntrospectPreview } from './introspect.service';

/**
 * Phase 6 §4 and §6. All three read a live database, so all three carry the import's atom
 * (`schema:edit`) and the service adds R21′ (the full view) before connecting anywhere.
 */
@ApiTags('snapshots')
@Controller('projects/:projectId/introspect')
export class IntrospectController {
  constructor(private readonly introspect: IntrospectService) {}

  @ApiOperation({ summary: 'Read a live database and preview importing its schema' })
  @RequirePermission('schema:edit', { project: 'projectId' })
  @Post('preview')
  @HttpCode(200)
  preview(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: IntrospectPreviewDto,
  ): Promise<IntrospectPreview> {
    return this.introspect.preview(snapshotContext(req, projectId), body.connection);
  }

  @ApiOperation({ summary: 'Import a previewed database schema (queues the import job)' })
  @RequirePermission('schema:edit', { project: 'projectId' })
  @Post('apply')
  apply(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: IntrospectApplyDto,
  ): Promise<{ readonly id: string }> {
    return this.introspect.apply(snapshotContext(req, projectId), body.sourceId, body.renames);
  }

  @ApiOperation({ summary: 'Compare the design with a live database; nothing is written' })
  @RequirePermission('schema:edit', { project: 'projectId' })
  @Post('drift')
  @HttpCode(200)
  drift(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: IntrospectDriftDto,
  ): Promise<DriftView> {
    return this.introspect.drift(snapshotContext(req, projectId), body.connection, {
      allowDestructive: body.allowDestructive,
      transactional: body.transactional,
    });
  }
}
