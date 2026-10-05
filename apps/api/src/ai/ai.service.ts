import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { aiMessageMetaSchema, type AiMessageMeta, type Selection } from '@schemaloom/contracts';
import {
  DEFAULT_AI_CONTEXT_OPTIONS,
  createTaggedBlockStream,
  defaultJoinPaths,
  renderStatements,
  type AiProfile,
  type EngineRegistry,
  type QueryValidationResult,
} from '@schemaloom/engine-sdk';
import {
  fieldVisibilityIndex,
  type FieldVisibilityIndex,
  type RedactedModel,
  type SchemaModel,
  type VisibilityContext,
} from '@schemaloom/schema-model';
import { ORM_AI_GUIDANCE, subsetModel, type OrmId } from '@schemaloom/orm';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  PermissionResolver,
  VisibilityFilter,
  type PermissionAtom,
  type ProjectPermissionMap,
  type ProjectSkeleton,
  type Subject,
} from '../access';
import { DocsService } from '../docs';
import { ENGINE_REGISTRY } from '../engines';
import type { AiMessage, AiThread, DocDraft, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_RATELIMIT } from '../redis/redis.tokens';
import { identifiersResolved } from '../saved-queries/saved-queries.service';
import { renderOrmCode } from '../jobs/orm-code';
import { SchemaLoader } from '../schema';
import { ChangeRequestsService, type AgentProposal } from '../snapshots';
import { AiProvider, type AiResult } from './ai.provider';
import { draftSummary, type DraftSummary } from './draft-summary';
import { aiSettings } from './ai-settings';

/**
 * DESIGN §4 — the AI assistant: threads, streamed turns, doc drafts, draft-schema.
 *
 * THE RULES THIS FILE EXISTS TO KEEP (doc 05 L12, L13, L25, §5):
 *  - The context is `aiProfile.serializeContext(redactedModel, …)` over the CALLER's current
 *    view. Nothing hidden is in the string, so there is nothing to ask the model to ignore.
 *  - `ai:use` is required at EVERY entity the context is built from (the doc 05 worked example:
 *    one unauthorised entity is a 403), ANDed with `projects.settings.ai.enabled`.
 *  - The produced query is validated against the same redacted model with NO restrictedProbe
 *    (L13); a guessed hidden name reads exactly like a typo.
 *  - Every stored message carries `touchedEntityIds/FieldIds`; a thread is readable and
 *    replayable only while EVERY message passes `filterQueryRows` under the current context,
 *    otherwise it 404s whole (L25). An assistant message's entity set is the validator's
 *    touched set PLUS the entities its context was built from, because the explanation may
 *    name any table it was shown — so narrowing a user away from any of them retires the
 *    thread rather than replaying its prose.
 *
 * Refusal order on every route: 404 (invisible), 403 (`ai:use`, kill switch), 503 (no API
 * key), 429 (rate limit) — so the permission answer is the same on a server without a key.
 */

export const AI_DOC_DRAFTS_QUEUE = 'ai-doc-drafts';
export const AI_DOC_DRAFTS = Symbol('AI_DOC_DRAFTS');
/** The enqueue half of the doc-draft queue — a BullMQ `Queue` satisfies it structurally. */
export interface DocDraftQueue {
  add(name: string, data: DocDraftJobData, opts?: unknown): Promise<{ id?: string | undefined }>;
}
export interface DocDraftJobData {
  readonly projectId: string;
  readonly subject: Subject;
  readonly entityIds: readonly string[];
}

/** DESIGN §4.3 — fixed windows, both failing closed (a Redis error propagates, never admits). */
export const AI_RATE_LIMITS = {
  user: { limit: 30, windowSec: 3600 },
  org: { limit: 300, windowSec: 3600 },
} as const;

export interface AiMessageView {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly ordinal: number;
  readonly content: string;
  readonly queryText: string | null;
  /** Phase 18 — a code-mode answer's ORM code; null otherwise */
  readonly code: string | null;
  /** parsed from an assistant message's blocks; '' for a user message */
  readonly explanation: string;
  readonly metadata: AiMessageMeta;
  readonly createdAt: Date;
}

export interface AiThreadView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly selection: Selection;
  readonly lastMessageAt: Date | null;
  readonly createdAt: Date;
}

export interface DocDraftView {
  readonly id: string;
  readonly targetType: 'entity' | 'field';
  readonly targetId: string;
  readonly plainText: string;
  readonly createdAt: Date;
}

/** One caller's view of one project, resolved once per request. */
interface CallerView {
  readonly subject: Subject & { kind: 'user' };
  readonly projectId: string;
  readonly projectName: string;
  readonly organizationId: string;
  readonly aiEnabled: boolean;
  readonly includeDocs: boolean;
  readonly map: ProjectPermissionMap;
  readonly skel: ProjectSkeleton;
  readonly ctx: VisibilityContext;
  readonly redacted: RedactedModel;
  readonly fieldVis: FieldVisibilityIndex;
}

/** What a streamed turn needs, resolved and authorised BEFORE the SSE response starts, so
 *  every refusal is an ordinary HTTP status. */
export interface PreparedTurn {
  readonly view: CallerView;
  readonly thread: AiThread;
  readonly history: readonly AiMessage[];
  readonly mode: 'query' | 'explain' | 'code';
  /** Phase 18 — code mode's ORM, checked against the engine's export formats */
  readonly orm: OrmId | null;
  readonly userContent: string;
  /** explain mode: the query the user supplied, validated for the user row's touched ids */
  readonly explainQuery: string | null;
  readonly contextEntityIds: readonly string[];
  readonly profile: AiProfile;
}

export type AiStreamEmit = (event: string, data: unknown) => void;

export interface DraftSchemaResult {
  readonly source: string;
  readonly importFormat: string;
  readonly warnings: readonly string[];
  /** Phase 22 — what the importer reads in the draft; null when it can't read it */
  readonly summary: DraftSummary | null;
}

const notFound = (resourceType: string, id: string): NotFoundException =>
  new NotFoundException({ code: 'not_found', resourceType, id });

const CONTEXT_OPTIONS = DEFAULT_AI_CONTEXT_OPTIONS;

@Injectable()
export class AiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly loader: SchemaLoader,
    private readonly filter: VisibilityFilter,
    private readonly resolver: PermissionResolver,
    private readonly provider: AiProvider,
    @Inject(ENGINE_REGISTRY) private readonly registry: EngineRegistry,
    @Inject(REDIS_RATELIMIT) private readonly rateLimit: Redis,
    @Inject(AI_DOC_DRAFTS) private readonly drafts: DocDraftQueue,
    private readonly docs: DocsService,
    private readonly changeRequests: ChangeRequestsService,
  ) {}

  // --- threads ------------------------------------------------------------------------------

  async listThreads(
    subject: Subject,
    projectId: string,
    map: ProjectPermissionMap,
  ): Promise<AiThreadView[]> {
    const view = await this.view(subject, projectId, map);
    this.provider.assertConfigured();
    const threads = await this.prisma.aiThread.findMany({
      where: { projectId, userId: view.subject.userId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
    const out: AiThreadView[] = [];
    for (const thread of threads) {
      if (await this.threadPasses(thread, view)) out.push(threadView(thread));
    }
    return out;
  }

  async getThread(
    subject: Subject,
    id: string,
  ): Promise<AiThreadView & { messages: AiMessageView[] }> {
    const { thread, view, messages } = await this.visibleThread(subject, id);
    this.provider.assertConfigured();
    const profile = this.registry.tryGet(view.redacted.engineId)?.aiProfile;
    return { ...threadView(thread), messages: messages.map((m) => messageView(m, profile)) };
  }

  async createThread(
    subject: Subject,
    projectId: string,
    map: ProjectPermissionMap,
    body: { selection: Selection; title?: string | undefined },
  ): Promise<AiThreadView> {
    const view = await this.view(subject, projectId, map);
    this.profileFor(view);
    const entityIds = this.contextEntities(view, body.selection.entityIds, { strict: true });
    this.assertAiUse(view, entityIds);
    this.provider.assertConfigured();
    const thread = await this.prisma.aiThread.create({
      data: {
        projectId,
        userId: view.subject.userId,
        title: body.title ?? 'Untitled',
        selection: body.selection,
      },
    });
    return threadView(thread);
  }

  // --- one streamed turn --------------------------------------------------------------------

  async prepareTurn(
    subject: Subject,
    threadId: string,
    body: { content: string; mode: 'query' | 'explain' | 'code'; orm?: OrmId | undefined },
  ): Promise<PreparedTurn> {
    const { thread, view, messages } = await this.visibleThread(subject, threadId);
    const profile = this.profileFor(view);
    const orm = body.mode === 'code' ? (body.orm ?? null) : null;
    const engine = this.registry.tryGet(view.redacted.engineId);
    if (
      body.mode === 'code' &&
      (orm === null || engine?.capabilities.exportFormats.some((f) => f.id === orm) !== true)
    ) {
      throw new BadRequestException({ code: 'ai_orm_unsupported', orm });
    }
    const selection = selectionOf(thread);
    const contextEntityIds = this.contextEntities(view, selection.entityIds, { strict: false });
    if (selection.entityIds.length > 0 && contextEntityIds.length === 0) {
      // Everything selected is gone. Falling back to "the whole model" would WIDEN the
      // context the user chose; deleted and hidden look the same here, so no oracle.
      throw new ConflictException({ code: 'ai_selection_unavailable' });
    }
    this.assertAiUse(view, contextEntityIds);
    this.provider.assertConfigured();
    await this.throttle(view);
    const userContent =
      body.mode === 'explain'
        ? `Explain this query:\n<query>\n${body.content}\n</query>`
        : body.content;
    const explainQuery = body.mode === 'explain' ? body.content : null;
    return {
      view,
      thread,
      history: messages,
      mode: body.mode,
      orm,
      userContent,
      explainQuery,
      contextEntityIds,
      profile,
    };
  }

  async runTurn(
    turn: PreparedTurn,
    emit: AiStreamEmit,
    signal?: AbortSignal,
  ): Promise<AiMessageView> {
    const { view, thread, profile } = turn;
    const context = profile.serializeContext(view.redacted, {
      ...CONTEXT_OPTIONS,
      selectedEntityIds: selectionOf(thread).entityIds.length === 0 ? [] : turn.contextEntityIds,
      includeDocs: view.includeDocs,
    });
    let prefix = `${profile.buildSystemPrompt({
      projectName: view.projectName,
      serverVersion: view.redacted.engineVersion || null,
      mode: turn.mode,
    })}\n\n<schema>\n${context.text}\n</schema>`;
    let instructions = profile.outputInstructions[turn.mode];
    if (turn.orm !== null) {
      // Phase 18 §2.2 — the Models pane's text for the same selection, from the same redacted
      // view, so the AI writes against real class and field names.
      const engine = this.registry.tryGet(view.redacted.engineId);
      if (engine === undefined) throw new BadRequestException({ code: 'ai_orm_unsupported' });
      const models = await renderOrmCode(
        engine,
        view.redacted,
        turn.orm,
        selectionOf(thread).entityIds.length === 0 ? [] : turn.contextEntityIds,
        view.includeDocs,
      );
      prefix += `\n\n<models orm="${turn.orm}">\n${models.text}\n</models>`;
      instructions = `${instructions}\n${ORM_AI_GUIDANCE[turn.orm]}`;
    }

    // The user row first, with the ids its own text touches (an explained query is SQL too).
    const userCheck = turn.explainQuery === null ? null : await this.check(view, turn.explainQuery);
    const nextOrdinal = (turn.history[turn.history.length - 1]?.ordinal ?? -1) + 1;
    await this.prisma.aiMessage.create({
      data: {
        projectId: view.projectId,
        threadId: thread.id,
        role: 'user',
        ordinal: nextOrdinal,
        content: turn.userContent,
        touchedEntityIds: userCheck?.touchedEntityIds ?? [],
        touchedFieldIds: userCheck?.touchedFieldIds ?? [],
      },
    });

    const stream = createTaggedEmitter(emit);
    const result: AiResult = await this.provider.stream(
      {
        prefix,
        instructions,
        messages: [
          ...turn.history
            .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim() !== '')
            .map((m) => ({
              role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
              content: m.content,
            })),
          { role: 'user' as const, content: turn.userContent },
        ],
      },
      stream.push,
      signal,
    );
    stream.end();

    const refused = result.stopReason === 'refusal';
    const parsed = profile.parseOutput(result.text, turn.mode);
    const answered = parsed.mode === 'query' || parsed.mode === 'explain' || parsed.mode === 'code';
    // Code mode: `query` is the SQL twin. It is validated like Ask's, so L25's touched ids still
    // come from the validator, plus the context's entities below.
    const query = !refused && answered ? parsed.query : null;
    const assumptions = answered ? parsed.assumptions : [];
    const checked = query === null ? null : await this.check(view, query);
    const used = checked?.touchedEntityIds ?? [];
    const selected = new Set(turn.contextEntityIds);
    const metadata = aiMessageMetaSchema.parse({
      assumptions: assumptions.slice(0, 20).map((a) => a.slice(0, 500)),
      validation:
        checked === null
          ? null
          : { ok: checked.ok, unknownIdentifiers: checked.unknownIdentifiers.slice(0, 100) },
      usedEntityIds: used.slice(0, 200),
      suggestedEntityIds: this.suggestions(view, turn.contextEntityIds, used)
        .filter((id) => !selected.has(id))
        .slice(0, 50),
      finishReason: result.stopReason?.slice(0, 50) ?? null,
      orm: turn.orm,
    });
    const content =
      refused && result.text.trim() === ''
        ? 'The assistant declined to answer this request.'
        : result.text;

    const [stored] = await this.prisma.$transaction(async (tx) => [
      await tx.aiMessage.create({
        data: {
          projectId: view.projectId,
          threadId: thread.id,
          role: 'assistant',
          ordinal: nextOrdinal + 1,
          content,
          queryText: query,
          model: result.model,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          touchedEntityIds: [...new Set([...used, ...turn.contextEntityIds])],
          touchedFieldIds: checked?.touchedFieldIds ?? [],
          metadata,
        },
      }),
      await tx.aiThread.update({ where: { id: thread.id }, data: { lastMessageAt: new Date() } }),
    ]);
    return messageView(stored, profile);
  }

  // --- draft-schema (DESIGN §4.2) -----------------------------------------------------------

  /**
   * Phase 22 §2 — the AI sees the project as the assistant does: entities that are visible,
   * not restricted and carry `ai:use` (the rest are left out, not refused, so the AI never
   * learns they exist). `focusEntityIds` outside that set are dropped silently. `revise` is
   * stateless: the client's current draft goes back as the AI's own previous answer.
   */
  async draftSchema(
    subject: Subject,
    projectId: string,
    map: ProjectPermissionMap,
    body: {
      description: string;
      focusEntityIds?: readonly string[] | undefined;
      revise?: { draft: string; instruction: string } | undefined;
    },
  ): Promise<DraftSchemaResult> {
    const view = await this.view(subject, projectId, map);
    const profile = this.profileFor(view);
    this.assertAiUseAtProject(view);
    this.provider.assertConfigured();
    await this.throttle(view);

    const usable = new Set(
      this.contextEntities(view, [], { strict: false }).filter((id) =>
        this.has(view, 'ai:use', { type: 'entity', id }),
      ),
    );
    const focus = [...new Set(body.focusEntityIds ?? [])].filter((id) => usable.has(id));
    let prefix = profile.buildSystemPrompt({
      projectName: view.projectName,
      serverVersion: view.redacted.engineVersion || null,
      mode: 'draft-schema',
    });
    // An empty project sends no <schema> block (Phase 5 behaviour).
    if (usable.size > 0) {
      const context = profile.serializeContext(withoutEntities(view.redacted, usable), {
        ...CONTEXT_OPTIONS,
        selectedEntityIds: focus,
        includeDocs: view.includeDocs,
      });
      prefix += `\n\n<schema>\n${context.text}\n</schema>`;
    }
    const entities = view.redacted.objects.entity;
    const ask =
      focus.length === 0
        ? body.description
        : `${body.description}\n\nBuild on these tables: ${focus.map((id) => entities[id]?.name ?? id).join(', ')}`;
    const messages: { role: 'user' | 'assistant'; content: string }[] = [
      { role: 'user', content: ask },
    ];
    if (body.revise !== undefined) {
      messages.push(
        { role: 'assistant', content: `<ddl>\n${body.revise.draft}\n</ddl>` },
        {
          role: 'user',
          content: `Revise the draft: ${body.revise.instruction}\nChange only what this asks, and return the whole revised draft.`,
        },
      );
    }

    const result = await this.provider.stream(
      {
        prefix,
        instructions: profile.outputInstructions['draft-schema'],
        messages,
        // A whole application's DDL is long, and thinking shares this budget.
        maxTokens: 32_000,
      },
      () => undefined,
    );
    if (result.stopReason === 'refusal') throw new BadRequestException({ code: 'ai_refused' });
    // A cut-off answer ends mid-statement; handing it over would import half a schema.
    if (result.stopReason === 'max_tokens') {
      throw new BadRequestException({ code: 'ai_truncated' });
    }
    const parsed = profile.parseOutput(result.text, 'draft-schema');
    if (parsed.mode !== 'draft-schema' || parsed.source === '') {
      throw new BadRequestException({ code: 'ai_no_schema', warnings: parsed.parseWarnings });
    }
    const source = await this.withReferencedTables(
      view,
      usable,
      parsed.source,
      parsed.importFormat,
    );
    const imported = await this.readDraft(view, source, parsed.importFormat);
    return {
      source,
      importFormat: parsed.importFormat,
      warnings: parsed.parseWarnings,
      summary: imported === null ? null : draftSummary(view.redacted, imported),
    };
  }

  /**
   * The importer drops a foreign key whose target is not in the same source, so a draft
   * that only REFERENCES `customers` would import without its links. Existing tables the
   * draft names but doesn't declare are put in front, exported from the caller's own view:
   * the additive merge matches them, leaves them unchanged and points the new keys at them.
   */
  private async withReferencedTables(
    view: CallerView,
    usable: ReadonlySet<string>,
    source: string,
    format: string,
  ): Promise<string> {
    const engine = this.registry.tryGet(view.redacted.engineId);
    const declared = await this.readDraft(view, source, format);
    if (
      engine?.exporter === undefined ||
      declared === null ||
      !engine.capabilities.exportFormats.some((f) => f.id === format)
    ) {
      return source;
    }
    const names = new Set(Object.values(declared.objects.entity).map((e) => e.name.toLowerCase()));
    const entities = view.redacted.objects.entity;
    // ponytail: a name match, not a parse. A table named in a comment is added too, which
    // costs only an unchanged existing table in the draft.
    const referenced = [...usable].filter((id) => {
      const name = entities[id]?.name;
      return name !== undefined && !names.has(name.toLowerCase()) && mentions(source, name);
    });
    if (referenced.length === 0) return source;
    const result = await engine.exporter.export({
      model: subsetModel(withoutEntities(view.redacted, new Set(referenced)), referenced),
      options: {
        format,
        includeComments: false,
        includeDrops: false,
        includeIfNotExists: false,
        engineOptions: {},
      },
      context: { projectId: view.projectId, serverVersion: view.redacted.engineVersion },
    });
    const comment = engine.capabilities.queryLanguage.lineComment;
    return `${comment} Existing tables this draft refers to. The import leaves them unchanged.\n${renderStatements(result)}\n\n${comment} New\n${source}`;
  }

  /** The draft through the engine's importer; null when it can't be read (the import
   *  preview says why when the user tries it). */
  private async readDraft(
    view: CallerView,
    source: string,
    format: string,
  ): Promise<SchemaModel | null> {
    const engine = this.registry.tryGet(view.redacted.engineId);
    if (engine?.importer === undefined) return null;
    try {
      const { model } = await engine.importer.import(
        source,
        {
          format,
          defaultNamespace: engine.capabilities.defaultNamespaceName,
          caseFolding:
            engine.capabilities.identifiers.foldsTo === 'none'
              ? 'preserve'
              : engine.capabilities.identifiers.foldsTo,
          engineOptions: {},
        },
        {
          projectId: view.projectId,
          serverVersion: view.redacted.engineVersion,
          newId: randomUUID,
        },
      );
      return model;
    } catch {
      return null;
    }
  }

  // --- agents over MCP (Phase 21 §5) -------------------------------------------------------

  /**
   * One line per table, view or enum the built-in assistant could be shown. No AI provider:
   * no key needed, no AI rate limit (the token's own limit is the throttle).
   */
  async agentOutline(
    subject: Subject,
    projectId: string,
    map: ProjectPermissionMap,
    filter: { kind?: string | undefined; area?: string | undefined; namePattern?: string },
  ): Promise<{ lines: string[] }> {
    const { view, usable } = await this.agentView(subject, projectId, map);
    const { objects } = view.redacted;
    const nsName = (id: string) => objects.namespace[id]?.name ?? '';
    const pattern =
      filter.namePattern === undefined || filter.namePattern === ''
        ? null
        : new RegExp(
            `^${filter.namePattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
            'i',
          );
    const named = (ns: string, name: string) =>
      pattern === null || pattern.test(name) || pattern.test(`${ns}.${name}`);
    const area =
      filter.area === undefined
        ? null
        : Object.values(objects.area).find(
            (a) => a.id === filter.area || a.name.toLowerCase() === filter.area?.toLowerCase(),
          );
    if (area === undefined) return { lines: [] };
    const kind = filter.kind?.toLowerCase();

    const columns = new Map<string, number>();
    for (const f of Object.values(objects.field)) {
      if (f.restricted !== true && f.name !== '' && f.parentFieldId === null)
        columns.set(f.entityId, (columns.get(f.entityId) ?? 0) + 1);
    }
    const lines: string[] = [];
    for (const id of usable) {
      const e = objects.entity[id];
      if (e === undefined || (kind !== undefined && e.kind.toLowerCase() !== kind)) continue;
      if (area !== null && e.areaId !== area.id) continue;
      if (!named(nsName(e.namespaceId), e.name)) continue;
      const n = columns.get(id) ?? 0;
      const doc = view.includeDocs ? firstLine(e.doc?.excerpt) : '';
      lines.push(
        `${nsName(e.namespaceId)}.${e.name}  ${e.kind}  ${String(n)} column${n === 1 ? '' : 's'}${doc === '' ? '' : `  ${JSON.stringify(doc)}`}`,
      );
    }
    // Enums carry no ai:use of their own and no area; the assistant's context lists them too.
    if (area === null && (kind === undefined || kind === 'enum')) {
      for (const t of Object.values(objects.customType)) {
        if (t.restricted === true || t.name === '' || t.kind !== 'enum') continue;
        if (named(nsName(t.namespaceId), t.name))
          lines.push(`${nsName(t.namespaceId)}.${t.name}  enum`);
      }
    }
    return { lines: lines.sort() };
  }

  /**
   * `serializeContext` for the named tables plus the tables their keys point at, so foreign
   * keys read whole: the same text the assistant puts in its prompt. A name that doesn't
   * resolve is in `notFound`, missing and hidden alike (never "forbidden").
   */
  async agentContext(
    subject: Subject,
    projectId: string,
    map: ProjectPermissionMap,
    body: { names: readonly string[]; includeDocs?: boolean | undefined },
  ): Promise<{
    text: string;
    approxTokens: number;
    omitted: readonly { what: string; count: number }[];
    notFound: string[];
  }> {
    const { view, usable } = await this.agentView(subject, projectId, map);
    const profile = this.profileFor(view);
    const { objects } = view.redacted;
    const nsName = (id: string) => objects.namespace[id]?.name.toLowerCase() ?? '';
    const found = new Set<string>();
    const notFound: string[] = [];
    for (const raw of body.names) {
      const name = raw.trim().replace(/["`]/g, '').toLowerCase();
      const dot = name.lastIndexOf('.');
      const [ns, table] = dot === -1 ? [null, name] : [name.slice(0, dot), name.slice(dot + 1)];
      const hits = [...usable].filter((id) => {
        const e = objects.entity[id];
        return e?.name.toLowerCase() === table && (ns === null || nsName(e.namespaceId) === ns);
      });
      // A bare name in two schemas is ambiguous: the agent should qualify it.
      const [hit] = hits;
      if (hits.length === 1 && hit !== undefined) found.add(hit);
      else notFound.push(raw);
    }
    const keep = new Set(found);
    for (const l of Object.values(objects.link)) {
      if (l.restricted === true) continue;
      if (found.has(l.from.entityId) && usable.has(l.to.entityId)) keep.add(l.to.entityId);
      if (found.has(l.to.entityId) && usable.has(l.from.entityId)) keep.add(l.from.entityId);
    }
    if (found.size === 0) return { text: '', approxTokens: 0, omitted: [], notFound };
    const context = profile.serializeContext(withoutEntities(view.redacted, keep), {
      ...CONTEXT_OPTIONS,
      selectedEntityIds: [...found],
      includeDocs: body.includeDocs !== false && view.includeDocs,
    });
    return { ...context, notFound };
  }

  /**
   * Roadmap 21b §9.3 — an agent proposes a change. Step 1 here (`ai:use`, the switch); the
   * rest is `ChangeRequestsService.proposeFromAgent`. Existing tables the SQL only
   * references are declared in front, as for draft-schema, so its foreign keys survive.
   */
  async agentPropose(
    subject: Subject,
    projectId: string,
    map: ProjectPermissionMap,
    tokenId: string,
    body: { title: string; description?: string | undefined; sql: string },
  ): Promise<AgentProposal> {
    const { view, usable } = await this.agentView(subject, projectId, map);
    const format =
      this.registry.tryGet(view.redacted.engineId)?.capabilities.importFormats[0]?.id ?? 'ddl';
    const sql = await this.withReferencedTables(view, usable, body.sql, format);
    return this.changeRequests.proposeFromAgent(
      { projectId, subject: view.subject, actorUserId: view.subject.userId, map, skel: view.skel },
      {
        tokenId,
        title: body.title,
        ...(body.description === undefined ? {} : { description: body.description }),
        sql,
      },
    );
  }

  /** §5 steps 1–3: the caller's view, `ai:use` and the switch, then the usable entities. */
  private async agentView(
    subject: Subject,
    projectId: string,
    map: ProjectPermissionMap,
  ): Promise<{ view: CallerView; usable: Set<string> }> {
    const view = await this.view(subject, projectId, map);
    this.assertAiUseAtProject(view);
    const usable = new Set(
      this.contextEntities(view, [], { strict: false }).filter((id) =>
        this.has(view, 'ai:use', { type: 'entity', id }),
      ),
    );
    return { view, usable };
  }

  // --- doc drafts (DESIGN §4.2, Q5) ---------------------------------------------------------

  async enqueueDocDrafts(
    subject: Subject,
    projectId: string,
    map: ProjectPermissionMap,
    entityIds: readonly string[],
  ): Promise<{ jobId: string }> {
    const view = await this.view(subject, projectId, map);
    this.profileFor(view);
    const ids = this.contextEntities(view, entityIds, { strict: true });
    this.assertAiUse(view, ids);
    this.provider.assertConfigured();
    await this.throttle(view);
    const job = await this.drafts.add(
      'ai.doc-drafts',
      { projectId, subject: view.subject, entityIds: ids },
      {
        attempts: 1,
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 24 * 3_600, count: 1_000 },
      },
    );
    return { jobId: job.id ?? '' };
  }

  /** The worker. Permissions are re-resolved NOW, not trusted from enqueue time. */
  async runDocDraftJob(data: DocDraftJobData, jobId: string | null): Promise<{ drafted: number }> {
    if (!this.provider.configured) return { drafted: 0 };
    const view = await this.view(data.subject, data.projectId);
    const profile = this.profileFor(view);
    const ids = this.contextEntities(view, data.entityIds, { strict: false });
    this.assertAiUse(view, ids);

    const { objects } = view.redacted;
    const targets = new Map<string, 'entity' | 'field'>();
    const lines: string[] = [];
    for (const id of ids) {
      const entity = objects.entity[id];
      if (entity === undefined) continue;
      if (entity.doc === null) {
        targets.set(id, 'entity');
        lines.push(`entity ${id} ${entity.name}`);
      }
      for (const field of Object.values(objects.field)) {
        if (field.entityId !== id || field.doc !== null || view.fieldVis.get(field.id) !== 'full')
          continue;
        targets.set(field.id, 'field');
        lines.push(`field ${field.id} ${entity.name}.${field.name}`);
      }
    }
    if (targets.size === 0) return { drafted: 0 };

    const context = profile.serializeContext(view.redacted, {
      ...CONTEXT_OPTIONS,
      selectedEntityIds: ids,
      includeDocs: view.includeDocs,
    });
    const result = await this.provider.stream(
      {
        prefix: `${profile.buildSystemPrompt({
          projectName: view.projectName,
          serverVersion: view.redacted.engineVersion || null,
          mode: 'draft-docs',
        })}\n\n<schema>\n${context.text}\n</schema>`,
        instructions: profile.outputInstructions['draft-docs'],
        messages: [{ role: 'user', content: `Targets:\n${lines.join('\n')}` }],
      },
      () => undefined,
    );
    if (result.stopReason === 'refusal') return { drafted: 0 };
    const parsed = profile.parseOutput(result.text, 'draft-docs');
    if (parsed.mode !== 'draft-docs') return { drafted: 0 };

    let drafted = 0;
    for (const suggestion of parsed.suggestions) {
      // Untrusted model output: only a target we asked about, of the type we asked about.
      const type = targets.get(suggestion.target.id);
      if (type === undefined || type !== suggestion.target.type) continue;
      targets.delete(suggestion.target.id);
      await this.prisma.$transaction(async (tx) => {
        await tx.docDraft.deleteMany({
          where: { targetType: type, targetId: suggestion.target.id, status: 'pending' },
        });
        await tx.docDraft.create({
          data: {
            projectId: view.projectId,
            targetType: type,
            targetId: suggestion.target.id,
            status: 'pending',
            content: tiptap(suggestion.plainText.slice(0, 4_000)),
            jobId,
            createdById: view.subject.userId,
          },
        });
      });
      drafted += 1;
    }
    return { drafted };
  }

  async listDocDrafts(
    subject: Subject,
    projectId: string,
    map: ProjectPermissionMap,
  ): Promise<DocDraftView[]> {
    const view = await this.view(subject, projectId, map);
    this.provider.assertConfigured();
    const rows = await this.prisma.docDraft.findMany({
      where: { projectId, status: 'pending' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.filter((row) => this.targetVisible(view, row)).map(draftView);
  }

  async rejectDocDraft(subject: Subject, id: string): Promise<DocDraftView> {
    const { row, view } = await this.editableDraft(subject, id);
    this.provider.assertConfigured();
    const updated = await this.prisma.$transaction(async (tx) => {
      // `(targetType, targetId, status)` is unique: an older rejected draft makes room.
      await tx.docDraft.deleteMany({
        where: { targetType: row.targetType, targetId: row.targetId, status: 'rejected' },
      });
      return tx.docDraft.update({
        where: { id },
        data: { status: 'rejected', reviewedById: view.subject.userId, reviewedAt: new Date() },
      });
    });
    return draftView(updated);
  }

  /** Writes through `DocsService.write` — the single docs write path, which re-checks
   *  `docs:edit`, sanitises, derives the excerpt and broadcasts — then retires the draft. */
  async acceptDocDraft(subject: Subject, id: string): Promise<DocDraftView> {
    const { row, view } = await this.editableDraft(subject, id);
    this.provider.assertConfigured();
    await this.docs.write(subject, row.projectId, row.targetType, row.targetId, {
      content: row.content,
      ...(row.structured === null ? {} : { structured: row.structured }),
    });
    const updated = await this.prisma.$transaction(async (tx) => {
      // `(targetType, targetId, status)` is unique: an older accepted draft makes room.
      await tx.docDraft.deleteMany({
        where: { targetType: row.targetType, targetId: row.targetId, status: 'accepted' },
      });
      return tx.docDraft.update({
        where: { id },
        data: { status: 'accepted', reviewedById: view.subject.userId, reviewedAt: new Date() },
      });
    });
    return draftView(updated);
  }

  // --- internals ----------------------------------------------------------------------------

  private async view(
    subject: Subject,
    projectId: string,
    known?: ProjectPermissionMap,
  ): Promise<CallerView> {
    // A share-link subject has no AI surface at all (R21): not 403, it does not exist.
    if (subject.kind !== 'user') throw notFound('project', projectId);
    const map = known ?? (await this.resolver.resolveProject(subject, projectId));
    if (!this.resolver.canOpenProject(map)) throw notFound('project', projectId);
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
    });
    if (project === null) throw notFound('project', projectId);
    const skel = await this.resolver.skeleton(projectId);
    const ctx = this.filter.contextFrom(subject, projectId, map, skel);
    const redacted = this.filter.redactWith(
      await this.loader.load(projectId),
      subject,
      projectId,
      map,
      skel,
    );
    const ai = aiSettings(project.settings);
    return {
      subject,
      projectId,
      projectName: project.name,
      organizationId: project.organizationId,
      aiEnabled: ai.enabled,
      includeDocs: ai.includeDocsInContext,
      map,
      skel,
      ctx,
      redacted,
      fieldVis: fieldVisibilityIndex(redacted, ctx),
    };
  }

  /** Not the caller's, missing, in a project they cannot open, or failing L25 — one 404. */
  private async visibleThread(
    subject: Subject,
    id: string,
  ): Promise<{ thread: AiThread; view: CallerView; messages: AiMessage[] }> {
    if (subject.kind !== 'user') throw notFound('ai_thread', id);
    const thread = await this.prisma.aiThread.findFirst({ where: { id, userId: subject.userId } });
    if (thread === null) throw notFound('ai_thread', id);
    const view = await this.view(subject, thread.projectId).catch((error: unknown) => {
      throw error instanceof NotFoundException ? notFound('ai_thread', id) : error;
    });
    const messages = await this.messagesOf(thread.id);
    if (!this.messagesPass(messages, view)) throw notFound('ai_thread', id);
    return { thread, view, messages };
  }

  private messagesOf(threadId: string): Promise<AiMessage[]> {
    return this.prisma.aiMessage.findMany({ where: { threadId }, orderBy: { ordinal: 'asc' } });
  }

  private async threadPasses(thread: AiThread, view: CallerView): Promise<boolean> {
    return this.messagesPass(await this.messagesOf(thread.id), view);
  }

  /** L25: the touched arrays are always written from the validator (and the context), so
   *  they are meaningful for every row — `identifiersResolved` is true by construction. */
  private messagesPass(messages: readonly AiMessage[], view: CallerView): boolean {
    const rows = messages.map((m) => ({ ...m, identifiersResolved: true }));
    return this.filter.filterQueryRows(rows, view.ctx, view.fieldVis).length === rows.length;
  }

  private profileFor(view: CallerView): AiProfile {
    const profile = this.registry.tryGet(view.redacted.engineId)?.aiProfile;
    if (profile === undefined) {
      throw new BadRequestException({
        code: 'engine.feature-unsupported',
        engineId: view.redacted.engineId,
        feature: 'aiProfile',
      });
    }
    return profile;
  }

  /**
   * The entities a context is built from. Empty = every visible entity. `strict` (a new
   * selection) answers 404 for any id that is missing or invisible — the two are the same to
   * the caller; not strict (a thread's stored, best-effort selection) drops them.
   */
  private contextEntities(
    view: CallerView,
    requested: readonly string[],
    opts: { strict: boolean },
  ): string[] {
    const entities = view.redacted.objects.entity;
    const visible = (id: string): boolean =>
      entities[id] !== undefined && entities[id].restricted !== true;
    if (requested.length === 0) return Object.keys(entities).filter(visible).sort();
    const unique = [...new Set(requested)];
    if (opts.strict) {
      const missing = unique.find((id) => !visible(id));
      if (missing !== undefined) throw notFound('entity', missing);
    }
    return unique.filter(visible);
  }

  private has(
    view: CallerView,
    atom: PermissionAtom,
    ref: { type: 'project' | 'entity'; id: string },
  ): boolean {
    return this.resolver.atomsAt(view.map, view.skel, ref).has(atom);
  }

  /** `ai:use` at every entity, then the project kill switch (permission never overrides it). */
  private assertAiUse(view: CallerView, entityIds: readonly string[]): void {
    if (entityIds.length === 0) {
      this.assertAiUseAtProject(view);
      return;
    }
    const denied = entityIds.find((id) => !this.has(view, 'ai:use', { type: 'entity', id }));
    if (denied !== undefined)
      throw new ForbiddenException({ code: 'forbidden', atom: 'ai:use', entityId: denied });
    if (!view.aiEnabled) throw new ForbiddenException({ code: 'ai_disabled' });
  }

  private assertAiUseAtProject(view: CallerView): void {
    if (!this.has(view, 'ai:use', { type: 'project', id: view.projectId })) {
      throw new ForbiddenException({ code: 'forbidden', atom: 'ai:use' });
    }
    if (!view.aiEnabled) throw new ForbiddenException({ code: 'ai_disabled' });
  }

  /** DESIGN §4.3. Fails closed: a Redis error propagates and the request is refused. */
  private async throttle(view: CallerView): Promise<void> {
    const windows = [
      { key: `ai:user:${view.subject.userId}`, rule: AI_RATE_LIMITS.user },
      { key: `ai:org:${view.organizationId}`, rule: AI_RATE_LIMITS.org },
    ];
    for (const { key, rule } of windows) {
      const count = await this.rateLimit.incr(key);
      if (count === 1) await this.rateLimit.expire(key, rule.windowSec);
      if (count > rule.limit) {
        const ttl = await this.rateLimit.ttl(key);
        throw new HttpException(
          { code: 'ai_rate_limited', retryAfter: ttl > 0 ? ttl : rule.windowSec },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }

  /** The validator over the caller's redacted model. No `restrictedProbe`, ever (L13). */
  private async check(
    view: CallerView,
    query: string,
  ): Promise<{
    ok: boolean;
    unknownIdentifiers: string[];
    touchedEntityIds: string[];
    touchedFieldIds: string[];
  } | null> {
    const validator = this.registry.tryGet(view.redacted.engineId)?.queryValidator;
    if (validator === undefined) return null;
    const result: QueryValidationResult = await validator.validate({
      query,
      model: view.redacted,
      context: { projectId: view.projectId, serverVersion: view.redacted.engineVersion },
    });
    const entities = view.redacted.objects.entity;
    return {
      ok: identifiersResolved(result),
      unknownIdentifiers: [
        ...new Set(result.identifiers.filter((i) => i.status === 'unknown').map((i) => i.text)),
      ],
      touchedEntityIds: [...new Set(result.touchedEntityIds)].filter(
        (id) => entities[id]?.restricted !== true && id in entities,
      ),
      touchedFieldIds: [...new Set(result.touchedFieldIds)],
    };
  }

  /** Visible entities the query used or a join path needs, beyond the selection. */
  private suggestions(
    view: CallerView,
    selected: readonly string[],
    used: readonly string[],
  ): string[] {
    const profile = this.registry.tryGet(view.redacted.engineId)?.aiProfile;
    const input = {
      model: view.redacted,
      selectedEntityIds: [...new Set([...selected, ...used])],
      maxHops: 3,
      maxSuggestions: 5,
    };
    const paths = profile?.suggestJoinPaths?.(input) ?? defaultJoinPaths(input);
    return [...new Set([...used, ...paths.flatMap((p) => p.addedEntityIds)])];
  }

  private targetVisible(view: CallerView, row: Pick<DocDraft, 'targetType' | 'targetId'>): boolean {
    if (row.targetType === 'entity') {
      const entity = view.redacted.objects.entity[row.targetId];
      return entity !== undefined && entity.restricted !== true;
    }
    if (row.targetType === 'field') return view.fieldVis.get(row.targetId) === 'full';
    return false;
  }

  /** Visible (else 404), `docs:edit` at the target (else 403), still pending (else 409). */
  private async editableDraft(
    subject: Subject,
    id: string,
  ): Promise<{ row: DocDraft; view: CallerView }> {
    const row = await this.prisma.docDraft.findFirst({ where: { id } });
    if (row === null) throw notFound('doc_draft', id);
    const view = await this.view(subject, row.projectId).catch((error: unknown) => {
      throw error instanceof NotFoundException ? notFound('doc_draft', id) : error;
    });
    if (!this.targetVisible(view, row)) throw notFound('doc_draft', id);
    const entityId =
      row.targetType === 'entity'
        ? row.targetId
        : view.redacted.objects.field[row.targetId]?.entityId;
    if (entityId === undefined || !this.has(view, 'docs:edit', { type: 'entity', id: entityId })) {
      throw new ForbiddenException({ code: 'forbidden', atom: 'docs:edit' });
    }
    if (row.status !== 'pending') throw new ConflictException({ code: 'doc_draft_not_pending' });
    return { row, view };
  }
}

// --- pure helpers -----------------------------------------------------------------------------

/** The view without the entities outside `keep`. Every serializer drops the fields, links
 *  and indexes of an entity it doesn't have, so this is only ever narrower. */
function withoutEntities(model: RedactedModel, keep: ReadonlySet<string>): RedactedModel {
  const entity = Object.fromEntries(
    Object.entries(model.objects.entity).filter(([id]) => keep.has(id)),
  );
  return { ...model, objects: { ...model.objects, entity } };
}

const firstLine = (text: string | undefined): string =>
  (text ?? '').split('\n')[0]?.trim().slice(0, 160) ?? '';

/** `name` as a whole identifier in `text`, any case, bare or quoted. */
function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w$])${escaped}($|[^\\w$])`, 'i').test(text);
}

function selectionOf(thread: AiThread): Selection {
  const raw = (thread.selection ?? {}) as Partial<Selection>;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return {
    entityIds: list(raw.entityIds),
    fieldIds: list(raw.fieldIds),
    linkIds: list(raw.linkIds),
    areaIds: list(raw.areaIds),
  };
}

function threadView(thread: AiThread): AiThreadView {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    selection: selectionOf(thread),
    lastMessageAt: thread.lastMessageAt,
    createdAt: thread.createdAt,
  };
}

function messageView(message: AiMessage, profile: AiProfile | undefined): AiMessageView {
  const meta = aiMessageMetaSchema.safeParse(message.metadata ?? {});
  const metadata = meta.success ? meta.data : aiMessageMetaSchema.parse({});
  const parsed =
    message.role === 'assistant' && profile !== undefined
      ? profile.parseOutput(message.content, metadata.orm === null ? 'query' : 'code')
      : null;
  return {
    id: message.id,
    role: message.role === 'assistant' ? 'assistant' : 'user',
    ordinal: message.ordinal,
    content: message.content,
    queryText: message.queryText,
    code: parsed?.mode === 'code' ? parsed.code : null,
    explanation:
      parsed !== null &&
      (parsed.mode === 'query' || parsed.mode === 'explain' || parsed.mode === 'code')
        ? parsed.explanation
        : '',
    metadata,
    createdAt: message.createdAt,
  };
}

function tiptap(text: string): Prisma.InputJsonValue {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

/** Flattened TipTap text: every `text` node, paragraphs joined by newlines. */
export function plainTextOf(content: unknown): string {
  const node = content as { text?: unknown; content?: unknown } | null;
  if (node === null || typeof node !== 'object') return '';
  if (typeof node.text === 'string') return node.text;
  const type = (node as { type?: unknown }).type;
  return Array.isArray(node.content)
    ? node.content.map(plainTextOf).join(type === 'doc' ? '\n' : '')
    : '';
}

function draftView(row: DocDraft): DocDraftView {
  return {
    id: row.id,
    targetType: row.targetType === 'entity' ? 'entity' : 'field',
    targetId: row.targetId,
    plainText: plainTextOf(row.content),
    createdAt: row.createdAt,
  };
}

/** SSE out of `createTaggedBlockStream`. Kept tiny so the event order is testable. */
function createTaggedEmitter(emit: AiStreamEmit): {
  push: (text: string) => void;
  end: () => void;
} {
  const stream = createTaggedBlockStream();
  const send = (events: ReturnType<typeof stream.push>): void => {
    for (const event of events)
      emit(
        event.type,
        event.type === 'block-delta' ? { tag: event.tag, text: event.text } : { tag: event.tag },
      );
  };
  return {
    push: (text) => {
      send(stream.push(text));
    },
    end: () => {
      send(stream.end());
    },
  };
}
