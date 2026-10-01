import { Body, Controller, Delete, Get, HttpCode, Param, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../access';
import { snapshotContext } from '../snapshots';
import { SaveConnectionDto } from './introspect.dto';
import { SavedConnectionService, type SavedConnectionView } from './saved-connection.service';

/**
 * Phase 6c — the project's saved database connection. Seeing it (without secrets) is the
 * import's atom; choosing it is `sharing:manage`, because a saved connection lets every
 * editor make the api log in to that database. Reading WITH it is `…/introspect/*`.
 */
@ApiTags('snapshots')
@Controller('projects/:projectId/connection')
export class SavedConnectionController {
  constructor(private readonly connections: SavedConnectionService) {}

  @ApiOperation({ summary: 'The saved connection, without its passwords and keys' })
  @RequirePermission('schema:edit', { project: 'projectId' })
  @Get()
  view(@Param('projectId') projectId: string): Promise<SavedConnectionView> {
    return this.connections.view(projectId);
  }

  @ApiOperation({ summary: 'Save or replace the connection; a blank secret keeps the saved one' })
  @RequirePermission('sharing:manage', { project: 'projectId' })
  @Put()
  save(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: SaveConnectionDto,
  ): Promise<SavedConnectionView> {
    return this.connections.save(projectId, userOf(req, projectId), body.connection);
  }

  @ApiOperation({ summary: 'Forget the saved connection' })
  @RequirePermission('sharing:manage', { project: 'projectId' })
  @Delete()
  @HttpCode(204)
  async forget(@Req() req: Request, @Param('projectId') projectId: string): Promise<void> {
    await this.connections.forget(projectId, userOf(req, projectId));
  }
}

/** A share-link subject never reaches here (the atoms aren't share-link-reachable). */
function userOf(req: Request, projectId: string): string {
  const { subject } = snapshotContext(req, projectId);
  if (subject.kind !== 'user') throw new Error('route_not_classified');
  return subject.userId;
}
