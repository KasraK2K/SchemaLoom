import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readOrgSettings } from '@schemaloom/contracts';
import type { AiTarget } from '../ai/ai.provider';
import { decryptSecret } from '../auth/totp';
import type { AppEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import {
  AI_ABILITIES,
  PROVIDER_CAPABILITIES,
  type AiAbility,
  type AiProviderType,
} from './abilities';
import {
  isUsable,
  resolveChoice,
  usableModels,
  type IntegrationRow,
  type ResolutionStep,
  type ResolveInput,
} from './resolve';

const INTEGRATION_SELECT = {
  id: true,
  ownerUserId: true,
  source: true,
  provider: true,
  name: true,
  allowedModels: true,
  apiKeyEnc: true,
  baseUrl: true,
} as const;

/** An integration as the router needs it: the resolver's row plus what a target or the options view reads. */
interface LoadedIntegration extends IntegrationRow {
  readonly name: string;
  readonly apiKeyEnc: string | null;
  readonly baseUrl: string | null;
}

export interface AiOptionsView {
  readonly abilities: readonly {
    readonly id: AiAbility;
    readonly label: string;
    readonly strictOutput: boolean;
    readonly resolved: {
      readonly integrationId: string;
      readonly model: string;
      readonly step: ResolutionStep;
    } | null;
    readonly lock: { readonly scope: 'project' | 'org'; readonly usable: boolean } | null;
  }[];
  readonly integrations: readonly {
    readonly id: string;
    readonly name: string;
    readonly provider: AiProviderType;
    readonly source: 'server' | 'custom';
    readonly personal: boolean;
    readonly models: readonly string[];
    readonly capabilities: {
      readonly caching: boolean;
      readonly thinking: boolean;
      readonly fallback: boolean;
    };
  }[];
}

/** Roadmap 24 §3 — every AI ability gets its integration and model here. */
@Injectable()
export class AiRouter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  /** env models for the server row: [AI_MODEL, ...AI_SERVER_MODELS] deduped, or [] without ANTHROPIC_API_KEY */
  serverModels(): string[] {
    if (!this.config.get('ANTHROPIC_API_KEY', { infer: true })) return [];
    return [
      ...new Set([
        this.config.get('AI_MODEL', { infer: true }),
        ...this.config.get('AI_SERVER_MODELS', { infer: true }),
      ]),
    ];
  }

  private async load(
    userId: string,
    projectId: string,
    organizationId: string,
    ability: AiAbility | null,
  ): Promise<{ input: ResolveInput; integrations: LoadedIntegration[] }> {
    const [rows, org, choices] = await Promise.all([
      this.prisma.aiIntegration.findMany({
        where: { OR: [{ organizationId }, { ownerUserId: userId }] },
        select: INTEGRATION_SELECT,
      }),
      this.prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { settings: true },
      }),
      ability === null
        ? Promise.resolve([])
        : this.prisma.aiAbilityChoice.findMany({
            where: {
              organizationId,
              ability,
              OR: [{ projectId: null }, { projectId }],
              AND: [{ OR: [{ userId: null }, { userId }] }],
            },
            select: {
              projectId: true,
              userId: true,
              integrationId: true,
              model: true,
              locked: true,
            },
          }),
    ]);
    // The DB CHECKs pin source and provider, so the narrowing is safe.
    const integrations = rows.map((r): LoadedIntegration => ({
      ...r,
      source: r.source as IntegrationRow['source'],
      provider: r.provider as AiProviderType,
    }));
    const grants = await this.prisma.aiIntegrationGrant.findMany({
      where: {
        integrationId: { in: integrations.filter((i) => i.ownerUserId === null).map((i) => i.id) },
      },
      select: { integrationId: true, projectId: true, userId: true },
    });
    const input: ResolveInput = {
      userId,
      projectId,
      integrations,
      grants,
      choices,
      policy: readOrgSettings(org.settings).ai,
      serverModels: this.serverModels(),
    };
    return { input, integrations };
  }

  /** The integration's key in plain text; throws when SECRETS_ENCRYPTION_KEY no longer opens it. */
  apiKeyOf(row: {
    source: string;
    apiKeyEnc: string | null;
  }): string | null {
    if (row.source === 'server') return this.config.get('ANTHROPIC_API_KEY', { infer: true }) ?? null;
    if (row.apiKeyEnc === null) return null;
    return decryptSecret(
      row.apiKeyEnc,
      this.config.get('SECRETS_ENCRYPTION_KEY', { infer: true }),
    ).toString();
  }

  private target(row: LoadedIntegration, model: string): AiTarget {
    let apiKey: string | null;
    try {
      apiKey = this.apiKeyOf(row);
    } catch {
      // A rotated SECRETS_ENCRYPTION_KEY: the key must be entered again.
      throw new ServiceUnavailableException({ code: 'ai_integration_undecryptable' });
    }
    return {
      integrationId: row.id,
      source: row.source,
      provider: row.provider,
      model,
      apiKey,
      baseUrl: row.baseUrl,
      personal: row.ownerUserId !== null,
    };
  }

  /** 503 ai_no_model / ai_locked_model_unavailable */
  async resolve(
    userId: string,
    projectId: string,
    organizationId: string,
    ability: AiAbility,
  ): Promise<AiTarget> {
    const { input, integrations } = await this.load(userId, projectId, organizationId, ability);
    const r = resolveChoice(input);
    if (r.kind === 'none') throw new ServiceUnavailableException({ code: 'ai_no_model' });
    if (r.kind === 'locked_unavailable') {
      throw new ServiceUnavailableException({
        code: 'ai_locked_model_unavailable',
        scope: r.scope,
      });
    }
    const row = integrations.find((i) => i.id === r.integrationId);
    // resolveChoice only returns ids from input.integrations
    if (row === undefined) throw new ServiceUnavailableException({ code: 'ai_no_model' });
    return this.target(row, r.model);
  }

  /** the job re-check (§3.4): the same target if still usable, else null */
  async usableTarget(
    userId: string,
    projectId: string,
    organizationId: string,
    integrationId: string,
    model: string,
  ): Promise<AiTarget | null> {
    const { input, integrations } = await this.load(userId, projectId, organizationId, null);
    const row = integrations.find((i) => i.id === integrationId);
    if (row === undefined || !isUsable(input, row) || !usableModels(input, row).includes(model)) {
      return null;
    }
    return this.target(row, model);
  }

  async options(userId: string, projectId: string, organizationId: string): Promise<AiOptionsView> {
    const abilities = await Promise.all(
      AI_ABILITIES.map(async (a) => {
        const { input } = await this.load(userId, projectId, organizationId, a.id);
        const r = resolveChoice(input);
        const locked = input.choices.filter((c) => c.locked && c.userId === null);
        const scope = locked.some((c) => c.projectId === projectId)
          ? ('project' as const)
          : locked.some((c) => c.projectId === null)
            ? ('org' as const)
            : null;
        return {
          id: a.id,
          label: a.label,
          strictOutput: a.strictOutput,
          resolved:
            r.kind === 'ok'
              ? { integrationId: r.integrationId, model: r.model, step: r.step }
              : null,
          lock: scope === null ? null : { scope, usable: r.kind === 'ok' },
        };
      }),
    );
    const { input, integrations } = await this.load(userId, projectId, organizationId, null);
    return {
      abilities,
      integrations: integrations
        .filter((i) => isUsable(input, i))
        .map((i) => ({
          id: i.id,
          name: i.name,
          provider: i.provider,
          source: i.source,
          personal: i.ownerUserId !== null,
          models: [...usableModels(input, i)],
          capabilities: PROVIDER_CAPABILITIES[i.provider],
        })),
    };
  }
}
