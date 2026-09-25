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
 * It renders what the IR carries: the structure plus each object's doc EXCERPT. The full
 * TipTap prose lives in `docs` rows and is fetched by id (doc 04 §2.3), so the complete
 * documentation export lands with docs mode; this is the structural half, and it is the
 * half a redacted model can honestly produce.
 *
 * DETERMINISTIC, like the DDL exporter (doc 03 §10.1): every list is sorted by an explicit
 * key and never by `Object.keys` order or `localeCompare`, whose result depends on the
 * server's ICU data. The same model renders byte-identically on every machine, so two
 * exports diff as a schema diff.
 */

/** `(name, id)` ascending — ids break the tie so two same-named objects never swap. */
const byNameThenId = (a: { name: string; id: string }, b: { name: string; id: string }): number =>
  a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1;

function renderType(type: TypeRef): string {
  const args = type.args ?? [];
  const base = args.length > 0 ? `${type.name}(${args.map(String).join(', ')})` : type.name;
  return base + '[]'.repeat(type.dimensions ?? 0);
}

/** Pipes and newlines are the only characters that can break a GFM table cell. */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function flags(field: Field): string {
  const set: string[] = [];
  if (!field.isNullable) set.push('required');
  if (field.isPii) set.push('PII');
  if (field.isDeprecated) set.push('deprecated');
  if (field.propsRedacted === true) set.push('some properties hidden');
  return set.join(', ');
}

function fieldRow(field: Field): string {
  // A masked field (doc 04 §10.2) has had its name and type blanked. Saying so beats
  // emitting an empty row that reads like a bug in the exporter.
  const name = field.restricted === true ? '_(restricted)_' : cell(field.name);
  const type = field.restricted === true ? '' : cell(renderType(field.type));
  const note = field.restricted === true ? '' : cell([flags(field), field.doc?.excerpt ?? ''].filter((s) => s !== '').join(' — '));
  return `| ${name} | ${type} | ${note} |`;
}

function entitySection(entity: Entity, fields: readonly Field[]): string[] {
  const lines = [`### ${entity.name} (${entity.kind})`, ''];
  if (entity.doc !== null) lines.push(entity.doc.excerpt, '');
  if (entity.propsRedacted === true) {
    lines.push('_Some properties of this object are hidden from you._', '');
  }
  if (fields.length === 0) {
    lines.push('_No columns._', '');
    return lines;
  }
  lines.push('| Column | Type | Notes |', '| --- | --- | --- |');
  for (const field of fields) lines.push(fieldRow(field));
  lines.push('');
  return lines;
}

export function renderMarkdown(model: RedactedModel): string {
  const ix = indexOf(model);
  const namespaces: Namespace[] = Object.values(model.objects.namespace).sort(byNameThenId);

  const lines = [
    '# Schema',
    '',
    `- Engine: ${model.engineId} ${model.engineVersion}`,
    `- Project: ${model.projectId}`,
    '',
  ];

  for (const namespace of namespaces) {
    lines.push(`## ${namespace.name === '' ? '(default)' : namespace.name}`, '');
    // R-1's exporter rule: a restricted ENTITY is a stub and is skipped outright. A
    // restricted field is masked, not dropped, so it still gets a row.
    const entities = entitiesOf(ix, namespace.id)
      .filter((entity) => entity.restricted !== true)
      .sort(byNameThenId);
    if (entities.length === 0) {
      lines.push('_Nothing visible in this namespace._', '');
      continue;
    }
    for (const entity of entities) {
      // Flat, every depth, in the order the canvas shows them. `(ordinal, id)` rather
      // than `ordinal` alone so a model with a duplicate ordinal — which `validateModel`
      // reports but does not prevent from being exported — still renders identically twice.
      const fields = fieldsOf(ix, entity.id).sort(
        (a, b) => a.ordinal - b.ordinal || (a.id < b.id ? -1 : 1),
      );
      lines.push(...entitySection(entity, fields));
    }
  }

  return lines.join('\n');
}
