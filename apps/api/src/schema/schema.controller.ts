import { Body, Controller, ForbiddenException, Get, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RedactedModel } from '@schemaloom/schema-model';
import type { Request } from 'express';
import {
  PermissionResolver,
  RequireProjectAccess,
  VisibilityFilter,
  getAccessContext,
  type ProjectPermissionMap,
  type ProjectSkeleton,
} from '../access';
import { getSubject } from '../auth';
import { toCanvas, type CanvasView } from './canvas';
import { GeometryWriter } from './geometry.service';
import type { SchemaOperationResult } from './ops';
import { SchemaLoader } from './schema-loader.service';
import { SchemaGeometryDto, SchemaOpsDto } from './schema.dto';
import { SchemaWriter } from './schema-writer.service';

/**
 * Build-order steps 13 and 14 — the schema read path and the schema write path.
 *
 * **Every response here goes through `VisibilityFilter`, and there is no other way for
 * schema data to leave.** That is enforced by the types rather than by review:
 * `SchemaLoader.load` returns a `RawSchemaModel` whose payload lives in a package-private
 * `WeakMap` and whose `toJSON` throws, and the only function that accepts one is
 * `redact`. A handler here physically cannot serialise an unredacted model, even by
 * destructuring one out of the loader result — which was the realistic mistake an earlier
 * draft's `readonly ir: SchemaModel` field failed to prevent.
 *
 * MARKER: `@RequireProjectAccess('projectId')` on all four routes, and the choice is
 * deliberate on the WRITE routes too. Doc 05 §10.4 fixes the shape for bulk work — the
 * guard validates the project ref and resolves the map ONCE, and the service then calls
 * `assertAll` over the refs the batch actually names, which is N set lookups against that
 * one map. A `@RequirePermission('schema:edit', { project: 'projectId' })` marker would be
 * both wrong and coarser: §8.5's requirements are per-op and mostly entity- or
 * area-scoped, so an Area editor with no project-level grant would be refused a write
 * they are entitled to make.
 *
 * `GET /projects/:id/ir` is in `SHARE_LINK_ROUTES` (R21) and is view-gated, which the boot
 * sweep checks. The other three are not on that list, so a share-link subject gets a 404
 * from `PermissionGuard` before any of this runs: the surface does not exist for them.
 */
@ApiTags('schema')
@Controller('projects/:projectId')
export class SchemaController {
  constructor(
    private readonly loader: SchemaLoader,
    private readonly filter: VisibilityFilter,
    private readonly resolver: PermissionResolver,
    private readonly writer: SchemaWriter,
    private readonly geometry: GeometryWriter,
  ) {}

  /** The whole redacted IR. The canvas fetches it once when the project opens and then
   *  keeps it current by applying realtime frames (§8.1). */
  @ApiOperation({ summary: 'The project IR, redacted for the caller' })
  @RequireProjectAccess('projectId')
  @Get('ir')
  async ir(@Req() req: Request, @Param('projectId') projectId: string): Promise<RedactedModel> {
    const { redacted } = await this.view(req, projectId);
    return redacted;
  }

  /** Geometry only: enough to place the cards on first paint without shipping every
   *  field of a 3,000-object project. */
  @ApiOperation({ summary: 'Canvas geometry for the project, redacted for the caller' })
  @RequireProjectAccess('projectId')
  @Get('ir/canvas')
  async canvas(@Req() req: Request, @Param('projectId') projectId: string): Promise<CanvasView> {
    const { redacted } = await this.view(req, projectId);
    return toCanvas(redacted);
  }

  /** §8.2 — the ONLY schema write endpoint. One gesture, one batch, one transaction. */
  @ApiOperation({ summary: 'Apply a typed schema operation batch' })
  @RequireProjectAccess('projectId')
  @Post('schema/ops')
  async ops(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() batch: SchemaOpsDto,
  ): Promise<SchemaOperationResult> {
    const { redacted, map, skel, actorUserId } = await this.view(req, projectId);
    return this.writer.apply(batch, {
      projectId,
      origin: 'edit',
      actorUserId,
      map,
      skel,
      redacted,
    });
  }

  /**
   * §8.11 — the deliberate exception. It loads NO model: `assertAll` supplies both the
   * visibility check and the `schema:edit` check from the map the guard already resolved,
   * and there is no version to read, so there is nothing for a redacted IR to answer.
   */
  @ApiOperation({ summary: 'Move or resize entities on the canvas (no version, no conflict)' })
  @RequireProjectAccess('projectId')
  @Post('schema/geometry')
  async geometryWrite(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() batch: SchemaGeometryDto,
  ): Promise<SchemaOperationResult> {
    const { map, skel, actorUserId } = await this.access(req, projectId);
    return this.geometry.apply(batch, { projectId, actorUserId, map, skel });
  }

  /**
   * Doc 05 §10.4's N+1 rule, in four lines: the permission map comes from the guard,
   * which already paid for it, and the skeleton is fetched at most ONCE per request. A
   * 300-entity project is not 300 resolver calls, because the resolver's unit of work is
   * a PROJECT — every per-entity decision after this is a set lookup inside `redact`.
   */
  private async access(
    req: Request,
    projectId: string,
  ): Promise<{ map: ProjectPermissionMap; skel: ProjectSkeleton; actorUserId: string | null }> {
    const context = getAccessContext(req);
    const subject = getSubject(req);
    if (context === null || subject === null || context.projectId !== projectId) {
      // Unreachable behind `PermissionGuard`; kept because a handler that trusts a guard
      // is a handler that opens a route the day that guard moves.
      throw new ForbiddenException({ code: 'route_not_classified' });
    }
    // `@RequireProjectAccess` routes are given no skeleton (§7.9: the sidebar must not pay
    // for one per project), so this is where the one skeleton read happens. It is cached
    // in Redis under the project generation alone and shared across every user.
    const skel = context.skel ?? (await this.resolver.skeleton(projectId));
    return {
      map: context.map,
      skel,
      actorUserId: subject.kind === 'user' ? subject.userId : null,
    };
  }

  private async view(
    req: Request,
    projectId: string,
  ): Promise<{
    redacted: RedactedModel;
    map: ProjectPermissionMap;
    skel: ProjectSkeleton;
    actorUserId: string | null;
  }> {
    const { map, skel, actorUserId } = await this.access(req, projectId);
    const subject = getSubject(req);
    if (subject === null) throw new ForbiddenException({ code: 'route_not_classified' });
    const raw = await this.loader.load(projectId);
    // `redactWith`, not `redactModel`: the map and skeleton are already in hand, and
    // resolving a second time per request is exactly the N+1 §10.4 forbids.
    return {
      redacted: this.filter.redactWith(raw, subject, projectId, map, skel),
      map,
      skel,
      actorUserId,
    };
  }
}
