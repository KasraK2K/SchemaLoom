import { Body, Controller, ForbiddenException, Get, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { SchemaDiff } from '@schemaloom/schema-model';
import type { Request } from 'express';
import { RequirePermission, getAccessContext } from '../access';
import { getSubject } from '../auth';
import type { SchemaOperationResult } from '../schema';
import { CreateSnapshotDto } from './snapshots.dto';
import {
  SnapshotsService,
  type SnapshotContext,
  type SnapshotSummary,
  type SnapshotView,
} from './snapshots.service';

/**
 * Build-order step 19's surface. **Every route carries exactly one marker** or the boot
 * sweep aborts the process (doc 01 §4.1); `snapshots.routes.spec.ts` runs the same
 * assertion against this class's real decorator metadata.
 *
 * The two atoms are not interchangeable and the split is the point:
 *
 * - `history:view` at **project** scope reads and diffs. The blob is opaque, so
 *   `VisibilityFilter` cannot filter a LIST of snapshots — an area-scoped editor who could
 *   list them would learn every entity name they cannot see. Evaluating the atom at the
 *   project is therefore deliberate (doc 02 §11, doc 05 §10.1): this is the one place an
 *   atom is not evaluated at the resource the request names, and open question Q8 — an
 *   area-scoped editor cannot use history at all — is the accepted cost.
 * - `schema:edit` at project scope CREATES and RESTORES. Creating a snapshot is not a
 *   history read, and restore adds R21′ inside the service.
 *
 * Nothing here is in `SHARE_LINK_ROUTES`, so a share-link subject gets a 404 from
 * `PermissionGuard` before any handler runs: the surface does not exist for them.
 */
@ApiTags('snapshots')
@Controller('projects/:projectId/snapshots')
export class SnapshotsController {
  constructor(private readonly snapshots: SnapshotsService) {}

  /** §8.9 — freeze the current IR as JSON with its engine stamp. */
  @ApiOperation({ summary: 'Create a named snapshot of the current schema' })
  @RequirePermission('schema:edit', { project: 'projectId' })
  @Post()
  create(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: CreateSnapshotDto,
  ): Promise<SnapshotSummary> {
    return this.snapshots.create(this.context(req, projectId), body);
  }

  @ApiOperation({ summary: 'List the project snapshots, newest first' })
  @RequirePermission('history:view', { project: 'projectId' })
  @Get()
  list(@Param('projectId') projectId: string): Promise<SnapshotSummary[]> {
    return this.snapshots.list(projectId);
  }

  @ApiOperation({ summary: 'One snapshot, its IR redacted for the caller' })
  @RequirePermission('history:view', { project: 'projectId' })
  @Get(':snapshotId')
  read(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('snapshotId') snapshotId: string,
  ): Promise<SnapshotView> {
    return this.snapshots.read(this.context(req, projectId), snapshotId);
  }

  /** Two snapshots, both redacted first (L18), diffed by step 18's `diffModels`. */
  @ApiOperation({ summary: 'Diff two snapshots of this project' })
  @RequirePermission('history:view', { project: 'projectId' })
  @Get(':fromId/diff/:toId')
  diff(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('fromId') fromId: string,
    @Param('toId') toId: string,
  ): Promise<SchemaDiff> {
    return this.snapshots.diff(this.context(req, projectId), fromId, toId);
  }

  /** §8.8 — planned from unredacted models, applied through the step-14 write path. */
  @ApiOperation({ summary: 'Restore the project to a snapshot' })
  @RequirePermission('schema:edit', { project: 'projectId' })
  @Post(':snapshotId/restore')
  restore(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('snapshotId') snapshotId: string,
  ): Promise<SchemaOperationResult> {
    return this.snapshots.restore(this.context(req, projectId), snapshotId);
  }

  /**
   * `PermissionGuard` resolved the map AND the skeleton for a `@RequirePermission` route
   * (§10.4: N locators cost one `resolveProject` and one `skeleton`), so this is a read of
   * work already done, never a second resolve.
   */
  private context(req: Request, projectId: string): SnapshotContext {
    const access = getAccessContext(req);
    const subject = getSubject(req);
    if (
      access === null ||
      subject === null ||
      access.projectId !== projectId ||
      access.skel === null
    ) {
      // Unreachable behind the guard; kept because a handler that trusts a guard is a
      // handler that opens a route the day that guard moves.
      throw new ForbiddenException({ code: 'route_not_classified' });
    }
    return {
      projectId,
      subject,
      actorUserId: subject.kind === 'user' ? subject.userId : null,
      map: access.map,
      skel: access.skel,
    };
  }
}
