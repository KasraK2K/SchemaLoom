import type { EngineDefinition, ExportInput, ExportResult } from '@schemaloom/engine-sdk';
import { assembleModel, type RedactedModel, type SchemaModel } from '@schemaloom/schema-model';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fakePrisma, type Store } from '../schema/fake-prisma';
import {
  PROJECT,
  baseStore,
  entityRow,
  fieldRow,
  linkEndpointRow,
  linkRow,
  redactFully,
} from '../schema/fixture';
import { readProjectRows } from '../schema/row-read';
import {
  UnredactedExportError,
  UnsupportedExportFormatError,
  exportObjectKey,
  renderExport,
} from './export-render';

/**
 * No Redis, no S3, no engine package — `apps/api` may not import one (C10), so the engine
 * here is a stub whose `export` returns statements. What is being asserted is the CORE
 * half: which formats this file renders itself, that the engine's own formats route to
 * its exporter, and that a model which is not redacted gets nowhere.
 *
 * The model is built through the real `readProjectRows` + `assembleModel` + `redact` chain
 * rather than hand-written, so a spec here cannot drift from what the loader produces.
 */

/**
 * `orders` points at `payroll`. That edge matters: hide `payroll` and it survives as a
 * STUB (doc 05 §8.5) rather than vanishing, which is the case where a redacted model can
 * actually tell an exporter that something was taken out of it.
 */
const STORE: Partial<Store> = baseStore({
  entity: [
    entityRow('ent_orders', { name: 'orders' }),
    entityRow('ent_secret', { name: 'payroll' }),
  ],
  field: [
    fieldRow('fld_id', 'ent_orders', { name: 'id', dataType: 'uuid', isNullable: false }),
    fieldRow('fld_total', 'ent_orders', {
      name: 'total',
      dataType: 'numeric',
      typeArgs: [10, 2],
      position: 1,
      isPii: true,
    }),
    fieldRow('fld_pay', 'ent_secret', { name: 'salary', dataType: 'numeric' }),
  ],
  link: [linkRow('lnk_1', 'ent_orders', 'ent_secret')],
  linkEndpoint: [linkEndpointRow('lnk_1', 'fld_id', 'fld_pay')],
});

let model: SchemaModel;

beforeAll(async () => {
  const rows = await readProjectRows(fakePrisma(STORE).client, PROJECT);
  model = assembleModel({
    projectId: PROJECT,
    engineId: 'postgresql',
    engineVersion: '16',
    rows,
  });
});

/** Everything visible. */
const everything = (): RedactedModel => redactFully(model);

/** `payroll` hidden: the link keeps it alive as a stub, in the DEFAULT namespace (R-2). */
const partial = (): RedactedModel =>
  redactFully(model, {
    visibleEntityIds: new Set(['ent_orders']),
    restrictedOkEntityIds: new Set(['ent_orders']),
  });

const EXPORT_RESULT: ExportResult = {
  statements: [
    {
      ordinal: 0,
      phase: 'entities',
      kind: 'CREATE TABLE',
      text: 'CREATE TABLE orders ()',
      target: null,
    },
    {
      ordinal: 1,
      phase: 'indexes',
      kind: 'CREATE INDEX',
      text: 'CREATE INDEX i ON orders (id)',
      target: null,
    },
  ],
  separator: ';',
  incomplete: false,
  diagnostics: [],
};

function fakeEngine(result: ExportResult = EXPORT_RESULT): {
  engine: EngineDefinition;
  exported: ReturnType<typeof vi.fn<(input: ExportInput) => Promise<ExportResult>>>;
} {
  const exported = vi.fn((_input: ExportInput) => Promise.resolve(result));
  const engine = {
    id: 'postgresql',
    capabilities: {
      queryLanguage: { lineComment: '--' },
      exportFormats: [
        {
          id: 'ddl',
          displayName: 'SQL DDL',
          fileExtension: 'sql',
          supportsComments: true,
          supportsDrops: true,
        },
      ],
    },
    exporter: { export: exported },
  } as unknown as EngineDefinition;
  return { engine, exported };
}

describe('renderExport refuses anything that is not a RedactedModel', () => {
  it('throws on a model whose runtime `redacted` flag is false', async () => {
    const { engine } = fakeEngine();
    // The brand is PHANTOM: a cast satisfies the compiler, which is exactly the hole the
    // runtime check closes. A payload round-tripped through JSON arrives the same way.
    const laundered = { ...everything(), redacted: false } as unknown as RedactedModel;

    await expect(renderExport({ model: laundered, format: 'ir-json', engine })).rejects.toThrow(
      UnredactedExportError,
    );
  });

  it('checks before it looks at the format, so no branch can skip the net', async () => {
    const { engine, exported } = fakeEngine();
    const laundered = { ...everything(), redacted: false } as unknown as RedactedModel;

    await expect(renderExport({ model: laundered, format: 'ddl', engine })).rejects.toThrow(
      /redacted/,
    );
    expect(exported).not.toHaveBeenCalled();
  });
});

describe('ir-json', () => {
  it('serialises the redacted model and nothing else', async () => {
    const { engine } = fakeEngine();
    const rendered = await renderExport({ model: everything(), format: 'ir-json', engine });

    expect(rendered.contentType).toBe('application/json; charset=utf-8');
    expect(rendered.fileExtension).toBe('json');

    const parsed = JSON.parse(rendered.body as string) as SchemaModel;
    expect(parsed.projectId).toBe(PROJECT);
    expect(parsed.redacted).toBe(true);
    expect(Object.keys(parsed.objects.entity)).toEqual(['ent_orders', 'ent_secret']);
  });

  it('is incomplete when redaction touched something', async () => {
    const { engine } = fakeEngine();
    expect(
      (await renderExport({ model: everything(), format: 'ir-json', engine })).incomplete,
    ).toBe(false);
    expect((await renderExport({ model: partial(), format: 'ir-json', engine })).incomplete).toBe(
      true,
    );
  });
});

describe('markdown', () => {
  it('renders namespaces, entities and columns', async () => {
    const { engine } = fakeEngine();
    const rendered = await renderExport({ model: everything(), format: 'markdown', engine });

    expect(rendered.contentType).toBe('text/markdown; charset=utf-8');
    expect(rendered.fileExtension).toBe('md');
    expect(rendered.body).toContain('## public');
    expect(rendered.body).toContain('### orders (table)');
    expect(rendered.body).toContain('| id | uuid | required |');
    expect(rendered.body).toContain('| total | numeric(10, 2) | PII |');
  });

  it('skips a restricted entity — a stub is not documentation', async () => {
    const { engine } = fakeEngine();
    const rendered = await renderExport({ model: partial(), format: 'markdown', engine });

    expect(rendered.body).toContain('### orders (table)');
    expect(rendered.body).not.toContain('payroll');
    expect(rendered.incomplete).toBe(true);
  });

  it('is deterministic — same model, byte-identical output', async () => {
    const { engine } = fakeEngine();
    const once = await renderExport({ model: everything(), format: 'markdown', engine });
    const twice = await renderExport({ model: everything(), format: 'markdown', engine });
    expect(once.body).toBe(twice.body);
  });
});

describe('an engine format', () => {
  it('routes to the engine exporter and renders its statements', async () => {
    const { engine, exported } = fakeEngine();
    const redacted = everything();
    const rendered = await renderExport({ model: redacted, format: 'ddl', engine });

    expect(exported).toHaveBeenCalledTimes(1);
    const input = exported.mock.calls[0]?.[0];
    expect(input?.model).toBe(redacted);
    expect(input?.options.format).toBe('ddl');
    expect(input?.context).toEqual({ projectId: PROJECT, serverVersion: '16' });

    expect(rendered.fileExtension).toBe('sql');
    expect(rendered.body).toBe('CREATE TABLE orders ();\n\nCREATE INDEX i ON orders (id);');
  });

  it('is incomplete when EITHER the engine or redaction says so', async () => {
    const dropped = fakeEngine({ ...EXPORT_RESULT, incomplete: true });
    expect(
      (await renderExport({ model: everything(), format: 'ddl', engine: dropped.engine }))
        .incomplete,
    ).toBe(true);

    const clean = fakeEngine();
    expect(
      (await renderExport({ model: partial(), format: 'ddl', engine: clean.engine })).incomplete,
    ).toBe(true);
  });

  it('refuses a format the engine does not declare', async () => {
    const { engine } = fakeEngine();
    await expect(renderExport({ model: everything(), format: 'png', engine })).rejects.toThrow(
      UnsupportedExportFormatError,
    );
  });
});

describe('exportObjectKey', () => {
  it('is one key per export_jobs row, under a per-project prefix', () => {
    expect(exportObjectKey(PROJECT, 'exj_1', 'sql')).toBe(`exports/${PROJECT}/exj_1.sql`);
    expect(exportObjectKey(PROJECT, 'exj_1', 'png')).toBe(`exports/${PROJECT}/exj_1.png`);
  });
});
