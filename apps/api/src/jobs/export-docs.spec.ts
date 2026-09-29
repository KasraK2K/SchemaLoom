import type { EngineDefinition } from '@schemaloom/engine-sdk';
import { assembleModel, type RedactedModel, type SchemaModel } from '@schemaloom/schema-model';
import { inflateSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { fakePrisma, type Store } from '../schema/fake-prisma';
import { PROJECT, baseStore, entityRow, fieldRow, redactFully } from '../schema/fixture';
import { readProjectRows } from '../schema/row-read';
import { REDACTION_NOTICE, visibleDocs, type ExportDoc } from './export-markdown';
import { renderExport } from './export-render';

/**
 * The documentation exports print FULL doc text, which the IR does not carry — so the one
 * rule worth testing is that the text of anything redaction took away never comes back
 * through the side door of a `docs` row.
 */

const docRow = (id: string, targetType: ExportDoc['targetType'], targetId: string, text: string) => ({
  id,
  projectId: PROJECT,
  targetType,
  targetId,
  plainText: text,
  structured: null,
});

const DOCS = [
  docRow('doc_prj', 'project', PROJECT, 'Project overview prose.'),
  docRow('doc_orders', 'entity', 'ent_orders', 'Every order a customer placed, in full detail.'),
  docRow('doc_id', 'field', 'fld_id', 'Surrogate key for the order.'),
  docRow('doc_salary', 'field', 'fld_salary', 'SECRET salary band notes.'),
  docRow('doc_payroll', 'entity', 'ent_payroll', 'SECRET payroll table notes.'),
];

const STORE: Partial<Store> = baseStore({
  entity: [entityRow('ent_orders', { name: 'orders' }), entityRow('ent_payroll', { name: 'payroll' })],
  field: [
    fieldRow('fld_id', 'ent_orders', { name: 'id', dataType: 'uuid' }),
    fieldRow('fld_salary', 'ent_orders', { name: 'salary', dataType: 'numeric', position: 1, isRestricted: true }),
    fieldRow('fld_pay', 'ent_payroll', { name: 'amount', dataType: 'numeric' }),
  ],
  doc: DOCS,
});

const EXPORT_DOCS: ExportDoc[] = DOCS.map(({ projectId: _p, ...doc }) => doc);

let model: SchemaModel;

beforeAll(async () => {
  const rows = await readProjectRows(fakePrisma(STORE).client, PROJECT);
  model = assembleModel({ projectId: PROJECT, engineId: 'postgresql', engineVersion: '16', rows });
});

/** `payroll` hidden outright; `salary` masked (restricted, no `field:viewRestricted`). */
const redacted = (): RedactedModel =>
  redactFully(model, {
    visibleEntityIds: new Set(['ent_orders']),
    restrictedOkEntityIds: new Set(),
    entitiesWithRestrictedFields: new Set(['ent_orders']),
  });

const engine = { id: 'postgresql', capabilities: { exportFormats: [] } } as unknown as EngineDefinition;

/** Every text-showing operand of every content stream, concatenated. pdfkit writes each
 *  run as a hex string in WinAnsi, which is Latin-1 for everything this spec prints. */
function pdfText(pdf: Buffer): string {
  let out = '';
  for (const match of pdf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content: string;
    try {
      content = inflateSync(Buffer.from(match[1] ?? '', 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    for (const hex of content.matchAll(/<([0-9a-fA-F]+)>/g)) {
      out += Buffer.from(hex[1] ?? '', 'hex').toString('latin1');
    }
  }
  return out;
}

describe('visibleDocs', () => {
  it('keeps the project doc and docs the redacted model still points at, nothing else', () => {
    const kept = visibleDocs(redacted(), EXPORT_DOCS);
    expect([...kept.keys()].sort()).toEqual(['ent_orders', 'fld_id', PROJECT].sort());
  });

  it('drops a row whose id is not the one the model carries', () => {
    const forged = { ...EXPORT_DOCS[1]!, id: 'doc_other' };
    expect(visibleDocs(redacted(), [forged]).size).toBe(0);
  });
});

describe('pdf export', () => {
  it('renders a PDF with table names and full doc text, never a masked field’s doc', async () => {
    const rendered = await renderExport({ model: redacted(), format: 'pdf', engine, docs: EXPORT_DOCS });

    expect(rendered.contentType).toBe('application/pdf');
    expect(rendered.fileExtension).toBe('pdf');
    expect(Buffer.isBuffer(rendered.body)).toBe(true);
    const body = rendered.body as Buffer;
    expect(body.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const text = pdfText(body);
    expect(text).toContain('orders');
    expect(text).toContain('Every order a customer placed, in full detail.');
    expect(text).toContain('Surrogate key for the order.');
    expect(text).toContain('Project overview prose.');
    expect(text).toContain('(restricted)');
    expect(text).toContain(REDACTION_NOTICE);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('salary');
    expect(text).not.toContain('payroll');
  });
});

describe('markdown export with docs', () => {
  it('prints the full text where the IR has only an excerpt, and nothing redacted', async () => {
    const rendered = await renderExport({ model: redacted(), format: 'markdown', engine, docs: EXPORT_DOCS });
    const body = rendered.body as string;

    expect(body).toContain('Every order a customer placed, in full detail.');
    expect(body).toContain('| id | uuid | Surrogate key for the order. |');
    expect(body).toContain(`_${REDACTION_NOTICE}_`);
    expect(body).not.toContain('SECRET');
  });
});
