import type { Id, ImportResult } from '@schemaloom/engine-sdk';
import { describe, expect, it } from 'vitest';
import { ECOMMERCE_DDL, MIXED_DDL } from './conformance-ddl.js';
import { IMPORTER } from './importer.js';
import { splitStatements } from './sql-scan.js';

function importDdl(source: string, serverVersion = 'MySQL 8.4'): Promise<ImportResult> {
  let n = 0;
  return IMPORTER.import(
    source,
    { format: 'ddl', defaultNamespace: null, caseFolding: 'preserve', engineOptions: {} },
    { projectId: 'p1', serverVersion, newId: () => `id${String((n += 1)).padStart(4, '0')}` },
  );
}

const byName = <T extends { name: string }>(bag: Record<Id, T>) =>
  new Map(Object.values(bag).map((o) => [o.name, o]));

describe('splitStatements', () => {
  it('honours DELIMITER, quotes and both comment styles', () => {
    const parts = splitStatements(
      "SELECT ';'; # c;\n-- d;\nDELIMITER ;;\nCREATE TRIGGER t BEGIN SET x = 1; END ;;\nDELIMITER ;\nSELECT `a;b`;",
    ).map((c) => c.text);
    expect(parts).toEqual(["SELECT ';'", 'CREATE TRIGGER t BEGIN SET x = 1; END', 'SELECT `a;b`']);
  });
});

describe('a mysqldump file', () => {
  it('applies every schema statement and ignores the framing', async () => {
    const { report } = await importDdl(ECOMMERCE_DDL);
    const notApplied = report.statements.filter(
      (s) => s.status !== 'applied' && s.status !== 'ignored',
    );
    expect(notApplied.map((s) => `${s.kind}: ${s.reason ?? ''}`)).toEqual([]);
  });

  it('keeps what the IR needs from a column', async () => {
    const { model } = await importDdl(ECOMMERCE_DDL);
    const customers = byName(model.objects.entity).get('customers');
    const fields = byName(
      Object.fromEntries(
        Object.entries(model.objects.field).filter(([, f]) => f.entityId === customers?.id),
      ),
    );
    expect(fields.get('id')?.engineProps).toEqual({ unsigned: true, autoIncrement: true });
    expect(fields.get('id')?.isNullable).toBe(false);
    expect(fields.get('status')?.type).toEqual({
      name: 'enum',
      args: ['active', 'suspended', 'closed'],
    });
    expect(fields.get('status')?.engineProps).toEqual({ default: "'active'" });
    expect(fields.get('email')?.engineProps).toEqual({ collation: 'utf8mb4_unicode_ci' });
    expect(fields.get('updated_at')?.engineProps).toEqual({
      default: 'CURRENT_TIMESTAMP',
      onUpdate: 'CURRENT_TIMESTAMP',
    });
    expect(fields.get('email_lower')?.engineProps).toMatchObject({ generatedKind: 'VIRTUAL' });
    expect(fields.get('is_vip')?.type).toEqual({ name: 'boolean' });
    const placed = Object.values(model.objects.field).find((f) => f.name === 'placed_at');
    expect(placed?.type).toEqual({ name: 'datetime', args: [3] });
  });

  it('keeps keys, indexes, the check and the foreign key', async () => {
    const { model } = await importDdl(ECOMMERCE_DDL);
    const customers = byName(model.objects.entity).get('customers');
    expect(customers?.engineProps).toEqual({
      engine: 'InnoDB',
      charset: 'utf8mb4',
      collation: 'utf8mb4_0900_ai_ci',
    });
    const constraints = Object.values(model.objects.constraint)
      .map((c) => `${c.kind}:${c.name}`)
      .sort();
    expect(constraints).toEqual([
      'check:balance_nonneg',
      'primaryKey:PRIMARY',
      'primaryKey:PRIMARY',
      'unique:customers_email_uq',
    ]);
    const indexes = byName(model.objects.index);
    expect(indexes.get('idx_name_prefix')?.columns[0]?.engineProps).toEqual({ length: 20 });
    expect(indexes.get('idx_lower_email')?.columns[0]?.expression).toMatch(/lower\(`?email`?\)/i);
    expect(indexes.get('ft_name')?.kind).toBe('fulltext');
    expect(indexes.get('idx_customer_id')?.columns[1]?.direction).toBe('desc');
    const link = Object.values(model.objects.link)[0];
    expect(link?.name).toBe('fk_orders_customer');
    expect(link?.engineProps).toEqual({ onDelete: 'restrict', onUpdate: 'cascade' });
  });

  it('replaces the placeholder view with the real one', async () => {
    const { model } = await importDdl(ECOMMERCE_DDL);
    const views = Object.values(model.objects.entity).filter((e) => e.kind === 'view');
    expect(views).toHaveLength(1);
    expect(views[0]?.engineProps.viewDefinition).toMatch(/^select `orders`\.`id`/);
    expect(views[0]?.engineProps).toMatchObject({ algorithm: 'UNDEFINED', sqlSecurity: 'DEFINER' });
    expect(
      Object.values(model.objects.field).filter((f) => f.entityId === views[0]?.id),
    ).toHaveLength(2);
    // The view names `orders`: export order and redaction both read this.
    expect(views[0]?.refs?.entityIds).toContain(byName(model.objects.entity).get('orders')?.id);
  });

  it('turns table and column comments into docs', async () => {
    const { model, docs } = await importDdl(ECOMMERCE_DDL);
    const entities = byName(model.objects.entity);
    const fields = byName(model.objects.field);
    expect(docs).toEqual(
      expect.arrayContaining([
        {
          target: { type: 'entity', id: entities.get('customers')?.id },
          text: 'People with an account',
        },
        { target: { type: 'field', id: fields.get('email')?.id }, text: 'Login address' },
      ]),
    );
  });
});

describe('the report accounts for every statement', () => {
  it('names each status and its reason', async () => {
    const { report, model } = await importDdl(MIXED_DDL);
    expect(report.statements.map((s) => [s.kind, s.status])).toEqual([
      ['SET', 'ignored'],
      ['CREATE TABLE', 'applied'],
      ['CREATE INDEX', 'applied'],
      ['CREATE TRIGGER', 'unsupported'],
      ['CREATE TABLE', 'partial'],
      ['INSERT', 'ignored'],
      ['unparsed', 'failed'],
    ]);
    expect(report.statements[4]?.reason).toBe('Partitioning is not kept');
    expect(byName(model.objects.entity).has('events')).toBe(true);
  });
});
