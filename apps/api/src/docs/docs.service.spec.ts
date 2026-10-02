import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { RedactedModel } from '@schemaloom/schema-model';
import { describe, expect, it, vi } from 'vitest';
import type {
  PermissionResolver,
  ProjectPermissionMap,
  Subject,
  VisibilityFilter,
} from '../access';
import { fakePrisma, type FakePrisma } from '../schema/fake-prisma';
import type { SchemaCommits, SchemaLoader } from '../schema';
import { docPlainText, sanitizeRichText } from './docs-rules';
import { DocsService } from './docs.service';

/**
 * `ent_open` everyone sees; `ent_secret` is a STUB for everyone but Ana. `fld_sal` is a
 * restricted column of `ent_open`: Ana (with `field:viewRestricted`) sees it, the others
 * get the masked slot. Bob only views; Eve views and holds `docs:edit`.
 */
const P = 'prj_1';
const VIEW = ['schema:view'];
const EDIT = ['schema:view', 'docs:edit'];

const ATOMS: Record<string, Record<string, string[]>> = {
  ana: { [P]: EDIT, ent_open: EDIT, ent_secret: EDIT, ar_1: EDIT },
  bob: { [P]: VIEW, ent_open: VIEW, ar_1: VIEW },
  eve: { [P]: VIEW, ent_open: EDIT, ar_1: VIEW },
  link: { [P]: VIEW, ent_open: VIEW, ar_1: VIEW },
};

const keyOf = (s: Subject): string => (s.kind === 'user' ? s.userId : 'link');
const user = (id: string): Subject => ({ kind: 'user', userId: id, orgId: 'org_1' });
const link: Subject = { kind: 'share_link', shareLinkId: 'sl_1', projectId: P };

function modelFor(who: string): RedactedModel {
  const full = who === 'ana';
  return {
    objects: {
      area: { ar_1: { id: 'ar_1' } },
      entity: {
        ent_open: { id: 'ent_open' },
        ent_secret: full ? { id: 'ent_secret' } : { id: 'ent_secret', restricted: true },
      },
      field: {
        fld_name: { id: 'fld_name', entityId: 'ent_open' },
        fld_sal: full
          ? { id: 'fld_sal', entityId: 'ent_open' }
          : { id: 'fld_sal', entityId: 'ent_open', restricted: true },
      },
    },
  } as unknown as RedactedModel;
}

const para = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const docRow = (targetType: string, targetId: string, text: string, version = 3) => ({
  id: `doc_${targetId}`,
  projectId: P,
  targetType,
  targetId,
  content: para(text),
  structured: null,
  plainText: text,
  version,
  updatedAt: new Date('2026-09-01T00:00:00Z'),
});

function setup(seed: Record<string, unknown>[] = []) {
  const db: FakePrisma = fakePrisma({
    doc: seed,
    project: [{ id: P, schemaRevision: 41n }],
  });
  const resolver = {
    resolveProject: (s: Subject) =>
      Promise.resolve({ subjectKey: keyOf(s) } as unknown as ProjectPermissionMap),
    canOpenProject: (m: ProjectPermissionMap) => ATOMS[m.subjectKey] !== undefined,
    skeleton: vi.fn().mockResolvedValue({}),
    atomsAt: (m: ProjectPermissionMap, _s: unknown, ref: { id: string }) =>
      new Set(ATOMS[m.subjectKey]?.[ref.id] ?? []),
  } as unknown as PermissionResolver;
  const filter = {
    redactWith: (_raw: unknown, s: Subject) => modelFor(keyOf(s)),
  } as unknown as VisibilityFilter;
  const loader = { load: vi.fn().mockResolvedValue({}) } as unknown as SchemaLoader;
  const next = vi.fn();
  const commits = { results: { next } } as unknown as SchemaCommits;
  return { db, next, service: new DocsService(db.client, loader, filter, resolver, commits) };
}

describe('DocsService.list (docs mode)', () => {
  const seed = [
    docRow('project', P, 'About'),
    docRow('entity', 'ent_open', 'Orders'),
    docRow('entity', 'ent_secret', 'Payroll'),
    docRow('field', 'fld_name', 'Name'),
    docRow('field', 'fld_sal', 'Monthly salary'),
    docRow('field', 'fld_gone', 'Deleted since'),
  ];

  it('drops stubs, masked fields and orphans for a reader without field:viewRestricted', async () => {
    const { docs } = await setup(seed).service.list(user('bob'), P);
    expect(docs.map((d) => d.targetId).sort()).toEqual(['ent_open', 'fld_name', P].sort());
    expect(JSON.stringify(docs)).not.toContain('salary');
    expect(docs.every((d) => !d.canEdit)).toBe(true);
  });

  it('lists everything visible for a full reader', async () => {
    const { docs } = await setup(seed).service.list(user('ana'), P);
    expect(docs.map((d) => d.targetId)).toContain('fld_sal');
    expect(docs.map((d) => d.targetId)).toContain('ent_secret');
  });

  it('serves a share-link subject read-only', async () => {
    const { docs } = await setup(seed).service.list(link, P);
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every((d) => !d.canEdit)).toBe(true);
  });
});

describe('DocsService.get', () => {
  it('404s a masked field, a stub and an unknown type', async () => {
    const { service } = setup([docRow('field', 'fld_sal', 'Monthly salary')]);
    await expect(service.get(user('bob'), P, 'field', 'fld_sal')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.get(user('bob'), P, 'entity', 'ent_secret')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.get(user('bob'), P, 'link', 'lnk_1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.get(user('bob'), P, 'project', 'prj_other')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('answers an undocumented visible target with an empty doc at version 0', async () => {
    const doc = await setup().service.get(user('eve'), P, 'entity', 'ent_open');
    expect(doc).toMatchObject({
      version: 0,
      plainText: '',
      structured: null,
      updatedAt: null,
      canEdit: true,
    });
  });

  it('measures docs:edit for a field at its entity', async () => {
    const doc = await setup().service.get(user('eve'), P, 'field', 'fld_name');
    expect(doc.canEdit).toBe(true);
  });
});

describe('DocsService.write', () => {
  it('404s an invisible target before it checks docs:edit', async () => {
    const { service } = setup();
    await expect(
      service.write(user('eve'), P, 'field', 'fld_sal', { content: para('x') }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.write(link, P, 'entity', 'ent_open', { content: para('x') }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('403s a visible target without docs:edit', async () => {
    const { service } = setup();
    await expect(
      service.write(user('bob'), P, 'entity', 'ent_open', { content: para('x') }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.write(user('eve'), P, 'project', P, { content: para('x') }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('creates at version 1, derives plainText and emits a doc frame without bumping seq', async () => {
    const { service, db, next } = setup();
    const doc = await service.write(user('eve'), P, 'field', 'fld_name', {
      content: para('Customer name'),
      structured: { targetType: 'field', businessMeaning: 'Who ordered', unit: null },
      version: 0,
    });
    expect(doc).toMatchObject({ version: 1, plainText: 'Customer name', canEdit: true });
    expect(doc.structured).toMatchObject({
      businessMeaning: 'Who ordered',
      allowedValues: [],
      examples: [],
    });
    expect(db.store.doc?.[0]).toMatchObject({ plainText: 'Customer name', updatedById: 'eve' });
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: P,
        actorUserId: 'eve',
        seq: 41,
        changed: {},
        removed: [],
      }),
    );
  });

  it('bumps the version on update and keeps the stored facts when structured is absent', async () => {
    const row = {
      ...docRow('entity', 'ent_open', 'Old'),
      structured: { targetType: 'entity', businessMeaning: 'Kept', ownerUserId: null },
    };
    const { service } = setup([row]);
    const doc = await service.write(user('eve'), P, 'entity', 'ent_open', {
      content: para('New'),
      version: 3,
    });
    expect(doc.version).toBe(4);
    expect(doc.structured).toMatchObject({ businessMeaning: 'Kept' });
  });

  it('409s a stale version with the current doc', async () => {
    const { service, next } = setup([docRow('entity', 'ent_open', 'Theirs', 5)]);
    const caught = await service
      .write(user('eve'), P, 'entity', 'ent_open', { content: para('Mine'), version: 4 })
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ConflictException);
    expect((caught as ConflictException).getResponse()).toMatchObject({
      code: 'stale_version',
      current: { version: 5, plainText: 'Theirs' },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('400s facts on the wrong target type and a body that is not a doc', async () => {
    const { service } = setup();
    await expect(
      service.write(user('eve'), P, 'entity', 'ent_open', {
        content: para('x'),
        structured: { targetType: 'field' },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.write(user('eve'), P, 'entity', 'ent_open', { content: { type: 'paragraph' } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('DocsService.importDocs (SQL import comments)', () => {
  const docs = [
    { targetType: 'entity' as const, targetId: 'ent_open', text: 'Orders\n\nOne row each' },
    { targetType: 'field' as const, targetId: 'fld_name', text: 'Customer name' },
    { targetType: 'field' as const, targetId: 'fld_sal', text: 'Salary' },
    { targetType: 'entity' as const, targetId: 'ent_secret', text: 'Payroll' },
  ];

  it('writes only visible, editable, undocumented targets, as paragraphs', async () => {
    const { db, next, service } = setup([docRow('field', 'fld_name', 'Written by hand')]);
    // Eve edits `ent_open` (and so its fields); `fld_sal` is masked and `ent_secret` a stub.
    expect(await service.importDocs(user('eve'), P, docs)).toBe(1);

    const created = db.store.doc?.find((r) => r.targetId === 'ent_open');
    expect(created).toMatchObject({
      targetType: 'entity',
      plainText: docPlainText(created?.content),
      version: 1,
    });
    expect(created?.content).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Orders' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'One row each' }] },
      ],
    });
    // The hand-written doc is untouched.
    expect(db.store.doc?.find((r) => r.targetId === 'fld_name')?.plainText).toBe('Written by hand');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('writes nothing for a viewer or a share link, and broadcasts nothing', async () => {
    const { next, service } = setup();
    expect(await service.importDocs(user('bob'), P, docs)).toBe(0);
    expect(await service.importDocs(link, P, docs)).toBe(0);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('sanitizeRichText', () => {
  it('strips unknown nodes, marks and attributes, and unsafe links', () => {
    const dirty = {
      type: 'doc',
      attrs: { onload: 'x' },
      content: [
        {
          type: 'heading',
          attrs: { level: 9, class: 'x' },
          content: [{ type: 'text', text: 'Title' }],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'safe',
              marks: [{ type: 'bold' }, { type: 'textStyle', attrs: { color: 'red' } }],
            },
            { type: 'mention', attrs: { id: 'usr_1', label: 'Ana' } },
            {
              type: 'text',
              text: 'bad',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            },
            {
              type: 'text',
              text: 'good',
              marks: [{ type: 'link', attrs: { href: 'https://x.test', target: '_top' } }],
            },
          ],
        },
        { type: 'image', attrs: { src: 'https://x.test/a.png' } },
        {
          type: 'codeBlock',
          attrs: { language: '"><script>' },
          content: [{ type: 'text', text: 'select 1' }],
        },
      ],
    };
    expect(sanitizeRichText(dirty)).toEqual({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'safe', marks: [{ type: 'bold' }] },
            { type: 'text', text: 'bad' },
            {
              type: 'text',
              text: 'good',
              marks: [{ type: 'link', attrs: { href: 'https://x.test' } }],
            },
          ],
        },
        {
          type: 'codeBlock',
          attrs: { language: null },
          content: [{ type: 'text', text: 'select 1' }],
        },
      ],
    });
  });

  it('refuses a non-doc root and bounds nesting depth', () => {
    expect(sanitizeRichText({ type: 'paragraph' })).toBeNull();
    let deep: Record<string, unknown> = { type: 'text', text: 'bottom' };
    for (let i = 0; i < 100; i++) deep = { type: 'blockquote', content: [deep] };
    expect(JSON.stringify(sanitizeRichText({ type: 'doc', content: [deep] }))).not.toContain(
      'bottom',
    );
  });
});

describe('docPlainText (the excerpt source)', () => {
  it('puts each block on its own line with no blank runs', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', content: [{ type: 'text', text: 'Orders' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'One row per ' },
            { type: 'text', text: 'order.' },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }],
            },
          ],
        },
      ],
    };
    expect(docPlainText(doc)).toBe('Orders\nOne row per order.\na\nb');
    expect(docPlainText({ type: 'doc', content: [] })).toBe('');
  });
});
