import { describe, expect, it } from 'vitest';
import { referenceModel } from './conformance-fixtures.js';
import { fullyVisible } from './fixture-model.js';
import { QUERY_VALIDATOR } from './query-validator.js';

const model = fullyVisible(referenceModel());
const validate = (query: string) =>
  QUERY_VALIDATOR.validate({
    query,
    model,
    context: { projectId: 'p1', serverVersion: 'MySQL 8.4' },
  });
const statuses = async (query: string) =>
  (await validate(query)).identifiers.map((i) => `${i.text}:${i.status}`);

describe('MySQL query validator', () => {
  it('resolves aliases and backticks, and points at each name', async () => {
    const result = await validate(
      'SELECT c.`email`, o.total FROM `customers` c JOIN orders o ON o.customer_id = c.id',
    );
    expect(result.parsed).toBe(true);
    expect(result.statementKinds).toEqual(['SELECT']);
    expect(result.identifiers.every((i) => i.status === 'resolved')).toBe(true);
    const email = result.identifiers.find((i) => i.text.includes('email'));
    expect(email?.range.start).toBe(7);
  });

  it('treats a CTE as query-local and a select alias as an alias', async () => {
    expect(
      await statuses(
        'WITH recent AS (SELECT id FROM orders) SELECT r.id FROM recent r ORDER BY id',
      ),
    ).toEqual([
      'id:resolved', // inside the CTE: orders.id
      'orders:resolved',
      'r.id:unchecked', // through the CTE, which the validator does not resolve column by column
      'recent:alias-local',
      'id:resolved', // one scope per statement: the column the CTE passes through
    ]);
    expect(await statuses('SELECT total AS t FROM orders ORDER BY t')).toEqual([
      'total:resolved',
      'orders:resolved',
      't:alias-local',
    ]);
  });

  it('says ambiguous for a bare column two tables share, and suggests near misses', async () => {
    const result = await validate('SELECT id, emial FROM customers JOIN orders ON 1 = 1');
    const [id, emial] = result.identifiers.filter((i) => i.role === 'field');
    expect(id?.status).toBe('ambiguous');
    expect(emial?.status).toBe('unknown');
    expect(emial?.suggestions).toEqual(['email']);
  });

  it('reports a parse error with its place, and never throws', async () => {
    const result = await validate('SELECT FROM WHERE (');
    expect(result.parsed).toBe(false);
    expect(result.parseErrors[0]?.range.start).toBeGreaterThan(0);
  });

  it('reports the same names and places on a MariaDB target', async () => {
    // The MariaDB grammar gives tables no location and pads a column's with the next space.
    const result = await QUERY_VALIDATOR.validate({
      query: 'SELECT emial FROM customers',
      model,
      context: { projectId: 'p1', serverVersion: 'MariaDB 11.4' },
    });
    expect(result.identifiers.map((i) => [i.text, i.status, i.range.start, i.range.end])).toEqual([
      ['emial', 'unknown', 7, 12],
      ['customers', 'resolved', 18, 27],
    ]);
  });

  it('names a write statement so core can warn', async () => {
    expect(
      (await validate("UPDATE customers SET status = 'closed' WHERE id = 1")).statementKinds,
    ).toEqual(['UPDATE']);
  });
});
