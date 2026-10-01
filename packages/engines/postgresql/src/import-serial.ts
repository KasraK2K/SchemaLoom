import type { IrObjectRef } from '@schemaloom/engine-sdk';
import {
  asNode,
  children,
  defElements,
  rangeVar,
  str,
  stringList,
  unwrap,
  type AstNode,
} from './import-ast.js';
import type { ImportModel } from './import-model.js';
import { normalizeName } from './normalize-name.js';

/**
 * Pass 3 — pg_dump never writes `serial`. A `serial` column comes out as three statements:
 *
 *   CREATE SEQUENCE public.t_id_seq AS integer START WITH 1 INCREMENT BY 1 … CACHE 1;
 *   ALTER SEQUENCE public.t_id_seq OWNED BY public.t.id;
 *   ALTER TABLE ONLY public.t ALTER COLUMN id SET DEFAULT nextval('public.t_id_seq'::regclass);
 *
 * When all three name the same integer column and the sequence has the options `serial`
 * gives it, that IS a serial column: the field's type becomes `serial` / `bigserial` /
 * `smallserial` (the catalog has them) and its `nextval` default goes. The three statements
 * are then applied, not "unsupported". Anything else (START WITH 1000, a shared sequence, a
 * sequence nobody owns) is left alone, so the report still says exactly what was dropped.
 */

/** The column type each serial is shorthand for, keyed by the sequence's `AS` type. */
const SERIAL_FOR: Readonly<Record<string, { column: string; serial: string }>> = {
  int2: { column: 'smallint', serial: 'smallserial' },
  int4: { column: 'integer', serial: 'serial' },
  int8: { column: 'bigint', serial: 'bigserial' },
};

interface ColumnName {
  readonly schema: string | undefined;
  readonly table: string;
  readonly column: string;
}

/** The statement indexes each sequence's three parts came from. */
interface Parts {
  sequence?: { index: number; asType: string };
  owner?: { index: number; column: ColumnName };
  defaulted?: { index: number; column: ColumnName };
}

/** `public.t_id_seq`, `public."Orders_id_seq"` or `t_id_seq`, as written inside nextval(). */
function splitQualified(text: string): { schema: string | undefined; name: string } {
  const parts = text.match(/"(?:[^"]|"")*"|[^.]+/g)?.map((p) => p.replace(/^"|"$/g, '')) ?? [];
  const name = parts[parts.length - 1] ?? '';
  return { schema: parts.length > 1 ? parts[parts.length - 2] : undefined, name };
}

/** CREATE SEQUENCE with only the options `serial` itself would give it; else undefined. */
function serialSequence(node: AstNode): string | undefined {
  const options = defElements(node, 'options');
  for (const [name, value] of options) {
    const expected: Record<string, number> = { start: 1, increment: 1, cache: 1 };
    if (!(name in expected) || expected[name] !== value) return undefined;
  }
  let asType = 'int8'; // pg_dump omits AS for bigint, the sequence default
  for (const item of children(node, 'options')) {
    const element = unwrap(item, 'DefElem');
    if (element === undefined) continue;
    const name = str(element, 'defname') ?? '';
    if (!['as', 'start', 'increment', 'cache', 'minvalue', 'maxvalue'].includes(name)) {
      return undefined; // CYCLE, OWNED BY, … are not what `serial` creates
    }
    // NO MINVALUE / NO MAXVALUE carry no argument; any value is not serial's.
    if ((name === 'minvalue' || name === 'maxvalue') && element.arg !== undefined) return undefined;
    if (name === 'as') {
      const typeName = unwrap(element.arg, 'TypeName');
      const names = typeName === undefined ? [] : stringList(typeName, 'names');
      asType = names[names.length - 1] ?? '';
    }
  }
  return asType in SERIAL_FOR ? asType : undefined;
}

/** `nextval('seq'::regclass)` → the sequence's name, or undefined for any other default. */
function nextvalTarget(def: unknown): string | undefined {
  const call = unwrap(def, 'FuncCall');
  if (call === undefined) return undefined;
  const fn = stringList(call, 'funcname');
  if (fn[fn.length - 1] !== 'nextval') return undefined;
  const [arg] = children(call, 'args');
  const cast = unwrap(arg, 'TypeCast');
  const constant = unwrap(cast?.arg ?? arg, 'A_Const');
  // libpg-query writes A_Const's string as `{ sval: { sval } }`, without a String wrapper.
  const sval = asNode(constant?.sval);
  return sval === undefined ? undefined : str(sval, 'sval');
}

export function foldSerialColumns(
  statements: readonly unknown[],
  model: ImportModel,
): ReadonlyMap<number, IrObjectRef> {
  const key = (schema: string | undefined, name: string) =>
    `${normalizeName(model.resolveNamespace(schema).name)}.${normalizeName(name)}`;
  const bySequence = new Map<string, Parts>();
  const parts = (k: string): Parts => {
    const found = bySequence.get(k) ?? {};
    bySequence.set(k, found);
    return found;
  };

  statements.forEach((statement, index) => {
    const created = unwrap(statement, 'CreateSeqStmt');
    if (created !== undefined) {
      const target = rangeVar(created.sequence);
      const asType = serialSequence(created);
      if (target !== undefined && asType !== undefined) {
        parts(key(target.schema, target.name)).sequence = { index, asType };
      }
      return;
    }

    const altered = unwrap(statement, 'AlterSeqStmt');
    if (altered !== undefined) {
      const target = rangeVar(altered.sequence);
      const options = children(altered, 'options').map((o) => unwrap(o, 'DefElem'));
      const owned = options.length === 1 ? options[0] : undefined;
      const list = unwrap(owned?.arg, 'List');
      const path = list === undefined ? [] : stringList(list, 'items');
      if (target === undefined || str(owned ?? {}, 'defname') !== 'owned_by' || path.length < 2) {
        return;
      }
      const [column, table, schema] = [...path].reverse();
      if (column === undefined || table === undefined) return;
      parts(key(target.schema, target.name)).owner = { index, column: { schema, table, column } };
      return;
    }

    const table = unwrap(statement, 'AlterTableStmt');
    const commands = table === undefined ? [] : children(table, 'cmds');
    // One command only: absorbing a statement that also did something else would hide it.
    const command = commands.length === 1 ? unwrap(commands[0], 'AlterTableCmd') : undefined;
    const relation = rangeVar(table?.relation);
    if (command === undefined || relation === undefined) return;
    if (str(command, 'subtype') !== 'AT_ColumnDefault') return;
    const sequence = nextvalTarget(command.def);
    const column = str(command, 'name');
    if (sequence === undefined || column === undefined) return;
    const seq = splitQualified(sequence);
    parts(key(seq.schema, seq.name)).defaulted = {
      index,
      column: { schema: relation.schema, table: relation.name, column },
    };
  });

  const absorbed = new Map<number, IrObjectRef>();
  for (const { sequence, owner, defaulted } of bySequence.values()) {
    if (sequence === undefined || owner === undefined || defaulted === undefined) continue;
    const entity = model.findEntity(owner.column.schema, owner.column.table);
    if (entity === undefined) continue;
    if (model.findEntity(defaulted.column.schema, defaulted.column.table) !== entity) continue;
    const field = model.findField(entity, owner.column.column);
    if (field === undefined || model.findField(entity, defaulted.column.column) !== field) continue;

    const target = SERIAL_FOR[sequence.asType];
    const { type } = field;
    const plain =
      (type.dimensions ?? 0) === 0 && (type.args ?? []).length === 0 && !type.customTypeId;
    if (target === undefined || !plain || type.name !== target.column) continue;

    const { default: _nextval, ...engineProps } = field.engineProps;
    model.updateField(field, {
      type: model.buildTypeRef(entity.namespaceId, target.serial, [], 0),
      engineProps,
    });
    const ref: IrObjectRef = { type: 'field', id: field.id };
    for (const index of [sequence.index, owner.index, defaulted.index]) absorbed.set(index, ref);
  }
  return absorbed;
}
