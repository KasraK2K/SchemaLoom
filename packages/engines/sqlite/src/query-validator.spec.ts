import type { ImportOptions, RedactedModel } from '@schemaloom/engine-sdk';
import { describe, expect, it } from 'vitest';
import { IMPORTER } from './importer.js';
import { QUERY_VALIDATOR } from './query-validator.js';

/** Phase 13 §4.5 — validating a query against the caller's redacted design. */

const OPTIONS: ImportOptions = {
  format: 'ddl',
  defaultNamespace: '',
  caseFolding: 'preserve',
  engineOptions: {},
};

async function model(): Promise<RedactedModel> {
  let n = 0;
  const { model: m } = await IMPORTER.import(
    'CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT);\nCREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total INTEGER);',
    OPTIONS,
    { projectId: 'p1', serverVersion: '3.45', newId: () => `id${String(++n)}` },
  );
  return { ...m, redacted: true } as RedactedModel;
}

const validate = async (query: string) =>
  QUERY_VALIDATOR.validate({
    query,
    model: await model(),
    context: { projectId: 'p1', serverVersion: '3.45' },
  });

describe('sqlite query validator', () => {
  it('resolves tables and columns, and says which a typo meant', async () => {
    const out = await validate(
      'SELECT o.totl, c.email FROM orders o JOIN customers c ON c.id = o.customer_id',
    );
    expect(out.parsed).toBe(true);
    expect(out.touchedEntityIds.length).toBe(2);
    const typo = out.identifiers.find((i) => i.status === 'unknown');
    expect(typo).toMatchObject({ text: 'o.totl', suggestions: ['total'] });
  });

  it("falls back to SQLite's own compiler, and reports its error", async () => {
    // `IS NOT DISTINCT FROM` and an UPSERT-free window clause trip some grammars; SQLite reads them.
    const ok = await validate('SELECT id FROM orders WHERE total IS NOT DISTINCT FROM 1');
    expect(ok.parsed).toBe(true);
    expect(ok.touchedEntityIds.length).toBe(1);
    const bad = await validate('SELEC id FROM orders');
    expect(bad.parsed).toBe(false);
    expect(bad.parseErrors[0]?.message).toContain('syntax error');
  });
});
