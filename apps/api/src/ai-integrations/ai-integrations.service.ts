import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readOrgSettings } from '@schemaloom/contracts';
import { PermissionResolver } from '../access';
import { AiProvider } from '../ai/ai.provider';
import { scrubKey } from '../ai/openai-chat';
import { decryptSecret, encryptSecret } from '../auth/totp';
import type { AppEnv } from '../config/env';
import type { AiIntegration, Prisma } from '../generated/prisma/client';
import { resolveCheckedAddress } from '../introspect/address-guard';
import { orgMembership } from '../organizations/members.service';
import { PrismaService } from '../prisma/prisma.service';
import { PROVIDER_CAPABILITIES, type AiAbility, type AiProviderType } from './abilities';
import type {
  ChoiceInput,
  CreateIntegrationInput,
  GrantInput,
  UpdateIntegrationInput,
} from './ai-integrations.dto';
import { AiRouter } from './ai-router.service';
import { isUsable } from './resolve';

export interface IntegrationView {
  id: string;
  name: string;
  provider: AiProviderType;
  source: 'server' | 'custom';
  personal: boolean;
  baseUrl: string | null;
  keyHint: string | null;
  models: string[];
  status: 'unchecked' | 'ok' | 'failing';
  lastError: string | null;
  lastCheckedAt: Date | null;
  capabilities: { caching: boolean; thinking: boolean; fallback: boolean };
}
export interface GrantView {
  id: string;
  projectId: string | null;
  projectName: string | null;
  userId: string | null;
  userName: string | null;
}
export interface ChoiceView {
  ability: AiAbility;
  projectId: string | null;
  userId: string | null;
  integrationId: string;
  model: string;
  locked: boolean;
}
/** `GET /me/ai/choices`: the caller's choices plus what they may pick from. */
export interface MeChoicesView {
  choices: ChoiceView[];
  usableIntegrations: IntegrationView[];
  personalAllowed: boolean;
}

export type Owner =
  { kind: 'org'; userId: string; orgSlug: string } | { kind: 'me'; userId: string };
interface OrgChoiceScope {
  kind: 'org';
  userId: string;
  orgSlug: string;
}
/** the route marker already checked `sharing:manage` */
interface ProjectChoiceScope {
  kind: 'project';
  userId: string;
  projectId: string;
}
interface MeChoiceScope {
  kind: 'me';
  userId: string;
  orgSlug: string;
  projectId: string | null;
}
export type ChoiceScope = OrgChoiceScope | ProjectChoiceScope | MeChoiceScope;

/** Four characters of a short key are too much of it: no hint under 12 characters. */
const keyHint = (apiKey: string | undefined): string | null =>
  apiKey === undefined || apiKey.length < 12 ? null : apiKey.slice(-4);
const notFound = (): NotFoundException => new NotFoundException({ code: 'not_found' });
const readonly = (): ConflictException =>
  new ConflictException({ code: 'ai_server_integration_readonly' });

const CHOICE_SELECT = {
  ability: true,
  projectId: true,
  userId: true,
  integrationId: true,
  model: true,
  locked: true,
} satisfies Prisma.AiAbilityChoiceSelect;
const GRANT_SELECT = {
  id: true,
  projectId: true,
  userId: true,
  project: { select: { name: true } },
  user: { select: { name: true } },
} satisfies Prisma.AiIntegrationGrantSelect;

function grantView(
  g: Prisma.AiIntegrationGrantGetPayload<{ select: typeof GRANT_SELECT }>,
): GrantView {
  return {
    id: g.id,
    projectId: g.projectId,
    projectName: g.project?.name ?? null,
    userId: g.userId,
    userName: g.user?.name ?? null,
  };
}
// The DB CHECK pins ability to the registry on write (§2.3).
const choiceView = (
  c: Prisma.AiAbilityChoiceGetPayload<{ select: typeof CHOICE_SELECT }>,
): ChoiceView => ({
  ...c,
  ability: c.ability as AiAbility,
});

/**
 * Metadata is only ever { provider, name, models, projectId, userId, ability, model, locked, ok }:
 * never a key or its hint (§3.6). Personal integrations audit under the owner, with no org.
 */
function audit(
  tx: Prisma.TransactionClient,
  entry: {
    organizationId: string | null;
    projectId?: string | null;
    actorUserId: string;
    action: string;
    resourceType: 'ai_integration' | 'ai_integration_grant' | 'ai_choice';
    resourceId: string;
    metadata: Prisma.InputJsonObject;
  },
): Promise<unknown> {
  return tx.auditLog.create({ data: entry });
}

/** Roadmap 24 §3.5 — who manages which integrations, grants and choices. */
@Injectable()
export class AiIntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly provider: AiProvider,
    private readonly router: AiRouter,
    private readonly resolver: PermissionResolver,
  ) {}

  private get key(): string {
    return this.config.get('SECRETS_ENCRYPTION_KEY', { infer: true });
  }

  /** owner or admin of the org, else the 404 of a missing org (as AuditStreamService.ownedOrg) */
  private async adminOrg(userId: string, orgSlug: string): Promise<string> {
    return (await this.adminMember(userId, orgSlug)).organizationId;
  }

  private async adminMember(
    userId: string,
    orgSlug: string,
  ): Promise<{ organizationId: string; role: string }> {
    const member = await orgMembership(this.prisma, userId, orgSlug);
    if (member === null || (member.role !== 'owner' && member.role !== 'admin')) throw notFound();
    return member;
  }

  private async memberOrg(userId: string, orgSlug: string): Promise<string> {
    const member = await orgMembership(this.prisma, userId, orgSlug);
    if (member === null) throw notFound();
    return member.organizationId;
  }

  /** where-clause for rows the owner may manage */
  private async scopeOf(
    owner: Owner,
  ): Promise<{ organizationId: string } | { ownerUserId: string }> {
    return owner.kind === 'org'
      ? { organizationId: await this.adminOrg(owner.userId, owner.orgSlug) }
      : { ownerUserId: owner.userId };
  }

  private async row(owner: Owner, id: string): Promise<AiIntegration> {
    return this.rowIn(await this.scopeOf(owner), id);
  }

  private async rowIn(
    scope: { organizationId: string } | { ownerUserId: string },
    id: string,
  ): Promise<AiIntegration> {
    const row = await this.prisma.aiIntegration.findFirst({ where: { id, ...scope } });
    if (row === null) throw notFound();
    // With no env key the server row is hidden from everything (§2.1).
    if (row.source === 'server' && this.router.serverModels().length === 0) throw notFound();
    return row;
  }

  private async checkBaseUrl(baseUrl: string | undefined): Promise<void> {
    if (baseUrl === undefined) return;
    try {
      await resolveCheckedAddress(
        new URL(baseUrl).hostname.replace(/^\[|\]$/g, ''),
        this.config.get('AI_ALLOW_PRIVATE_HOSTS', { infer: true }),
      );
    } catch (error) {
      const code = (error as { getResponse?: () => { code?: string } }).getResponse?.().code;
      const isPrivate = code === 'introspect.private_host';
      throw new UnprocessableEntityException({
        code: isPrivate ? 'ai_private_base_url' : 'ai_base_url_unreachable',
        message: isPrivate
          ? 'The base URL is on a private network. A self-hosted install can allow it with AI_ALLOW_PRIVATE_HOSTS=true.'
          : 'Could not find the base URL’s host.',
      });
    }
  }

  /** The server row has no key fields; its models come from env. */
  private view(row: AiIntegration): IntegrationView {
    const server = row.source === 'server';
    // The DB CHECKs pin source, provider and status, so the narrowing is safe.
    const provider = row.provider as AiProviderType;
    return {
      id: row.id,
      name: row.name,
      provider,
      source: server ? 'server' : 'custom',
      personal: row.ownerUserId !== null,
      baseUrl: server ? null : row.baseUrl,
      keyHint: server ? null : row.keyHint,
      models: server ? this.router.serverModels() : row.allowedModels,
      status: row.status as IntegrationView['status'],
      lastError: row.lastError,
      lastCheckedAt: row.lastCheckedAt,
      capabilities: PROVIDER_CAPABILITIES[provider],
    };
  }

  // --- integrations ----------------------------------------------------------------------------

  async list(owner: Owner): Promise<IntegrationView[]> {
    const rows = await this.prisma.aiIntegration.findMany({
      where: await this.scopeOf(owner),
      orderBy: [{ source: 'desc' }, { createdAt: 'asc' }],
    });
    const hideServer = this.router.serverModels().length === 0;
    return rows.filter((r) => !(hideServer && r.source === 'server')).map((r) => this.view(r));
  }

  async create(owner: Owner, input: CreateIntegrationInput): Promise<IntegrationView> {
    const scope = await this.scopeOf(owner);
    await this.checkBaseUrl(input.baseUrl);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.aiIntegration.create({
        data: {
          ...scope,
          source: 'custom',
          provider: input.provider,
          name: input.name,
          baseUrl: input.baseUrl ?? null,
          apiKeyEnc:
            input.apiKey === undefined ? null : encryptSecret(Buffer.from(input.apiKey), this.key),
          keyHint: keyHint(input.apiKey),
          allowedModels: input.models,
          createdById: owner.userId,
        },
      });
      await audit(tx, {
        organizationId: row.organizationId,
        actorUserId: owner.userId,
        action: 'ai_integration.created',
        resourceType: 'ai_integration',
        resourceId: row.id,
        metadata: { provider: row.provider, name: row.name, models: row.allowedModels },
      });
      return this.view(row);
    });
  }

  async update(owner: Owner, id: string, input: UpdateIntegrationInput): Promise<IntegrationView> {
    const current = await this.row(owner, id);
    if (current.source === 'server') throw readonly();
    if (input.baseUrl !== undefined && current.provider !== 'openai_compatible') {
      throw new UnprocessableEntityException({
        code: 'ai_base_url_not_allowed',
        message: 'Only an OpenAI-compatible integration has a base URL.',
      });
    }
    await this.checkBaseUrl(input.baseUrl);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.aiIntegration.update({
        where: { id },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
          ...(input.models === undefined ? {} : { allowedModels: input.models }),
          ...(input.apiKey === undefined
            ? {}
            : {
                apiKeyEnc: encryptSecret(Buffer.from(input.apiKey), this.key),
                keyHint: keyHint(input.apiKey),
              }),
        },
      });
      await audit(tx, {
        organizationId: row.organizationId,
        actorUserId: owner.userId,
        action:
          input.apiKey === undefined ? 'ai_integration.updated' : 'ai_integration.key_rotated',
        resourceType: 'ai_integration',
        resourceId: row.id,
        metadata: { provider: row.provider, name: row.name, models: row.allowedModels },
      });
      return this.view(row);
    });
  }

  /** Cascades the integration's grants and choices (§2.5). */
  async remove(owner: Owner, id: string): Promise<void> {
    const row = await this.row(owner, id);
    if (row.source === 'server') throw readonly();
    await this.prisma.$transaction(async (tx) => {
      await tx.aiIntegration.delete({ where: { id } });
      await audit(tx, {
        organizationId: row.organizationId,
        actorUserId: owner.userId,
        action: 'ai_integration.deleted',
        resourceType: 'ai_integration',
        resourceId: id,
        metadata: { provider: row.provider, name: row.name },
      });
    });
  }

  /** §4.4: stores the outcome; never changes `allowed_models` by itself. */
  async test(owner: Owner, id: string): Promise<IntegrationView & { fetchedModels: string[] }> {
    const row = await this.row(owner, id);
    const apiKey =
      row.source === 'server'
        ? (this.config.get('ANTHROPIC_API_KEY', { infer: true }) ?? null)
        : row.apiKeyEnc === null
          ? null
          : decryptSecret(row.apiKeyEnc, this.key).toString();
    let fetchedModels: string[] = [];
    let outcome: { status: 'ok' | 'failing'; lastError: string | null };
    try {
      fetchedModels = await this.provider.listModels({
        source: row.source === 'server' ? 'server' : 'custom',
        provider: row.provider as AiProviderType,
        apiKey,
        baseUrl: row.baseUrl,
      });
      outcome = { status: 'ok', lastError: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = { status: 'failing', lastError: scrubKey(message, apiKey).slice(0, 500) };
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.aiIntegration.update({
        where: { id },
        data: { ...outcome, lastCheckedAt: new Date() },
      });
      await audit(tx, {
        organizationId: row.organizationId,
        actorUserId: owner.userId,
        action: 'ai_integration.tested',
        resourceType: 'ai_integration',
        resourceId: id,
        metadata: { ok: outcome.status === 'ok' },
      });
      return next;
    });
    return { ...this.view(updated), fetchedModels };
  }

  // --- grants (org integrations only; a personal one never matches → 404) ---------------------

  /** The org integration's org, and which projects the caller may see grants on. */
  private async grantScope(
    userId: string,
    orgSlug: string,
    id: string,
  ): Promise<{ organizationId: string; openable: (ids: string[]) => Promise<Set<string>> }> {
    const { organizationId, role } = await this.adminMember(userId, orgSlug);
    await this.rowIn({ organizationId }, id);
    // R13: owners see every project; an admin only those they can open. Another project's
    // grant is invisible, as if it weren't there.
    const openable = async (ids: string[]): Promise<Set<string>> => {
      if (role === 'owner' || ids.length === 0) return new Set(ids);
      const maps = await this.resolver.resolveProjects(
        { kind: 'user', userId, orgId: organizationId },
        ids,
      );
      return new Set(
        [...maps].filter(([, map]) => this.resolver.canOpenProject(map)).map(([pid]) => pid),
      );
    };
    return { organizationId, openable };
  }

  async listGrants(userId: string, orgSlug: string, id: string): Promise<GrantView[]> {
    const { openable } = await this.grantScope(userId, orgSlug, id);
    const grants = await this.prisma.aiIntegrationGrant.findMany({
      where: { integrationId: id },
      select: GRANT_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    const visible = await openable(
      grants.flatMap((g) => (g.projectId === null ? [] : [g.projectId])),
    );
    return grants.filter((g) => g.projectId === null || visible.has(g.projectId)).map(grantView);
  }

  async addGrant(
    userId: string,
    orgSlug: string,
    id: string,
    input: GrantInput,
  ): Promise<GrantView> {
    const { organizationId, openable } = await this.grantScope(userId, orgSlug, id);
    if (
      input.projectId !== null &&
      ((await this.prisma.project.findFirst({
        where: { id: input.projectId, organizationId, deletedAt: null },
        select: { id: true },
      })) === null ||
        !(await openable([input.projectId])).has(input.projectId))
    ) {
      throw notFound();
    }
    if (
      input.userId !== null &&
      (await this.prisma.orgMember.findFirst({
        where: { organizationId, userId: input.userId },
        select: { id: true },
      })) === null
    ) {
      throw notFound();
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const grant = await tx.aiIntegrationGrant.create({
          data: { integrationId: id, ...input, createdById: userId },
          select: GRANT_SELECT,
        });
        await audit(tx, {
          organizationId,
          projectId: input.projectId,
          actorUserId: userId,
          action: 'ai_integration_grant.added',
          resourceType: 'ai_integration_grant',
          resourceId: grant.id,
          metadata: { ...input },
        });
        return grantView(grant);
      });
    } catch (error) {
      if ((error as { code?: unknown }).code === 'P2002') {
        throw new ConflictException({ code: 'ai_grant_exists' });
      }
      throw error;
    }
  }

  async removeGrant(userId: string, orgSlug: string, id: string, grantId: string): Promise<void> {
    const { organizationId, openable } = await this.grantScope(userId, orgSlug, id);
    const grant = await this.prisma.aiIntegrationGrant.findFirst({
      where: { id: grantId, integrationId: id },
      select: { projectId: true, userId: true },
    });
    if (
      grant === null ||
      (grant.projectId !== null && !(await openable([grant.projectId])).has(grant.projectId))
    ) {
      throw notFound();
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.aiIntegrationGrant.delete({ where: { id: grantId } });
      await audit(tx, {
        organizationId,
        projectId: grant.projectId,
        actorUserId: userId,
        action: 'ai_integration_grant.removed',
        resourceType: 'ai_integration_grant',
        resourceId: grantId,
        metadata: grant,
      });
    });
  }

  // --- choices ---------------------------------------------------------------------------------

  /** The `(organizationId, projectId, userId)` a scope writes, after its access check. */
  private async choiceKey(
    scope: ChoiceScope,
  ): Promise<{ organizationId: string; projectId: string | null; userId: string | null }> {
    if (scope.kind === 'org') {
      return {
        organizationId: await this.adminOrg(scope.userId, scope.orgSlug),
        projectId: null,
        userId: null,
      };
    }
    if (scope.kind === 'project') {
      const project = await this.prisma.project.findFirst({
        where: { id: scope.projectId, deletedAt: null },
        select: { organizationId: true },
      });
      if (project === null) throw notFound();
      return { organizationId: project.organizationId, projectId: scope.projectId, userId: null };
    }
    const organizationId = await this.memberOrg(scope.userId, scope.orgSlug);
    if (scope.projectId !== null) {
      const project = await this.prisma.project.findFirst({
        where: { id: scope.projectId, organizationId, deletedAt: null },
        select: { id: true },
      });
      const map =
        project === null
          ? null
          : await this.resolver.resolveProject(
              { kind: 'user', userId: scope.userId, orgId: organizationId },
              scope.projectId,
            );
      if (map === null || !this.resolver.canOpenProject(map)) throw notFound();
    }
    return { organizationId, projectId: scope.projectId, userId: scope.userId };
  }

  listChoices(scope: MeChoiceScope): Promise<MeChoicesView>;
  listChoices(scope: OrgChoiceScope | ProjectChoiceScope): Promise<ChoiceView[]>;
  async listChoices(scope: ChoiceScope): Promise<ChoiceView[] | MeChoicesView> {
    const key = await this.choiceKey(scope);
    // `me` without a project: the member's defaults plus every per-project override in the org.
    const rows = await this.prisma.aiAbilityChoice.findMany({
      where:
        scope.kind === 'me' && key.projectId === null
          ? { organizationId: key.organizationId, userId: key.userId }
          : key,
      select: CHOICE_SELECT,
      orderBy: [{ ability: 'asc' }, { updatedAt: 'asc' }],
    });
    const choices = rows.map(choiceView);
    if (scope.kind !== 'me') return choices;
    const { rows: usable, personalAllowed } = await this.usable(
      scope.userId,
      key.organizationId,
      key.projectId,
    );
    return { choices, usableIntegrations: usable.map((r) => this.view(r)), personalAllowed };
  }

  /**
   * What the member may pick from: granted org integrations (for a project, as the resolver
   * would; without one, a `*` grant or one naming the member in any project) and, when the
   * org's policy allows, their own personal ones of an allowed provider.
   */
  private async usable(
    userId: string,
    organizationId: string,
    projectId: string | null,
  ): Promise<{ rows: AiIntegration[]; personalAllowed: boolean }> {
    const [rows, org] = await Promise.all([
      this.prisma.aiIntegration.findMany({
        where: { OR: [{ organizationId }, { ownerUserId: userId }] },
        orderBy: [{ source: 'desc' }, { createdAt: 'asc' }],
      }),
      this.prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { settings: true },
      }),
    ]);
    const grants = await this.prisma.aiIntegrationGrant.findMany({
      where: {
        integrationId: { in: rows.filter((r) => r.organizationId !== null).map((r) => r.id) },
      },
      select: { integrationId: true, projectId: true, userId: true },
    });
    const policy = readOrgSettings(org.settings).ai;
    const input = {
      userId,
      projectId: projectId ?? '',
      integrations: [],
      grants:
        projectId === null
          ? grants
              .filter((g) => (g.projectId === null && g.userId === null) || g.userId === userId)
              .map((g) => ({ ...g, projectId: null }))
          : grants,
      choices: [],
      policy,
      serverModels: this.router.serverModels(),
    };
    return {
      rows: rows.filter((r) =>
        isUsable(input, {
          ...r,
          source: r.source as 'server' | 'custom',
          provider: r.provider as AiProviderType,
        }),
      ),
      personalAllowed: policy.allowPersonalIntegrations,
    };
  }

  async putChoice(scope: ChoiceScope, input: ChoiceInput): Promise<ChoiceView> {
    const key = await this.choiceKey(scope);
    if (scope.kind === 'me' && input.locked) {
      throw new UnprocessableEntityException({
        code: 'ai_lock_not_allowed',
        message: 'Only an org or project default can be locked.',
      });
    }
    // A member picks only from what they can use, checked before the model so an ungranted
    // integration's model list can't be probed.
    const integration =
      scope.kind === 'me'
        ? ((await this.usable(scope.userId, key.organizationId, key.projectId)).rows.find(
            (r) => r.id === input.integrationId,
          ) ?? null)
        : await this.prisma.aiIntegration.findFirst({
            where: { id: input.integrationId, organizationId: key.organizationId },
          });
    if (integration === null) {
      throw new UnprocessableEntityException({
        code: 'ai_integration_not_in_org',
        message: 'That integration is not available here.',
      });
    }
    const models =
      integration.source === 'server' ? this.router.serverModels() : integration.allowedModels;
    if (!models.includes(input.model)) {
      throw new UnprocessableEntityException({
        code: 'ai_model_not_allowed',
        message: 'That model is not offered by the integration.',
      });
    }
    // findFirst + update/create: Prisma's upsert can't target the NULLS NOT DISTINCT index.
    return this.prisma.$transaction(async (tx) => {
      const where = { ...key, ability: input.ability };
      const existing = await tx.aiAbilityChoice.findFirst({ where, select: { id: true } });
      const data = {
        integrationId: input.integrationId,
        model: input.model,
        locked: input.locked,
        updatedById: scope.userId,
      };
      const row =
        existing === null
          ? await tx.aiAbilityChoice.create({
              data: { ...where, ...data },
              select: { id: true, ...CHOICE_SELECT },
            })
          : await tx.aiAbilityChoice.update({
              where: { id: existing.id },
              data,
              select: { id: true, ...CHOICE_SELECT },
            });
      await audit(tx, {
        organizationId: key.organizationId,
        projectId: key.projectId,
        actorUserId: scope.userId,
        action: 'ai_choice.set',
        resourceType: 'ai_choice',
        resourceId: row.id,
        metadata: {
          ability: input.ability,
          projectId: key.projectId,
          userId: key.userId,
          model: input.model,
          locked: input.locked,
        },
      });
      const { id: _id, ...view } = row;
      return choiceView(view);
    });
  }

  /** Clearing a choice that isn't there is a no-op. */
  async clearChoice(scope: ChoiceScope, ability: AiAbility): Promise<void> {
    const key = await this.choiceKey(scope);
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.aiAbilityChoice.findFirst({
        where: { ...key, ability },
        select: { id: true, model: true, locked: true },
      });
      if (row === null) return;
      await tx.aiAbilityChoice.delete({ where: { id: row.id } });
      await audit(tx, {
        organizationId: key.organizationId,
        projectId: key.projectId,
        actorUserId: scope.userId,
        action: 'ai_choice.cleared',
        resourceType: 'ai_choice',
        resourceId: row.id,
        metadata: {
          ability,
          projectId: key.projectId,
          userId: key.userId,
          model: row.model,
          locked: row.locked,
        },
      });
    });
  }
}
