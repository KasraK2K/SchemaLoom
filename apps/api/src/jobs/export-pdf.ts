import type { Field, RedactedModel } from '@schemaloom/schema-model';
import PDFDocument from 'pdfkit';
import {
  REDACTION_NOTICE,
  docText,
  exportOutline,
  flags,
  namespaceTitle,
  renderType,
  visibleDocs,
  type ExportDoc,
  type RenderDocsOptions,
} from './export-markdown';

/**
 * Phase 5 §2 — the PDF export: the Markdown export's structure (`exportOutline`) plus the
 * FULL doc text and a field's structured facts. Pure: the processor reads the `docs` rows
 * and hands them in; `visibleDocs` drops every row the redacted model does not point at.
 *
 * ponytail: the 14 standard PDF fonts only (WinAnsi), so text outside Latin-1 renders as
 * wrong glyphs. Embed a Unicode TTF (`doc.registerFont`) when non-Latin docs matter.
 */
export function renderPdf(model: RedactedModel, options: RenderDocsOptions = {}): Promise<Buffer> {
  const docs = visibleDocs(model, options.docs ?? []);
  const pdf = new PDFDocument({ size: 'A4', margin: 56, info: { Title: 'Schema' } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    pdf.on('error', reject);
  });

  const heading = (text: string, size: number): void => {
    pdf.moveDown(0.6).font('Helvetica-Bold').fontSize(size).text(text).moveDown(0.3);
  };
  const body = (text: string, indent = 0): void => {
    if (text !== '') pdf.font('Helvetica').fontSize(10).text(text, { indent }).moveDown(0.2);
  };
  const muted = (text: string): void => {
    pdf.font('Helvetica-Oblique').fontSize(10).text(text).moveDown(0.2);
  };

  pdf.font('Helvetica-Bold').fontSize(22).text('Schema');
  body(`Engine: ${model.engineId} ${model.engineVersion}`);
  body(`Project: ${model.projectId}`);
  if (options.incomplete === true) muted(REDACTION_NOTICE);
  body(docs.get(model.projectId)?.plainText ?? '');

  for (const { namespace, entities } of exportOutline(model)) {
    heading(namespaceTitle(namespace), 16);
    if (entities.length === 0) muted('Nothing visible in this namespace.');
    for (const { entity, fields } of entities) {
      heading(`${entity.name} (${entity.kind})`, 13);
      body(docText(docs, entity));
      for (const fact of facts(docs.get(entity.id))) body(fact);
      if (entity.propsRedacted === true)
        muted('Some properties of this object are hidden from you.');
      if (fields.length === 0) muted('No columns.');
      for (const field of fields) fieldBlock(field);
    }
  }

  function fieldBlock(field: Field): void {
    if (field.restricted === true) {
      muted('(restricted)');
      return;
    }
    const note = flags(field);
    pdf
      .font('Helvetica-Bold')
      .fontSize(10)
      .text(field.name, { continued: true })
      .font('Helvetica')
      .text(`  ${renderType(field.type)}${note === '' ? '' : `  (${note})`}`);
    body(docText(docs, field), 14);
    for (const fact of facts(docs.get(field.id))) body(fact, 14);
    pdf.moveDown(0.2);
  }

  pdf.end();
  return done;
}

/**
 * Doc 02's `structuredDocSchema`, read defensively: the column is `Json` and an export must
 * not fail on one odd row. `ownerUserId` is left out — an id means nothing on paper.
 */
function facts(doc: ExportDoc | undefined): string[] {
  const s = doc?.structured;
  if (typeof s !== 'object' || s === null) return [];
  const out: string[] = [];
  const { businessMeaning, unit, allowedValues, examples } = s as Record<string, unknown>;
  if (typeof businessMeaning === 'string' && businessMeaning !== '') {
    out.push(`Business meaning: ${businessMeaning}`);
  }
  if (typeof unit === 'string' && unit !== '') out.push(`Unit: ${unit}`);
  if (Array.isArray(allowedValues) && allowedValues.length > 0) {
    const values = allowedValues
      .filter(
        (v): v is { value: string; meaning?: unknown } =>
          typeof v === 'object' &&
          v !== null &&
          typeof (v as { value?: unknown }).value === 'string',
      )
      .map((v) =>
        typeof v.meaning === 'string' && v.meaning !== '' ? `${v.value} = ${v.meaning}` : v.value,
      );
    out.push(`Allowed values: ${values.join('; ')}`);
  }
  if (Array.isArray(examples) && examples.length > 0) {
    out.push(`Examples: ${examples.map(String).join('; ')}`);
  }
  return out;
}
