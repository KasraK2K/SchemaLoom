import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { RequirePermission } from '../access';
import { getSubject } from '../auth';
import { StorageService } from '../storage';
import { QUEUED_IMPORT_MAX_BYTES, importObjectKey } from './import.processor';
import { JobsService, type ImportJobStatus } from './jobs.service';

/**
 * Doc 00 Q22's large-import path: the body is the raw SQL as `text/plain` (the JSON
 * parser's 6 MB cap stays where it is), stored, and applied by the import job. Same atom
 * as the synchronous `POST .../import`; the job re-checks it when it runs.
 */
@ApiTags('snapshots')
@Controller('projects/:projectId/import/jobs')
export class ImportJobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly storage: StorageService,
  ) {}

  @ApiOperation({ summary: 'Queue a large SQL import (text/plain body, up to 50 MB)' })
  @RequirePermission('schema:edit', { project: 'projectId' })
  @Post()
  async enqueue(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ): Promise<{ id: string }> {
    if (typeof body !== 'string' || body.length === 0) {
      throw new BadRequestException({ code: 'import_source_required' });
    }
    const bytes = Buffer.from(body, 'utf8');
    if (bytes.byteLength > QUEUED_IMPORT_MAX_BYTES) {
      throw new PayloadTooLargeException({ code: 'import_too_large', max: QUEUED_IMPORT_MAX_BYTES });
    }
    const storageKey = importObjectKey(projectId, randomUUID());
    await this.storage.put(storageKey, bytes, 'text/plain; charset=utf-8');
    return { id: await this.jobs.enqueueImport({ projectId, subject: user(req), storageKey }) };
  }

  @ApiOperation({ summary: 'State of a queued SQL import' })
  @RequirePermission('schema:edit', { project: 'projectId' })
  @Get(':jobId')
  async status(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('jobId') jobId: string,
  ): Promise<ImportJobStatus> {
    const subject = user(req);
    const status = await this.jobs.importStatus(projectId, subject.userId, jobId);
    if (status === null) {
      throw new NotFoundException({ code: 'not_found', resourceType: 'import_job', id: jobId });
    }
    return status;
  }
}

/** A share-link subject is 404'd by the guard before this runs; narrowing gives the job
 *  an owner to scope its status to. */
function user(req: Request) {
  const subject = getSubject(req);
  if (subject?.kind !== 'user') throw new ForbiddenException({ code: 'route_not_classified' });
  return subject;
}
