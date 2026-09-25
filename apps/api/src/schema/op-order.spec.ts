import { describe, expect, it } from 'vitest';
import { sortOps } from './op-order';
import type { SchemaOperation } from './ops';

/**
 * Doc 04 §8.6 rule 7. Without this, a paste handler that emits its fields before its
 * table gets a raw `fields.entity_id` foreign-key violation instead of a typed error,
 * and the whole atomic batch rolls back for a reason the user cannot act on.
 */
const create = (type: string, id: string): SchemaOperation =>
  ({ op: 'create', type, object: { id } }) as unknown as SchemaOperation;

const del = (type: string, id: string): SchemaOperation =>
  ({ op: 'delete', type, id, expectedVersion: 0 }) as SchemaOperation;

const label = (ops: SchemaOperation[]): string[] =>
  ops.map((op) => `${op.op}:${op.type}:${op.op === 'create' ? op.object.id : op.id}`);

describe('sortOps', () => {
  it('runs creates UP the dependency order', () => {
    const sorted = sortOps([
      create('field', 'f1'),
      create('link', 'l1'),
      create('entity', 'e1'),
      create('area', 'a1'),
    ]);
    expect(label(sorted)).toEqual([
      'create:area:a1',
      'create:entity:e1',
      'create:field:f1',
      'create:link:l1',
    ]);
  });

  it('runs deletes DOWN it', () => {
    const sorted = sortOps([del('area', 'a1'), del('entity', 'e1'), del('link', 'l1')]);
    expect(label(sorted)).toEqual(['delete:link:l1', 'delete:entity:e1', 'delete:area:a1']);
  });

  it('puts every create before every update and every delete last', () => {
    const update: SchemaOperation = {
      op: 'update',
      type: 'entity',
      id: 'e2',
      expectedVersion: 0,
      patch: {},
    };
    const sorted = sortOps([del('field', 'f1'), update, create('entity', 'e1')]);
    expect(label(sorted)).toEqual(['create:entity:e1', 'update:entity:e2', 'delete:field:f1']);
  });

  it('preserves client order WITHIN a rank, so a create may reference an earlier one', () => {
    const sorted = sortOps([create('field', 'f3'), create('field', 'f1'), create('field', 'f2')]);
    expect(label(sorted)).toEqual(['create:field:f3', 'create:field:f1', 'create:field:f2']);
  });

  it('does not mutate the caller’s array', () => {
    const ops = [del('entity', 'e1'), create('entity', 'e2')];
    const before = label(ops);
    sortOps(ops);
    expect(label(ops)).toEqual(before);
  });
});
