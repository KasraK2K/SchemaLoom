import { describe, expect, it } from 'vitest';
import { byId, entity, field, model, namespace } from '../fixtures.js';
import type { Entity } from '../entity.js';
import type { Field } from '../field.js';
import { nameSimilarity, renameCandidates } from './rename-candidates.js';

const NS = [namespace('ns1', 'public'), namespace('ns2', 'billing')];
const m = (entities: Entity[], fields: Field[]) =>
  model({ namespace: byId(NS), entity: byId(entities), field: byId(fields) });
const cols = (entityId: string, names: string[], prefix = entityId) =>
  names.map((n, i) => field(`${prefix}_${n}`, n, entityId, { ordinal: i }));

describe('renameCandidates — entities', () => {
  it('scores a plain table rename with unchanged columns 1.0', () => {
    const before = m([entity('e1', 'customer', 'ns1')], cols('e1', ['id', 'email', 'name']));
    const after = m([entity('n1', 'customers', 'ns1')], cols('n1', ['id', 'email', 'name']));
    const [candidate] = renameCandidates(before, after);
    expect(candidate).toMatchObject({
      type: 'entity',
      fromId: 'e1',
      toId: 'n1',
      toName: 'customers',
      score: 1,
      reason: '3 of 3 columns match',
    });
  });

  it('reports "5 of 6 columns match" and never a percentage', () => {
    const names = ['id', 'email', 'name', 'city', 'zip'];
    const before = m([entity('e1', 'customer', 'ns1')], cols('e1', names));
    const after = m([entity('n1', 'clients', 'ns1')], cols('n1', [...names, 'phone']));
    const [candidate] = renameCandidates(before, after);
    expect(candidate?.reason).toBe('5 of 6 columns match');
    expect(candidate?.reason).not.toMatch(/%/);
  });

  it('never pairs across namespaces', () => {
    const before = m([entity('e1', 'customer', 'ns1')], cols('e1', ['id', 'email']));
    const after = m([entity('n1', 'customers', 'ns2')], cols('n1', ['id', 'email']));
    expect(renameCandidates(before, after)).toEqual([]);
  });

  it('needs Jaccard >= 0.5 AND at least 2 shared names', () => {
    const before = m([entity('e1', 'a', 'ns1')], cols('e1', ['id', 'x', 'y', 'z']));
    const after = m([entity('n1', 'b', 'ns1')], cols('n1', ['id', 'x', 'p', 'q']));
    // 2 shared of 6 = 0.33
    expect(renameCandidates(before, after)).toEqual([]);
  });

  it('pairs tables with <= 1 field by name similarity >= 0.7 only', () => {
    const before = m(
      [entity('e1', 'tag', 'ns1'), entity('e2', 'audit', 'ns1')],
      [...cols('e1', ['id']), ...cols('e2', ['id'])],
    );
    const after = m([entity('n1', 'tags', 'ns1')], cols('n1', ['id']));
    const out = renameCandidates(before, after);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      fromId: 'e1',
      toId: 'n1',
      reason: 'similar name, 1 of 1 columns match',
    });
  });

  it('is greedy: each entity appears in at most one candidate, best score first', () => {
    const before = m(
      [entity('e1', 'customer', 'ns1'), entity('e2', 'customer_old', 'ns1')],
      [...cols('e1', ['id', 'email', 'name']), ...cols('e2', ['id', 'email', 'zip'])],
    );
    const after = m([entity('n1', 'customers', 'ns1')], cols('n1', ['id', 'email', 'name']));
    const entities = renameCandidates(before, after).filter((c) => c.type === 'entity');
    expect(entities).toHaveLength(1);
    expect(entities[0]?.fromId).toBe('e1');
  });

  it('breaks a score tie by name similarity', () => {
    const before = m(
      [entity('e1', 'zzz', 'ns1'), entity('e2', 'order', 'ns1')],
      [...cols('e1', ['id', 'total']), ...cols('e2', ['id', 'total'])],
    );
    const after = m([entity('n1', 'orders', 'ns1')], cols('n1', ['id', 'total']));
    expect(renameCandidates(before, after).find((c) => c.type === 'entity')?.fromId).toBe('e2');
  });

  it('proposes nothing for tables present in both models', () => {
    const both = m([entity('e1', 'customer', 'ns1')], cols('e1', ['id', 'email']));
    expect(renameCandidates(both, both)).toEqual([]);
  });
});

describe('renameCandidates — fields', () => {
  const matched = (oldCols: Field[], newCols: Field[]) =>
    renameCandidates(
      m([entity('e1', 't', 'ns1')], oldCols),
      m([entity('e1', 't', 'ns1')], newCols),
    );

  it('pairs a field in a matched entity at the same position with the same type', () => {
    const out = matched(
      [field('f1', 'id', 'e1', { ordinal: 0 }), field('f2', 'email', 'e1', { ordinal: 1 })],
      [field('f1', 'id', 'e1', { ordinal: 0 }), field('x2', 'email_address', 'e1', { ordinal: 1 })],
    );
    expect(out).toEqual([
      expect.objectContaining({
        type: 'field',
        entityId: 'e1',
        fromId: 'f2',
        toName: 'email_address',
        reason: 'same type, same position',
      }),
    ]);
  });

  it('requires the same type', () => {
    const out = matched(
      [field('f2', 'email', 'e1', { ordinal: 1 })],
      [field('x2', 'email_address', 'e1', { ordinal: 1, type: { name: 'int4' } })],
    );
    expect(out).toEqual([]);
  });

  it('pairs by name similarity >= 0.6 when the position moved', () => {
    const out = matched(
      [field('f2', 'created', 'e1', { ordinal: 1 })],
      [
        field('x0', 'id', 'e1', { ordinal: 0, type: { name: 'int4' } }),
        field('x2', 'created_at', 'e1', { ordinal: 3 }),
      ],
    );
    expect(out).toEqual([
      expect.objectContaining({ fromId: 'f2', toId: 'x2', reason: 'same type, similar name' }),
    ]);
  });

  it('proposes field pairs inside a proposed entity rename, owned by the project entity', () => {
    const before = m(
      [entity('e1', 'customer', 'ns1')],
      cols('e1', ['id', 'email', 'name', 'mail']),
    );
    const after = m(
      [entity('n1', 'customers', 'ns1')],
      cols('n1', ['id', 'email', 'name', 'mail_2']),
    );
    const fields = renameCandidates(before, after).filter((c) => c.type === 'field');
    expect(fields).toEqual([
      expect.objectContaining({ entityId: 'e1', fromName: 'mail', toName: 'mail_2' }),
    ]);
  });

  it('gives each field at most one candidate', () => {
    const out = matched(
      [field('f1', 'name', 'e1', { ordinal: 0 })],
      [field('x1', 'title', 'e1', { ordinal: 0 }), field('x2', 'names', 'e1', { ordinal: 1 })],
    );
    expect(out.map((c) => [c.fromId, c.toId])).toEqual([['f1', 'x1']]);
  });
});

describe('nameSimilarity', () => {
  it('is 1 for equal strings and falls with edit distance', () => {
    expect(nameSimilarity('abc', 'abc')).toBe(1);
    expect(nameSimilarity('customer', 'customers')).toBeCloseTo(8 / 9);
    expect(nameSimilarity('abc', 'xyz')).toBe(0);
  });
});
