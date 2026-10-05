import { HttpException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { EngineRegistry, QueryValidator } from '@schemaloom/engine-sdk';
import type { Redis } from 'ioredis';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  VisibilityFilter,
  type PermissionResolver,
  type ProjectPermissionMap,
  type ProjectSkeleton,
  type Subject,
} from '../access';
import type { AppEnv } from '../config/env';
import { ENGINE_MANIFEST } from '../engines/engines.manifest';
import { fakePrisma, type FakePrisma, type Row } from '../schema/fake-prisma';
import type { DocsService } from '../docs';
import type { ChangeRequestsService } from '../snapshots';
import { PROJECT, baseStore, entityRow, fieldRow, projectRow } from '../schema/fixture';
import { SchemaLoader } from '../schema/schema-loader.service';
import { AiController } from './ai.controller';
import { draftSchemaSchema } from './ai.dto';
import { AiProvider, type AiRequest } from './ai.provider';
import { AiService, type DocDraftQueue } from './ai.service';

/**
 * Doc 05 §12.1's analyst again. `ent_emp.fld_sal` is Restricted and she lacks
 * `field:viewRestricted`, so it is a mask stub in every view. In April she is narrowed to
 * `ent_emp`, so `ent_prod` is hidden.
 */

const ANA: Subject = { kind: 'user', userId: 'usr_ana', orgId: 'org_1' };
const mapOf = (s: Subject) =>
  ({ subjectKey: s.kind === 'user' ? s.userId : 'link' }) as ProjectPermissionMap;

interface View {
  visible: string[];
  /** entities holding `ai:use`; `'project'` for the project scope */
  ai: string[];
  docsEdit?: boolean;
}
const MARCH: View = { visible: ['ent_prod', 'ent_emp'], ai: ['project', 'ent_prod', 'ent_emp'] };
const APRIL: View = { visible: ['ent_emp'], ai: ['project', 'ent_emp'] };

const skel: ProjectSkeleton = {
  generation: 1,
  areaIds: [],
  entities: [
    { id: 'ent_prod', areaId: null },
    { id: 'ent_emp', areaId: null },
  ],
  entityById: new Map([
    ['ent_prod', { id: 'ent_prod', areaId: null }],
    ['ent_emp', { id: 'ent_emp', areaId: null }],
  ]),
  entitiesWithRestrictedFields: new Set(['ent_emp']),
};

function resolverFor(view: View): PermissionResolver {
  return {
    resolveProject: vi.fn(() => Promise.resolve(mapOf(ANA))),
    skeleton: vi.fn().mockResolvedValue(skel),
    canOpenProject: () => true,
    visibleEntityIds: () => new Set(view.visible),
    restrictedOkEntityIds: () => new Set<string>(),
    atomsAt: (_m: ProjectPermissionMap, _s: ProjectSkeleton, ref: { type: string; id: string }) => {
      const atoms = new Set(['schema:view']);
      if (view.ai.includes(ref.type === 'project' ? 'project' : ref.id)) atoms.add('ai:use');
      if (view.docsEdit === true) atoms.add('docs:edit');
      return atoms;
    },
  } as unknown as PermissionResolver;
}

const ANSWER =
  '<query>\nSELECT fld_emp_name FROM ent_emp\n</query>\n<explanation>\nNames.\n</explanation>\n<assumptions>\n- none\n</assumptions>';

function providerStub(
  answer = ANSWER,
  stopReason = 'end_turn',
): { provider: AiProvider; requests: AiRequest[] } {
  const requests: AiRequest[] = [];
  const provider = {
    configured: true,
    model: 'test-model',
    assertConfigured: () => undefined,
    stream: vi.fn((request: AiRequest, onText: (t: string) => void) => {
      requests.push(request);
      // Three-character chunks, so tags straddle chunk boundaries.
      for (let i = 0; i < answer.length; i += 3) onText(answer.slice(i, i + 3));
      return Promise.resolve({
        text: answer,
        stopReason,
        model: 'test-model',
        tokensIn: 10,
        tokensOut: 20,
      });
    }),
  } as unknown as AiProvider;
  return { provider, requests };
}

const validator: QueryValidator = {
  validate: vi.fn().mockResolvedValue({
    parsed: true,
    parseErrors: [],
    identifiers: [],
    touchedEntityIds: ['ent_emp'],
    touchedFieldIds: ['fld_emp_name'],
    hiddenReferences: [],
    statementKinds: ['SELECT'],
  }),
};

function harness(
  opts: {
    view?: View;
    provider?: AiProvider;
    seed?: Partial<Record<string, Row[]>>;
    counter?: number;
    settings?: unknown;
  } = {},
): {
  prisma: FakePrisma;
  service: AiService;
  add: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  propose: ReturnType<typeof vi.fn>;
} {
  const prisma = fakePrisma({
    ...baseStore({
      project: [
        projectRow({ name: 'Shop', organizationId: 'org_1', settings: opts.settings ?? {} }),
      ],
      entity: [entityRow('ent_prod'), entityRow('ent_emp')],
      field: [
        fieldRow('fld_prod_id', 'ent_prod'),
        fieldRow('fld_emp_name', 'ent_emp'),
        fieldRow('fld_sal', 'ent_emp', { position: 1, isRestricted: true }),
      ],
    }),
    ...opts.seed,
  });
  const resolver = resolverFor(opts.view ?? MARCH);
  const engine = ENGINE_MANIFEST[0];
  const registry = {
    tryGet: () => ({
      aiProfile: engine?.aiProfile,
      queryValidator: validator,
      exporter: engine?.exporter,
      importer: engine?.importer,
      capabilities: engine?.capabilities,
    }),
  } as unknown as EngineRegistry;
  let count = opts.counter ?? 0;
  const redis = {
    incr: vi.fn(() => Promise.resolve(++count)),
    expire: vi.fn(() => Promise.resolve(1)),
    ttl: vi.fn(() => Promise.resolve(1200)),
  } as unknown as Redis;
  const add = vi.fn(() => Promise.resolve({ id: 'job_1' }));
  const queue: DocDraftQueue = { add };
  const write = vi.fn(() => Promise.resolve({}));
  const propose = vi.fn(() => Promise.resolve({ changeRequestId: 'cr_1' }));
  const changeRequests = { proposeFromAgent: propose };
  const service = new AiService(
    prisma.client,
    new SchemaLoader(prisma.client),
    new VisibilityFilter(resolver),
    resolver,
    opts.provider ?? providerStub().provider,
    registry,
    redis,
    queue,
    { write } as unknown as DocsService,
    changeRequests as unknown as ChangeRequestsService,
  );
  return { prisma, service, add, write, propose };
}

const selection = (entityIds: string[]) => ({ entityIds, fieldIds: [], linkIds: [], areaIds: [] });

const threadRow = (over: Row = {}): Row => ({
  id: 'thr_1',
  projectId: PROJECT,
  userId: 'usr_ana',
  title: 'Untitled',
  selection: selection([]),
  lastMessageAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

describe('AiService — 503 without a key', () => {
  it('every route answers 503 once the caller is authorised, and writes nothing', async () => {
    const config = { get: () => undefined } as unknown as ConfigService<AppEnv, true>;
    const { service, prisma } = harness({
      provider: new AiProvider(config),
      view: { ...MARCH, docsEdit: true },
      seed: {
        aiThread: [threadRow()],
        docDraft: [
          {
            id: 'd1',
            projectId: PROJECT,
            targetType: 'entity',
            targetId: 'ent_emp',
            status: 'pending',
            content: {},
            createdAt: new Date(0),
          },
        ],
      },
    });
    const calls = [
      service.listThreads(ANA, PROJECT, mapOf(ANA)),
      service.createThread(ANA, PROJECT, mapOf(ANA), { selection: selection([]) }),
      service.getThread(ANA, 'thr_1'),
      service.prepareTurn(ANA, 'thr_1', { content: 'x', mode: 'query' }),
      service.draftSchema(ANA, PROJECT, mapOf(ANA), { description: 'a shop' }),
      service.enqueueDocDrafts(ANA, PROJECT, mapOf(ANA), ['ent_emp']),
      service.listDocDrafts(ANA, PROJECT, mapOf(ANA)),
      service.rejectDocDraft(ANA, 'd1'),
      service.acceptDocDraft(ANA, 'd1'),
    ];
    for (const call of calls) {
      await expect(call).rejects.toMatchObject({
        status: 503,
        response: { code: 'ai_not_configured' },
      });
    }
    expect(
      prisma.names().filter((n) => !n.endsWith('.findMany') && !n.endsWith('.findFirst')),
    ).toEqual([]);
  });

  it('a permission refusal is the same with or without a key', async () => {
    const config = { get: () => undefined } as unknown as ConfigService<AppEnv, true>;
    const { service } = harness({ provider: new AiProvider(config), view: { ...MARCH, ai: [] } });
    await expect(
      service.createThread(ANA, PROJECT, mapOf(ANA), { selection: selection(['ent_emp']) }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('AiService.createThread — ai:use at every selected entity', () => {
  it('403 when one selected entity lacks ai:use', async () => {
    const { service } = harness({ view: { ...MARCH, ai: ['project', 'ent_emp'] } });
    await expect(
      service.createThread(ANA, PROJECT, mapOf(ANA), {
        selection: selection(['ent_emp', 'ent_prod']),
      }),
    ).rejects.toMatchObject({ status: 403, response: { atom: 'ai:use', entityId: 'ent_prod' } });
    // An empty selection means every visible entity, so it is refused too.
    await expect(
      service.createThread(ANA, PROJECT, mapOf(ANA), { selection: selection([]) }),
    ).rejects.toMatchObject({
      status: 403,
    });
  });

  it('404, not 403, for a selected entity the caller cannot see', async () => {
    const { service } = harness({ view: APRIL });
    await expect(
      service.createThread(ANA, PROJECT, mapOf(ANA), { selection: selection(['ent_prod']) }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('403 ai_disabled when the project kill switch is off', async () => {
    const { service } = harness({ settings: { ai: { enabled: false } } });
    await expect(
      service.createThread(ANA, PROJECT, mapOf(ANA), { selection: selection(['ent_emp']) }),
    ).rejects.toMatchObject({ status: 403, response: { code: 'ai_disabled' } });
  });
});

describe('AiService turns', () => {
  it('sends a context with no hidden or restricted name, and stores both rows with touched ids', async () => {
    const { provider, requests } = providerStub();
    const { service, prisma } = harness({
      view: APRIL,
      provider,
      seed: { aiThread: [threadRow()] },
    });
    const turn = await service.prepareTurn(ANA, 'thr_1', {
      content: 'employee names',
      mode: 'query',
    });
    const events: string[] = [];
    const stored = await service.runTurn(turn, (event) => events.push(event));

    const context = `${requests[0]?.prefix ?? ''}\n${requests[0]?.instructions ?? ''}`;
    expect(context).toContain('T ent_emp');
    expect(context).toContain('fld_emp_name');
    expect(context).not.toContain('ent_prod');
    expect(context).not.toContain('fld_prod_id');
    expect(context).not.toContain('fld_sal');
    expect(context).toContain(
      'If answering requires a table or column that is not listed above, say so instead of guessing.',
    );

    expect(stored).toMatchObject({
      role: 'assistant',
      ordinal: 1,
      queryText: 'SELECT fld_emp_name FROM ent_emp',
      explanation: 'Names.',
    });
    expect(stored.metadata).toMatchObject({
      assumptions: ['none'],
      usedEntityIds: ['ent_emp'],
      finishReason: 'end_turn',
    });
    expect(prisma.store.aiMessage?.map((m) => [m.role, m.ordinal])).toEqual([
      ['user', 0],
      ['assistant', 1],
    ]);
    expect(prisma.store.aiMessage?.[1]).toMatchObject({
      touchedEntityIds: ['ent_emp'],
      touchedFieldIds: ['fld_emp_name'],
    });
    // Validated with no probe (L13).
    const input = (validator.validate as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
      restrictedProbe?: unknown;
    };
    expect(input.restrictedProbe).toBeUndefined();
    expect(events[0]).toBe('block-open');
    expect(events.at(-1)).toBe('block-close');
    expect(events.filter((e) => e === 'block-open')).toHaveLength(3);
  });

  it('code mode (Phase 18): models in the context, the SQL twin validated, L25 ids kept', async () => {
    const answer = [
      '<code>',
      'await db.select({ name: entEmp.fldEmpName }).from(entEmp);',
      '</code>',
      '<query>',
      'SELECT fld_emp_name FROM ent_emp',
      '</query>',
      '<explanation>',
      'Names.',
      '</explanation>',
    ].join('\n');
    const { provider, requests } = providerStub(answer);
    const { service, prisma } = harness({
      view: APRIL,
      provider,
      seed: { aiThread: [threadRow()] },
    });
    const turn = await service.prepareTurn(ANA, 'thr_1', {
      content: 'employee names',
      mode: 'code',
      orm: 'drizzle',
    });
    const stored = await service.runTurn(turn, () => undefined);

    const prefix = requests[0]?.prefix ?? '';
    expect(prefix).toContain('<models orm="drizzle">');
    expect(prefix).toContain("pgTable(\n  'ent_emp'");
    // The models come from the same redacted view: nothing hidden, no masked field.
    expect(prefix).not.toContain('ent_prod');
    expect(prefix).not.toContain('fld_sal');
    expect(requests[0]?.instructions).toContain('The ORM is Drizzle.');

    expect(stored).toMatchObject({
      code: 'await db.select({ name: entEmp.fldEmpName }).from(entEmp);',
      queryText: 'SELECT fld_emp_name FROM ent_emp',
      explanation: 'Names.',
    });
    expect(stored.metadata.orm).toBe('drizzle');
    expect(prisma.store.aiMessage?.[1]).toMatchObject({
      touchedEntityIds: ['ent_emp'],
      touchedFieldIds: ['fld_emp_name'],
    });
    // Read back from the store, the message is still a code answer.
    const reread = await service.getThread(ANA, 'thr_1');
    expect(reread.messages[1]?.code).toBe(stored.code);
  });

  it('code mode with no SQL twin still records every entity the AI was shown', async () => {
    const { provider } = providerStub('<code>\nfoo()\n</code>\n<explanation>x</explanation>');
    const { service, prisma } = harness({ provider, seed: { aiThread: [threadRow()] } });
    const turn = await service.prepareTurn(ANA, 'thr_1', {
      content: 'x',
      mode: 'code',
      orm: 'prisma',
    });
    await service.runTurn(turn, () => undefined);
    const touched = prisma.store.aiMessage?.[1]?.touchedEntityIds as string[] | undefined;
    expect([...(touched ?? [])].sort()).toEqual(['ent_emp', 'ent_prod']);
  });

  it('code mode refuses an ORM the engine does not export', async () => {
    const { service } = harness({ seed: { aiThread: [threadRow()] } });
    await expect(
      service.prepareTurn(ANA, 'thr_1', { content: 'x', mode: 'code' }),
    ).rejects.toMatchObject({ status: 400, response: { code: 'ai_orm_unsupported' } });
  });

  it('429 ai_rate_limited with retryAfter past the per-user window', async () => {
    const { service } = harness({ counter: 30, seed: { aiThread: [threadRow()] } });
    const error = await service
      .prepareTurn(ANA, 'thr_1', { content: 'x', mode: 'query' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
    expect((error as HttpException).getResponse()).toEqual({
      code: 'ai_rate_limited',
      retryAfter: 1200,
    });
  });

  it('L25: a thread with a message touching a now-hidden entity 404s whole and leaves the list', async () => {
    const seed = {
      aiThread: [threadRow()],
      aiMessage: [
        {
          id: 'm0',
          threadId: 'thr_1',
          projectId: PROJECT,
          role: 'user',
          ordinal: 0,
          content: 'q',
          queryText: null,
          touchedEntityIds: [],
          touchedFieldIds: [],
          metadata: {},
          createdAt: new Date(0),
        },
        {
          id: 'm1',
          threadId: 'thr_1',
          projectId: PROJECT,
          role: 'assistant',
          ordinal: 1,
          content: 'SELECT … FROM ent_prod',
          queryText: null,
          touchedEntityIds: ['ent_prod'],
          touchedFieldIds: [],
          metadata: {},
          createdAt: new Date(0),
        },
      ],
    };
    const march = harness({ seed });
    expect((await march.service.getThread(ANA, 'thr_1')).messages).toHaveLength(2);

    const april = harness({ view: APRIL, seed });
    await expect(april.service.getThread(ANA, 'thr_1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      april.service.prepareTurn(ANA, 'thr_1', { content: 'x', mode: 'query' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await april.service.listThreads(ANA, PROJECT, mapOf(ANA))).toEqual([]);
  });

  it('someone else’s thread is 404', async () => {
    const { service } = harness({ seed: { aiThread: [threadRow({ userId: 'usr_ben' })] } });
    await expect(service.getThread(ANA, 'thr_1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AiController SSE', () => {
  it('writes block events in order and then done', async () => {
    const { service } = harness({ seed: { aiThread: [threadRow()] } });
    const writes: string[] = [];
    const end = vi.fn();
    const res = {
      writableEnded: false,
      on: vi.fn(),
      status: vi.fn(),
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: (chunk: string) => writes.push(chunk),
      end,
    } as unknown as Response;
    const req = { auth: { kind: 'user', userId: 'usr_ana', orgId: 'org_1' } } as unknown as Request;
    const controller = new AiController(service);
    await controller.postMessage(req, res, 'thr_1', { content: 'names', mode: 'query' });

    const names = writes.map((w) => /^event: (\S+)/.exec(w)?.[1]);
    const tags = writes
      .filter((w) => w.startsWith('event: block-open'))
      .map((w) => (JSON.parse(w.split('data: ')[1] ?? '{}') as { tag: string }).tag);
    expect(tags).toEqual(['query', 'explanation', 'assumptions']);
    expect(names.at(-1)).toBe('done');
    expect(names.filter((n) => n === 'block-open')).toHaveLength(3);
    expect(names.filter((n) => n === 'block-close')).toHaveLength(3);
    expect(end).toHaveBeenCalled();
  });
});

describe('AiService doc drafts', () => {
  it('enqueues only after ai:use at every entity', async () => {
    const { service, add } = harness({ view: { ...MARCH, ai: ['ent_emp'] } });
    await expect(
      service.enqueueDocDrafts(ANA, PROJECT, mapOf(ANA), ['ent_emp', 'ent_prod']),
    ).rejects.toMatchObject({ status: 403 });
    expect(add).not.toHaveBeenCalled();
    await service.enqueueDocDrafts(ANA, PROJECT, mapOf(ANA), ['ent_emp']);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('the job keeps only suggestions for targets it asked about, replacing a pending one', async () => {
    const answer =
      '<doc>\nfield fld_emp_name\nThe employee’s name.\n</doc>\n<doc>\nfield fld_sal\nSalary.\n</doc>\n<doc>\nentity ent_prod\nProducts.\n</doc>';
    const { service, prisma } = harness({
      provider: providerStub(answer).provider,
      seed: {
        docDraft: [
          {
            id: 'old',
            projectId: PROJECT,
            targetType: 'field',
            targetId: 'fld_emp_name',
            status: 'pending',
            content: {},
            createdAt: new Date(0),
          },
        ],
      },
    });
    expect(
      await service.runDocDraftJob(
        { projectId: PROJECT, subject: ANA, entityIds: ['ent_emp'] },
        'job_1',
      ),
    ).toEqual({ drafted: 1 });
    expect(prisma.store.docDraft?.map((d) => [d.targetId, d.status, d.jobId])).toEqual([
      ['fld_emp_name', 'pending', 'job_1'],
    ]);
    const [draft] = await service.listDocDrafts(ANA, PROJECT, mapOf(ANA));
    expect(draft).toMatchObject({
      targetType: 'field',
      targetId: 'fld_emp_name',
      plainText: 'The employee’s name.',
    });
  });

  it('reject and accept need docs:edit at the target; accept writes through DocsService', async () => {
    const seed = () => ({
      docDraft: [
        {
          id: 'd1',
          projectId: PROJECT,
          targetType: 'field',
          targetId: 'fld_emp_name',
          status: 'pending',
          content: {},
          createdAt: new Date(0),
        },
      ],
    });
    await expect(harness({ seed: seed() }).service.rejectDocDraft(ANA, 'd1')).rejects.toMatchObject(
      { status: 403 },
    );
    const editor = harness({ view: { ...MARCH, docsEdit: true }, seed: seed() });
    expect(await editor.service.rejectDocDraft(ANA, 'd1')).toMatchObject({ id: 'd1' });
    expect(editor.prisma.store.docDraft?.[0]?.status).toBe('rejected');
    await expect(harness({ seed: seed() }).service.acceptDocDraft(ANA, 'd1')).rejects.toMatchObject(
      { status: 403 },
    );
    const accepter = harness({ view: { ...MARCH, docsEdit: true }, seed: seed() });
    expect(await accepter.service.acceptDocDraft(ANA, 'd1')).toMatchObject({ id: 'd1' });
    expect(accepter.write).toHaveBeenCalledWith(ANA, PROJECT, 'field', 'fld_emp_name', {
      content: {},
    });
    expect(accepter.prisma.store.docDraft?.[0]?.status).toBe('accepted');
  });
});

describe('AiService.draftSchema', () => {
  const DDL = '<ddl>\nCREATE TABLE shops (id int PRIMARY KEY);\n</ddl>';

  it('returns the DDL, with room for a whole application', async () => {
    const { provider, requests } = providerStub(DDL);
    const { service } = harness({ provider });
    const out = await service.draftSchema(ANA, PROJECT, mapOf(ANA), { description: 'a shop' });
    expect(out.source).toContain('CREATE TABLE shops');
    expect(requests[0]?.maxTokens).toBe(32_000);
  });

  it('sends the visible project, and the summary is what the importer reads (Phase 22)', async () => {
    const answer = [
      '<ddl>',
      'CREATE TABLE ent_emp (fld_emp_name text, badge text);',
      'CREATE TABLE reviews (id int PRIMARY KEY, emp text,',
      '  CONSTRAINT reviews_emp_fk FOREIGN KEY (emp) REFERENCES ent_emp (fld_emp_name));',
      '</ddl>',
    ].join('\n');
    const { provider, requests } = providerStub(answer);
    const { service } = harness({ view: APRIL, provider });
    const out = await service.draftSchema(ANA, PROJECT, mapOf(ANA), { description: 'reviews' });
    const prefix = requests[0]?.prefix ?? '';
    expect(prefix).toContain('<schema>');
    expect(prefix).toContain('T ent_emp');
    expect(prefix).not.toContain('ent_prod');
    expect(prefix).not.toContain('fld_sal');
    expect(out.summary).toEqual({
      creates: ['reviews'],
      existing: ['ent_emp'],
      addsColumns: [{ table: 'ent_emp', columns: ['badge'] }],
      relations: [{ from: 'reviews.emp', to: 'ent_emp.fld_emp_name' }],
      linksTo: ['ent_emp'],
    });
  });

  it('an existing table the draft only references is declared in front, so the key survives', async () => {
    const answer = [
      '<ddl>',
      'CREATE TABLE reviews (id int PRIMARY KEY, emp text,',
      '  CONSTRAINT reviews_emp_fk FOREIGN KEY (emp) REFERENCES ent_emp (fld_emp_name));',
      '</ddl>',
    ].join('\n');
    const { provider } = providerStub(answer);
    const { service } = harness({ view: APRIL, provider });
    const out = await service.draftSchema(ANA, PROJECT, mapOf(ANA), { description: 'reviews' });
    expect(out.source).toMatch(/CREATE TABLE[^;]*ent_emp/);
    expect(out.source).not.toContain('fld_sal');
    expect(out.source).not.toContain('ent_prod');
    expect(out.summary).toMatchObject({
      creates: ['reviews'],
      existing: ['ent_emp'],
      addsColumns: [],
      relations: [{ from: 'reviews.emp', to: 'ent_emp.fld_emp_name' }],
      linksTo: ['ent_emp'],
    });
    // Revising sends it all back; nothing is declared twice.
    const again = await service.draftSchema(ANA, PROJECT, mapOf(ANA), {
      description: 'reviews',
      revise: { draft: out.source, instruction: 'x' },
    });
    expect(again.source.match(/CREATE TABLE[^;(]*ent_emp/g)).toHaveLength(1);
  });

  it('a table without ai:use is left out, not refused; a hidden one reads as new', async () => {
    const { provider, requests } = providerStub(
      '<ddl>\nCREATE TABLE ent_prod (id int PRIMARY KEY);\n</ddl>',
    );
    const { service } = harness({ view: { ...MARCH, ai: ['project', 'ent_emp'] }, provider });
    await service.draftSchema(ANA, PROJECT, mapOf(ANA), { description: 'x' });
    expect(requests[0]?.prefix).toContain('T ent_emp');
    expect(requests[0]?.prefix).not.toContain('ent_prod');

    const april = harness({ view: APRIL, provider });
    const out = await april.service.draftSchema(ANA, PROJECT, mapOf(ANA), { description: 'x' });
    expect(out.summary?.creates).toEqual(['ent_prod']);
    expect(out.summary?.existing).toEqual([]);
  });

  it('an empty project sends no schema block', async () => {
    const { provider, requests } = providerStub(DDL);
    const { service } = harness({ provider, seed: { entity: [], field: [] } });
    await service.draftSchema(ANA, PROJECT, mapOf(ANA), { description: 'a shop' });
    expect(requests[0]?.prefix).not.toContain('<schema>');
  });

  it('focus: names the visible focus, drops hidden and unknown ids silently', async () => {
    const { provider, requests } = providerStub(DDL);
    const { service } = harness({ view: APRIL, provider });
    await service.draftSchema(ANA, PROJECT, mapOf(ANA), {
      description: 'reviews',
      focusEntityIds: ['ent_emp', 'ent_prod', 'ent_nope'],
    });
    const ask = requests[0]?.messages[0]?.content ?? '';
    expect(ask).toContain('Build on these tables: ent_emp');
    expect(ask).not.toContain('ent_prod');
    expect(ask).not.toContain('ent_nope');
  });

  it('revise: the draft goes back as the previous answer, with the instruction', async () => {
    const { provider, requests } = providerStub(DDL);
    const { service } = harness({ provider });
    const out = await service.draftSchema(ANA, PROJECT, mapOf(ANA), {
      description: 'a shop',
      revise: { draft: 'CREATE TABLE mine (id int);', instruction: 'add a name' },
    });
    expect(requests[0]?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(requests[0]?.messages[1]?.content).toContain('CREATE TABLE mine');
    expect(requests[0]?.messages[2]?.content).toContain('add a name');
    expect(out.source).toContain('CREATE TABLE shops');
  });

  it('the body limits: focus, draft and instruction (400 at the route)', () => {
    const ok = { description: 'x' };
    expect(draftSchemaSchema.safeParse(ok).success).toBe(true);
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${String(i)}`);
    expect(draftSchemaSchema.safeParse({ ...ok, focusEntityIds: ids(50) }).success).toBe(true);
    expect(draftSchemaSchema.safeParse({ ...ok, focusEntityIds: ids(51) }).success).toBe(false);
    const revise = (draft: string, instruction: string) =>
      draftSchemaSchema.safeParse({ ...ok, revise: { draft, instruction } }).success;
    expect(revise('a'.repeat(100_000), 'b'.repeat(2_000))).toBe(true);
    expect(revise('a'.repeat(100_001), 'b')).toBe(false);
    expect(revise('a', 'b'.repeat(2_001))).toBe(false);
  });

  it('refuses a cut-off answer instead of handing over half a schema', async () => {
    const { provider } = providerStub('<ddl>\nCREATE TABLE shops (id int', 'max_tokens');
    const { service } = harness({ provider });
    await expect(
      service.draftSchema(ANA, PROJECT, mapOf(ANA), { description: 'a shop' }),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'ai_truncated' },
    });
  });
});

describe('AiService agent reads (Phase 21 §5)', () => {
  const doc = {
    doc: [
      {
        id: 'doc_emp',
        projectId: PROJECT,
        targetType: 'entity',
        targetId: 'ent_emp',
        plainText: 'People on the payroll',
      },
    ],
  };
  const noKey = () =>
    new AiProvider({ get: () => undefined } as unknown as ConfigService<AppEnv, true>);

  it('works with no API key and never calls a provider; masked columns stay out', async () => {
    const { service } = harness({ provider: noKey(), seed: doc });
    const outline = await service.agentOutline(ANA, PROJECT, mapOf(ANA), {});
    expect(outline.lines).toEqual([
      'public.ent_emp  table  1 column  "People on the payroll"',
      'public.ent_prod  table  1 column',
    ]);
    const context = await service.agentContext(ANA, PROJECT, mapOf(ANA), { names: ['ent_emp'] });
    expect(context.text).toContain('T ent_emp');
    expect(context.text).toContain('fld_emp_name');
    expect(context.text).toContain('People on the payroll');
    expect(context.text).not.toContain('fld_sal');
    expect(context.notFound).toEqual([]);
  });

  it('a table without ai:use is left out; hidden reads exactly like missing', async () => {
    const noAi = harness({ view: { ...MARCH, ai: ['project', 'ent_emp'] } });
    expect((await noAi.service.agentOutline(ANA, PROJECT, mapOf(ANA), {})).lines).toEqual([
      'public.ent_emp  table  1 column',
    ]);
    const april = harness({ view: APRIL });
    const out = await april.service.agentContext(ANA, PROJECT, mapOf(ANA), {
      names: ['ent_prod', 'public.nope', 'ent_emp'],
    });
    expect(out.notFound).toEqual(['ent_prod', 'public.nope']);
    expect(out.text).not.toContain('ent_prod');
    expect(out.text).toContain('T ent_emp');
  });

  it('filters the outline by name pattern and kind', async () => {
    const { service } = harness();
    const by = async (filter: { kind?: string; namePattern?: string }) =>
      (await service.agentOutline(ANA, PROJECT, mapOf(ANA), filter)).lines.length;
    expect(await by({ namePattern: 'ent_e*' })).toBe(1);
    expect(await by({ namePattern: 'public.*' })).toBe(2);
    expect(await by({ kind: 'view' })).toBe(0);
  });

  it('docs follow the project setting, whatever the agent asks', async () => {
    const { service } = harness({ seed: doc, settings: { ai: { includeDocsInContext: false } } });
    const out = await service.agentContext(ANA, PROJECT, mapOf(ANA), {
      names: ['ent_emp'],
      includeDocs: true,
    });
    expect(out.text).not.toContain('People on the payroll');
    const lines = (await service.agentOutline(ANA, PROJECT, mapOf(ANA), {})).lines;
    expect(lines.join('\n')).not.toContain('payroll');
  });

  it('403 without ai:use at the project, and 403 ai_disabled with the switch off', async () => {
    const off = harness({ settings: { ai: { enabled: false } } });
    await expect(off.service.agentOutline(ANA, PROJECT, mapOf(ANA), {})).rejects.toMatchObject({
      status: 403,
      response: { code: 'ai_disabled' },
    });
    const none = harness({ view: { ...MARCH, ai: [] } });
    await expect(
      none.service.agentContext(ANA, PROJECT, mapOf(ANA), { names: ['ent_emp'] }),
    ).rejects.toMatchObject({ status: 403, response: { atom: 'ai:use' } });
  });
});

describe('AiService.agentPropose (roadmap 21b)', () => {
  const sql =
    'CREATE TABLE reviews (id int PRIMARY KEY, emp text,\n' +
    '  CONSTRAINT reviews_emp_fk FOREIGN KEY (emp) REFERENCES ent_emp (fld_emp_name));';

  it('checks ai:use and the switch, then hands over the SQL with referenced tables declared', async () => {
    const { service, propose } = harness({ view: APRIL });
    await service.agentPropose(ANA, PROJECT, mapOf(ANA), 'tok_1', { title: 'Reviews', sql });
    const [ctx, input] = propose.mock.calls[0] as unknown as [
      { projectId: string; actorUserId: string },
      { tokenId: string; title: string; sql: string },
    ];
    expect(ctx).toMatchObject({ projectId: PROJECT, actorUserId: 'usr_ana' });
    expect(input).toMatchObject({ tokenId: 'tok_1', title: 'Reviews' });
    expect(input.sql).toMatch(/CREATE TABLE[^;]*ent_emp/);
    expect(input.sql).toContain('CREATE TABLE reviews');
    expect(input.sql).not.toContain('fld_sal');

    const off = harness({ settings: { ai: { enabled: false } } });
    await expect(
      off.service.agentPropose(ANA, PROJECT, mapOf(ANA), 'tok_1', { title: 'x', sql }),
    ).rejects.toMatchObject({ status: 403, response: { code: 'ai_disabled' } });
    expect(off.propose).not.toHaveBeenCalled();
  });
});
