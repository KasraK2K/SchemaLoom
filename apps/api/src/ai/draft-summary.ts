import {
  createIndex,
  isPrimaryKey,
  logicalKey,
  type Field,
  type RedactedModel,
  type SchemaModel,
} from '@schemaloom/schema-model';

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
  const { existing: matched, isNew } = matchDraft(view, imported);
  const entities = Object.values(imported.objects.entity);
  const nameOf = (id: string): string => imported.objects.entity[id]?.name ?? id;

  const added = new Map<string, string[]>();
  for (const field of Object.values(imported.objects.field)) {
    if (!matched.has(field.entityId) || !isNew(field)) continue;
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

/** Phase 22b §2 — what the canvas draws as ghosts. `key` is the draft's own table id. */
export interface DraftPreview {
  readonly tables: readonly {
    readonly key: string;
    readonly name: string;
    readonly columns: readonly {
      readonly name: string;
      readonly type: string;
      readonly pk: boolean;
    }[];
  }[];
  readonly addedColumns: readonly {
    readonly entityId: string;
    readonly columns: readonly { readonly name: string; readonly type: string }[];
  }[];
  /** a draft `key`, or the id of an existing table the caller can see */
  readonly links: readonly { readonly from: string; readonly to: string }[];
  /** the one area the AI put its tables in (Q2), or null */
  readonly area: string | null;
}

/**
 * Same match as `draftSummary`, against the same redacted view: an existing table is named
 * by an id the caller already has, and one they can't see reads as a new table. Links
 * between two existing tables are already on the canvas and left out.
 */
export function draftPreview(
  view: RedactedModel,
  imported: SchemaModel,
  typeName: (field: Field) => string,
  area: string | null,
): DraftPreview {
  const { existing, isNew } = matchDraft(view, imported);
  const ix = createIndex(imported);
  const end = (entityId: string): string => existing.get(entityId) ?? entityId;
  const added = new Map<string, { name: string; type: string }[]>();
  for (const field of Object.values(imported.objects.field)) {
    const viewId = existing.get(field.entityId);
    if (viewId === undefined || !isNew(field)) continue;
    added.set(viewId, [...(added.get(viewId) ?? []), { name: field.name, type: typeName(field) }]);
  }
  const links = new Map<string, { from: string; to: string }>();
  for (const l of Object.values(imported.objects.link)) {
    const [from, to] = [l.from.entityId, l.to.entityId];
    if (imported.objects.entity[from] === undefined || imported.objects.entity[to] === undefined)
      continue;
    if (existing.has(from) && existing.has(to)) continue;
    links.set(`${end(from)}>${end(to)}`, { from: end(from), to: end(to) });
  }
  return {
    tables: Object.values(imported.objects.entity)
      .filter((e) => !existing.has(e.id))
      .map((e) => ({
        key: e.id,
        name: e.name,
        columns: (ix.fieldsByEntity.get(e.id) ?? []).map((f) => ({
          name: f.name,
          type: typeName(f),
          pk: isPrimaryKey(ix, f.id),
        })),
      })),
    addedColumns: [...added].map(([entityId, columns]) => ({ entityId, columns })),
    links: [...links.values()],
    area,
  };
}

/**
 * The import's own match rule (logical key, the importer's default namespace read as the
 * project's — `mergeImport`): the draft's tables that already exist, as draft id → view id,
 * and whether a draft column is new. A restricted stub's key is `missing(id)` and never
 * matches.
 */
function matchDraft(view: RedactedModel, imported: SchemaModel) {
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
  const viewEntities = new Map(
    Object.keys(view.objects.entity).map((id) => [logicalKey(view, 'entity', id), id]),
  );
  const viewFields = new Set(
    Object.keys(view.objects.field).map((id) => logicalKey(view, 'field', id)),
  );
  const existing = new Map<string, string>();
  for (const e of Object.values(imported.objects.entity)) {
    const id = viewEntities.get(logicalKey(keyed, 'entity', e.id));
    if (id !== undefined) existing.set(e.id, id);
  }
  return {
    existing,
    isNew: (field: Field): boolean => !viewFields.has(logicalKey(keyed, 'field', field.id)),
  };
}
