import {
  entitiesOf,
  fieldsOf,
  indexOf,
  type Entity,
  type Field,
  type Namespace,
  type RedactedModel,
  type TypeRef,
} from '@schemaloom/schema-model';

/**
 * Doc 01 §4.3 — "Documentation as Markdown" is rendered SERVER-side.
 *
 * It renders the structure plus each object's doc. The IR carries only an EXCERPT; the full
 * text lives in `docs` rows (doc 04 §2.3), which the processor reads and passes in as
 * `docs`. `visibleDocs` keeps a row only where the REDACTED model still points at it, so a
 * masked field's doc, a stub's doc and a hidden table's doc cannot reach the output.
 *
 * DETERMINISTIC, like the DDL exporter (doc 03 §10.1): every list is sorted by an explicit
 * key and never by `Object.keys` order or `localeCompare`, whose result depends on the
 * server's ICU data. The same model renders byte-identically on every machine, so two
 * exports diff as a schema diff.
 */

/** One `docs` row as the export reads it. `structured` is doc 02's union, read loosely. */
export interface ExportDoc {
  readonly id: string;
  readonly targetType: 'project' | 'area' | 'entity' | 'field';
  readonly targetId: string;
  readonly plainText: string | null;
  readonly structured: unknown;
}

/** L11's one un-quantified line. No counts, no names. */
export const REDACTION_NOTICE = 'Some objects are not included because of your access level.';

/**
 * The docs a redacted model may show, by target id. Redaction blanks `doc` on every stub
 * and masked field, so `object.doc.id === row.id` IS the visibility test and there is no
 * second rule to drift. The project doc has no `DocRef`; anyone who can open the project
 * reads it (docs mode). Area docs are not part of this layout.
 */
export function visibleDocs(
  model: RedactedModel,
  rows: readonly ExportDoc[],
): Map<string, ExportDoc> {
  const out = new Map<string, ExportDoc>();
  for (const row of rows) {
    const ok =
      row.targetType === 'project'
        ? row.targetId === model.projectId
        : row.targetType === 'entity'
          ? isShown(model.objects.entity[row.targetId], row.id)
          : row.targetType === 'field' && isShown(model.objects.field[row.targetId], row.id);
    if (ok) out.set(row.targetId, row);
  }
  return out;
}

const isShown = (object: Entity | Field | undefined, docId: string): boolean =>
  object !== undefined && object.restricted !== true && object.doc?.id === docId;

/** The full text when the export was handed the row, else the IR's excerpt. */
export const docText = (docs: ReadonlyMap<string, ExportDoc>, object: Entity | Field): string =>
  docs.get(object.id)?.plainText ?? object.doc?.excerpt ?? '';

/** `(name, id)` ascending — ids break the tie so two same-named objects never swap. */
export const byNameThenId = (
  a: { name: string; id: string },
  b: { name: string; id: string },
): number => (a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1);

export function renderType(type: TypeRef): string {
  const args = type.args ?? [];
  const base = args.length > 0 ? `${type.name}(${args.map(String).join(', ')})` : type.name;
  return base + '[]'.repeat(type.dimensions ?? 0);
}

/** Pipes and newlines are the only characters that can break a GFM table cell. */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function flags(field: Field): string {
  const set: string[] = [];
  if (!field.isNullable) set.push('required');
  if (field.isPii) set.push('PII');
  if (field.isDeprecated) set.push('deprecated');
  if (field.propsRedacted === true) set.push('some properties hidden');
  return set.join(', ');
}

function fieldRow(field: Field, docs: ReadonlyMap<string, ExportDoc>): string {
  // A masked field (doc 04 §10.2) has had its name and type blanked. Saying so beats
  // emitting an empty row that reads like a bug in the exporter.
  const name = field.restricted === true ? '_(restricted)_' : cell(field.name);
  const type = field.restricted === true ? '' : cell(renderType(field.type));
  const note =
    field.restricted === true
      ? ''
      : cell([flags(field), docText(docs, field)].filter((s) => s !== '').join(' — '));
  return `| ${name} | ${type} | ${note} |`;
}

function entitySection(
  entity: Entity,
  fields: readonly Field[],
  docs: ReadonlyMap<string, ExportDoc>,
): string[] {
  const lines = [`### ${entity.name} (${entity.kind})`, ''];
  const doc = docText(docs, entity);
  if (doc !== '') lines.push(doc, '');
  if (entity.propsRedacted === true) {
    lines.push('_Some properties of this object are hidden from you._', '');
  }
  if (fields.length === 0) {
    lines.push('_No columns._', '');
    return lines;
  }
  lines.push('| Column | Type | Notes |', '| --- | --- | --- |');
  for (const field of fields) lines.push(fieldRow(field, docs));
  lines.push('');
  return lines;
}

export interface OutlineSection {
  readonly namespace: Namespace;
  readonly entities: readonly { readonly entity: Entity; readonly fields: readonly Field[] }[];
}

/** The walk both documentation exports (Markdown, PDF) share, so their structure cannot drift. */
export function exportOutline(model: RedactedModel): OutlineSection[] {
  const ix = indexOf(model);
  const namespaces: Namespace[] = Object.values(model.objects.namespace).sort(byNameThenId);
  return namespaces.map((namespace) => ({
    namespace,
    // R-1's exporter rule: a restricted ENTITY is a stub and is skipped outright. A
    // restricted field is masked, not dropped, so it still gets a row.
    entities: entitiesOf(ix, namespace.id)
      .filter((entity) => entity.restricted !== true)
      .sort(byNameThenId)
      .map((entity) => ({
        entity,
        // Flat, every depth, in the order the canvas shows them. `(ordinal, id)` rather
        // than `ordinal` alone so a model with a duplicate ordinal — which `validateModel`
        // reports but does not prevent from being exported — still renders identically twice.
        fields: fieldsOf(ix, entity.id).sort(
          (a, b) => a.ordinal - b.ordinal || (a.id < b.id ? -1 : 1),
        ),
      })),
  }));
}

export const namespaceTitle = (namespace: Namespace): string =>
  namespace.name === '' ? '(default)' : namespace.name;

export interface RenderDocsOptions {
  /** This project's `docs` rows; `visibleDocs` decides which of them may appear. */
  readonly docs?: readonly ExportDoc[];
  /** Redaction removed something: print `REDACTION_NOTICE` once (L11). */
  readonly incomplete?: boolean;
}

export function renderMarkdown(model: RedactedModel, options: RenderDocsOptions = {}): string {
  const docs = visibleDocs(model, options.docs ?? []);
  const lines = [
    '# Schema',
    '',
    `- Engine: ${model.engineId} ${model.engineVersion}`,
    `- Project: ${model.projectId}`,
    '',
  ];
  if (options.incomplete === true) lines.push(`_${REDACTION_NOTICE}_`, '');
  const projectDoc = docs.get(model.projectId)?.plainText ?? '';
  if (projectDoc !== '') lines.push(projectDoc, '');

  for (const { namespace, entities } of exportOutline(model)) {
    lines.push(`## ${namespaceTitle(namespace)}`, '');
    if (entities.length === 0) {
      lines.push('_Nothing visible in this namespace._', '');
      continue;
    }
    for (const { entity, fields } of entities) lines.push(...entitySection(entity, fields, docs));
  }

  return lines.join('\n');
}
