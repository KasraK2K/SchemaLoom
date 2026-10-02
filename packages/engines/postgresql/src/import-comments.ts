import type { ImportedDoc } from '@schemaloom/engine-sdk';
import { field, qualifiedFromList, str, stringList, unwrap } from './import-ast.js';
import type { ImportModel } from './import-model.js';

const ENTITY_OBJECTS = new Set(['OBJECT_TABLE', 'OBJECT_VIEW', 'OBJECT_MATVIEW']);

/**
 * `COMMENT ON TABLE | VIEW | MATERIALIZED VIEW | COLUMN … IS '…'` → a doc on the entity or
 * field it names, or the reason it stays `ignored`.
 *
 * ponytail: the target must be defined in the same source. A migration that comments on a
 * table the project already has is still ignored; resolving it against the live project
 * belongs in core's merge if anyone needs it.
 */
export function commentDoc(statement: unknown, model: ImportModel): ImportedDoc | string {
  const node = unwrap(statement, 'CommentStmt');
  if (node === undefined) return 'Not a comment';
  const objtype = str(node, 'objtype') ?? '';
  const isColumn = objtype === 'OBJECT_COLUMN';
  if (!isColumn && !ENTITY_OBJECTS.has(objtype)) {
    return 'Only tables, views and columns carry docs in SchemaLoom';
  }
  const text = str(node, 'comment');
  if (text === undefined || text.trim() === '') return 'An empty comment adds no doc';

  const list = unwrap(field(node, 'object'), 'List');
  const parts = list === undefined ? [] : stringList(list, 'items');
  const table = qualifiedFromList(isColumn ? parts.slice(0, -1) : parts);
  const entity = table === undefined ? undefined : model.findEntity(table.schema, table.name);
  const column = isColumn ? parts[parts.length - 1] : undefined;
  const target =
    entity === undefined
      ? undefined
      : column === undefined
        ? { type: 'entity' as const, id: entity.id }
        : mapField(model.findField(entity, column)?.id);
  if (target === undefined) return 'The commented object is not defined in this source';
  return { target, text };
}

function mapField(id: string | undefined): ImportedDoc['target'] | undefined {
  return id === undefined ? undefined : { type: 'field', id };
}
