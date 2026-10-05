import { logicalKey, type RedactedModel, type SchemaModel } from '@schemaloom/schema-model';

/** Phase 22 §1.1 step 2 — what a drafted schema would do, read by the importer. */
export interface DraftSummary {
  /** Tables the draft adds. */
  readonly creates: readonly string[];
  /** Tables the draft names that the project already has; the import leaves them as they are. */
  readonly existing: readonly string[];
  /** New columns the import would add to existing tables. */
  readonly addsColumns: readonly { readonly table: string; readonly columns: readonly string[] }[];
  /** Every relation in the draft, `table.column` → `table.column`. */
  readonly relations: readonly { readonly from: string; readonly to: string }[];
  /** Existing tables the draft's relations point at. */
  readonly linksTo: readonly string[];
}

/**
 * The draft against the CALLER's redacted view, with the import's own match rule (logical
 * key, the importer's default namespace read as the project's — `mergeImport`). The real
 * preview runs at Import time; this one only answers "what would happen" in words.
 *
 * Not against live: a draft naming a table the caller can't see reads as "creates", the
 * same as a table that doesn't exist, so the summary is not an existence oracle. A
 * restricted stub's key is `missing(id)` and never matches either.
 */
export function draftSummary(view: RedactedModel, imported: SchemaModel): DraftSummary {
  const defaultNs = (m: SchemaModel) =>
    Object.values(m.objects.namespace).find((ns) => ns.isDefault);
  const [importedNs, viewNs] = [defaultNs(imported), defaultNs(view)];
  const keyed: SchemaModel =
    importedNs === undefined || viewNs === undefined
      ? imported
      : {
          ...imported,
          objects: {
            ...imported.objects,
            namespace: {
              ...imported.objects.namespace,
              [importedNs.id]: { ...importedNs, name: viewNs.name },
            },
          },
        };

  const keys = (model: SchemaModel, type: 'entity' | 'field'): Set<string> =>
    new Set(Object.keys(model.objects[type]).map((id) => logicalKey(model, type, id)));
  const [viewEntities, viewFields] = [keys(view, 'entity'), keys(view, 'field')];

  const entities = Object.values(imported.objects.entity);
  const matched = new Set(
    entities.filter((e) => viewEntities.has(logicalKey(keyed, 'entity', e.id))).map((e) => e.id),
  );
  const nameOf = (id: string): string => imported.objects.entity[id]?.name ?? id;

  const added = new Map<string, string[]>();
  for (const field of Object.values(imported.objects.field)) {
    if (!matched.has(field.entityId) || viewFields.has(logicalKey(keyed, 'field', field.id)))
      continue;
    added.set(field.entityId, [...(added.get(field.entityId) ?? []), field.name]);
  }

  const side = (end: { entityId: string; fieldIds: readonly string[] }): string => {
    const columns = end.fieldIds.map((id) => imported.objects.field[id]?.name ?? id);
    const table = nameOf(end.entityId);
    if (columns.length === 0) return table;
    return columns.length === 1
      ? `${table}.${columns.join('')}`
      : `${table}(${columns.join(', ')})`;
  };
  const links = Object.values(imported.objects.link);

  return {
    creates: entities.filter((e) => !matched.has(e.id)).map((e) => e.name),
    existing: entities.filter((e) => matched.has(e.id)).map((e) => e.name),
    addsColumns: [...added].map(([id, columns]) => ({ table: nameOf(id), columns })),
    relations: links.map((l) => ({ from: side(l.from), to: side(l.to) })),
    linksTo: [
      ...new Set(links.filter((l) => matched.has(l.to.entityId)).map((l) => nameOf(l.to.entityId))),
    ],
  };
}
