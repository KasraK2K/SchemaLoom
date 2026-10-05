import { randomBytes } from 'node:crypto';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  PermissionResolver,
  canOpenProject,
  hasCompleteView,
  type ApiTokenScope,
  type Subject,
} from '../access';
import { API_TOKEN_PREFIX, hashApiToken, type ApiTokenClaims } from '../auth';
import type { ApiToken } from '../generated/prisma/client';
import { assertAgentAllowed } from '../ai/ai-settings';
import { PrismaService } from '../prisma/prisma.service';
import type { ProjectPermissionMap } from '../access';

const DAY_MS = 86_400_000;

export interface ApiTokenView {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
  /** Set on the project-settings list, where managers see everyone's tokens. */
  readonly owner?: { readonly id: string; readonly name: string; readonly email: string };
}

export interface CreatedApiToken extends ApiTokenView {
  /** Shown once, never stored. */
  readonly secret: string;
}

/** `GET /token`: what the CLI learns about the token it holds. */
export interface TokenSelfView {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string;
}

type Row = ApiToken & {
  project: { name: string };
  user?: { id: string; name: string; email: string };
};

/** Phase 11 §3 and §6 — personal, project-scoped tokens for the CLI. */
@Injectable()
export class ApiTokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
  ) {}

  /**
   * The route already checked `canOpenProject`. `drift` also needs `schema:edit` here, the
   * drift route's atom, so a token is never created for something it could not do. `agent`
   * (Phase 21 §3) needs `ai:use` and the project's AI switch on, for the same reason, and
   * `propose` (§9.4) a complete view and `comment:create` on top.
   */
  async create(
    userId: string,
    projectId: string,
    map: ProjectPermissionMap,
    input: { name: string; scopes: readonly ApiTokenScope[]; expiresInDays: number },
  ): Promise<CreatedApiToken> {
    if (input.scopes.includes('drift') && !map.projectAtoms.has('schema:edit')) {
      throw new ForbiddenException({ code: 'forbidden', required: 'schema:edit' });
    }
    const body = randomBytes(32).toString('base64url');
    const secret = `${API_TOKEN_PREFIX}${body}`;
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { organizationId: true, settings: true },
    });
    if (input.scopes.includes('agent')) assertAgentAllowed(map, project.settings);
    // §9.4: `propose` also needs what the canvas's Propose a change needs.
    if (
      input.scopes.includes('propose') &&
      (!map.projectAtoms.has('comment:create') ||
        !hasCompleteView(map, await this.resolver.skeleton(projectId)))
    ) {
      throw new ForbiddenException({ code: 'forbidden', required: 'comment:create' });
    }
    const row = await this.prisma.apiToken.create({
      data: {
        userId,
        projectId,
        name: input.name,
        tokenHash: hashApiToken(secret),
        prefix: body.slice(0, 8),
        scopes: [...new Set(input.scopes)],
        expiresAt: new Date(Date.now() + input.expiresInDays * DAY_MS),
      },
      include: { project: { select: { name: true } } },
    });
    await this.audit(project.organizationId, projectId, userId, 'api_token.created', row);
    return { ...view(row), secret };
  }

  /** The caller's own live tokens, across projects. */
  async listMine(userId: string): Promise<ApiTokenView[]> {
    const rows = await this.prisma.apiToken.findMany({
      where: { userId, revokedAt: null, project: { deletedAt: null } },
      include: { project: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(view);
  }

  /** Everyone's live tokens on one project, for people who manage its sharing. */
  async listForProject(projectId: string): Promise<ApiTokenView[]> {
    const rows = await this.prisma.apiToken.findMany({
      where: { projectId, revokedAt: null },
      include: {
        project: { select: { name: true } },
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(view);
  }

  /** The owner, or `sharing:manage` on the token's project. Anyone else: 404. */
  async revoke(subject: Subject, id: string): Promise<void> {
    if (subject.kind !== 'user') throw notFound(id);
    const row = await this.prisma.apiToken.findFirst({
      where: { id, revokedAt: null },
      include: { project: { select: { name: true, organizationId: true } } },
    });
    if (row === null) throw notFound(id);
    if (row.userId !== subject.userId) {
      const map = await this.resolver.resolveProject(subject, row.projectId);
      if (!canOpenProject(map)) throw notFound(id);
      if (!map.projectAtoms.has('sharing:manage')) throw notFound(id);
    }
    await this.prisma.apiToken.update({ where: { id }, data: { revokedAt: new Date() } });
    await this.audit(
      row.project.organizationId,
      row.projectId,
      subject.userId,
      'api_token.revoked',
      row,
    );
  }

  async self(claims: ApiTokenClaims): Promise<TokenSelfView> {
    const row = await this.prisma.apiToken.findUniqueOrThrow({ where: { id: claims.tokenId } });
    return {
      id: row.id,
      name: row.name,
      projectId: row.projectId,
      scopes: row.scopes,
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  private async audit(
    organizationId: string,
    projectId: string,
    actorUserId: string,
    action: string,
    row: ApiToken,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        projectId,
        actorUserId,
        action,
        resourceType: 'api_token',
        resourceId: row.id,
        metadata: { name: row.name, prefix: row.prefix, ownerId: row.userId, scopes: row.scopes },
      },
    });
  }
}

function view(row: Row): ApiTokenView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    projectId: row.projectId,
    projectName: row.project.name,
    scopes: row.scopes,
    expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    ...(row.user === undefined ? {} : { owner: row.user }),
  };
}

const notFound = (id: string): NotFoundException =>
  new NotFoundException({ code: 'not_found', resourceType: 'api_token', id });
