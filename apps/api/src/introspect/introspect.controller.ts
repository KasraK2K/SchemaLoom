import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../access';
import { snapshotContext } from '../snapshots';
import { IntrospectApplyDto, IntrospectDriftDto, IntrospectPreviewDto } from './introspect.dto';
import {
  IntrospectService,
  type ConnectionSource,
  type DriftView,
  type IntrospectPreview,
} from './introspect.service';

/** The DTO's refine guarantees exactly one of the two. */
const sourceOf = (body: {
  connection?: Record<string, unknown>;
  saved?: true;
}): ConnectionSource => (body.saved === true ? { saved: true } : { connection: body.connection });

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
    return this.introspect.preview(snapshotContext(req, projectId), sourceOf(body));
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
    // Phase 11 Q4: a token never makes the server connect somewhere new.
    if (req.auth?.kind === 'user' && req.auth.token !== undefined && body.saved !== true) {
      throw new BadRequestException({ code: 'saved_connection_required' });
    }
    return this.introspect.drift(snapshotContext(req, projectId), sourceOf(body), {
      allowDestructive: body.allowDestructive,
      transactional: body.transactional,
    });
  }

  /**
   * Phase 13 §5 — the same two reads for an engine that reads a FILE (SQLite): the body is the
   * database itself, `application/octet-stream`. Same atom, same full-view check, same answer.
   */
  @ApiOperation({ summary: 'Upload a database file and preview importing its schema' })
  @RequirePermission('schema:edit', { project: 'projectId' })
  @Post('upload/preview')
  @HttpCode(200)
  previewUpload(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ): Promise<IntrospectPreview> {
    return this.introspect.preview(snapshotContext(req, projectId), { upload: uploaded(body) });
  }

  @ApiOperation({ summary: 'Compare the design with an uploaded database file' })
  @RequirePermission('schema:edit', { project: 'projectId' })
  @Post('upload/drift')
  @HttpCode(200)
  driftUpload(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @Query('allowDestructive') allowDestructive?: string,
    @Query('transactional') transactional?: string,
  ): Promise<DriftView> {
    // Phase 11 Q4 holds here too: a token never sends the server something new to read.
    if (req.auth?.kind === 'user' && req.auth.token !== undefined) {
      throw new BadRequestException({ code: 'saved_connection_required' });
    }
    return this.introspect.drift(
      snapshotContext(req, projectId),
      { upload: uploaded(body) },
      {
        allowDestructive: allowDestructive === 'true',
        transactional: transactional !== 'false',
      },
    );
  }
}

/** The raw body parser hands a Buffer only for `application/octet-stream`. */
function uploaded(body: unknown): Buffer {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new BadRequestException({ code: 'introspect.upload_empty' });
  }
  return body;
}
