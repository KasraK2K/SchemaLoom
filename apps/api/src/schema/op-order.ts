import { IR_OBJECT_TYPES, type IrObjectType } from '@schemaloom/schema-model';
import type { SchemaOperation } from './ops';

/**
 * Doc 04 §8.6 RULE 7 — the server sorts the batch before applying it.
 *
 * `IR_OBJECT_TYPES` is already the dependency order (a field needs its entity, a link
 * needs both entities), so creates run up it and deletes run down it. Without this, a
 * client that emits its ops in any other order — and "create the fields, then the table"
 * is a perfectly natural thing for a paste handler to do — gets a raw foreign-key
 * violation out of `fields.entity_id` instead of a typed error, and the whole atomic
 * batch rolls back for a reason the user cannot act on.
 *
 * Client order is PRESERVED WITHIN A RANK, which is what makes "a create may reference an
 * id created earlier in the same batch" true for two objects of the same type.
 */
const RANK: ReadonlyMap<IrObjectType, number> = new Map(
  IR_OBJECT_TYPES.map((type, i) => [type, i]),
);

const rankOf = (type: IrObjectType): number => RANK.get(type) ?? IR_OBJECT_TYPES.length;

/** creates → updates and moves → deletes. */
const PHASE = { create: 0, update: 1, move: 1, delete: 2 } as const;

export function sortOps(ops: readonly SchemaOperation[]): SchemaOperation[] {
  // `toSorted` is not available on the Node 22 lib target this package compiles against;
  // a shallow copy plus a stable `sort` is the same thing. V8's sort IS stable, so
  // "client order within a rank" needs no tiebreaker index.
  return [...ops].sort((a, b) => {
    const phase = PHASE[a.op] - PHASE[b.op];
    if (phase !== 0) return phase;
    if (a.op === 'create' && b.op === 'create') return rankOf(a.type) - rankOf(b.type);
    if (a.op === 'delete' && b.op === 'delete') return rankOf(b.type) - rankOf(a.type);
    return 0;
  });
}
