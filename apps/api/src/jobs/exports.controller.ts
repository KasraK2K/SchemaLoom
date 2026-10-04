import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Authenticated, RequirePermission, getAccessContext } from '../access';
import { getSubject } from '../auth';
import { ExportsService, IMAGE_EXPORT_MAX_BYTES, type ExportJobView } from './exports.service';

/** `format` is checked against the core set and the project engine's exporter in the service. */
export const createExportSchema = z.object({
  format: z.string().min(1).max(64),
  options: z
    .object({
      includeComments: z.boolean(),
      includeDrops: z.boolean(),
      includeIfNotExists: z.boolean(),
    })
    .partial()
    .strict()
    .optional(),
  sizeBytes: z.number().int().positive().max(IMAGE_EXPORT_MAX_BYTES).optional(),
});
export class CreateExportDto extends createZodDto(createExportSchema) {}

/** Phase 18 §2.1 — the Models pane: one ORM, the selected tables (none = all visible). */
export const ormCodeSchema = z.object({
  orm: z.enum(['prisma', 'drizzle', 'typeorm', 'django']),
  entityIds: z.array(z.string().min(1).max(64)).max(500),
});
export class OrmCodeDto extends createZodDto(ormCodeSchema) {}

/**
 * Doc 05 §2.2 `export:run`: `POST /projects/:id/exports` (or `/areas/:id/exports`, Q29),
 * `GET /exports/:id` (own jobs only), plus `POST /exports/:id/complete` for the browser-rendered images. The id-addressed
 * routes name no project, so they are `@Authenticated()` and the service derives the
 * project from the row. None is in `SHARE_LINK_ROUTES`.
 */
@ApiTags('exports')
@Controller()
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @ApiOperation({ summary: 'Start an export; png/svg return a presigned PUT for the browser' })
  @RequirePermission('export:run', { project: 'projectId' })
  @Post('projects/:projectId/exports')
  create(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: CreateExportDto,
  ): Promise<ExportJobView> {
    return this.exports.create(user(req), projectId, body);
  }

  @ApiOperation({ summary: "A selection's model code in one ORM (the AI panel's Models pane)" })
  @RequirePermission('export:run', { project: 'projectId' })
  @Post('projects/:projectId/orm-code')
  @HttpCode(200)
  ormCode(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: OrmCodeDto,
  ): Promise<{ readonly text: string; readonly incomplete: boolean }> {
    return this.exports.ormCode(user(req), projectId, body);
  }

  /** Q29 — the same, cut to one area, for a subject whose grant is on the area. */
  @ApiOperation({ summary: 'Start a server-rendered export of one area' })
  @RequirePermission('export:run', { area: 'areaId' })
  @Post('areas/:areaId/exports')
  createForArea(
    @Req() req: Request,
    @Param('areaId') areaId: string,
    @Body() body: CreateExportDto,
  ): Promise<ExportJobView> {
    const access = getAccessContext(req);
    if (access === null) throw new ForbiddenException({ code: 'route_not_classified' });
    return this.exports.create(user(req), access.projectId, body, areaId);
  }

  @ApiOperation({
    summary: 'State of one of your exports, with a 10-minute download link when done',
  })
  @Authenticated()
  @Get('exports/:id')
  get(@Req() req: Request, @Param('id') id: string): Promise<ExportJobView> {
    const token = req.auth?.kind === 'user' ? req.auth.token : undefined;
    return this.exports.get(user(req), id, token?.projectId);
  }

  @ApiOperation({ summary: 'Mark a browser-rendered image export as uploaded' })
  @Authenticated()
  @HttpCode(200)
  @Post('exports/:id/complete')
  complete(@Req() req: Request, @Param('id') id: string): Promise<ExportJobView> {
    return this.exports.complete(user(req), id);
  }
}

/** A share-link subject is 404'd by the guard before this runs; narrowing gives the row
 *  an owner. */
function user(req: Request) {
  const subject = getSubject(req);
  if (subject?.kind !== 'user') throw new ForbiddenException({ code: 'route_not_classified' });
  return subject;
}
