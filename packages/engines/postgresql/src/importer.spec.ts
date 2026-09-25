import { renderStatements, type Id, type ImportResult } from '@schemaloom/engine-sdk';
import { describe, expect, it } from 'vitest';
import { ECOMMERCE_DDL, MIXED_DDL } from './conformance-ddl.js';
import { EXPORTER } from './exporter.js';
import { fullyVisible } from './fixture-model.js';
import { IMPORTER, defaultImportOptions } from './importer.js';
import { splitStatements } from './sql-scan.js';

/**
 * Doc 03 §9, from the side the conformance suite cannot reach: the suite asserts the
 * INVARIANTS over whatever fixtures an engine supplies; this file asserts that a real
 * PostgreSQL file becomes the IR a user would recognise, and that the statements it refuses
 * are named rather than lost.
 */

function seeded(prefix = 'cid'): () => Id {
  let n = 0;
  return () => `${prefix}${String((n += 1)).padStart(4, '0')}`;
}

function importDdl(source: string, prefix?: string): Promise<ImportResult> {
  return IMPORTER.import(source, defaultImportOptions(), {
    projectId: 'p1',
    serverVersion: '16',
    newId: seeded(prefix),
  });
}

/** Every object of one type, keyed by name, for readable assertions. */
function byName<T extends { name: string }>(bag: Record<Id, T>): Map<string, T> {
  return new Map(Object.values(bag).map((object) => [object.name, object]));
}

describe('a realistic e-commerce schema', () => {
  it('produces the entities, in their namespaces, with the right kinds', async () => {
    const { model } = await importDdl(ECOMMERCE_DDL);
    const namespaces = byName(model.objects.namespace);
    expect([...namespaces.keys()].sort()).toEqual(['billing', 'public']);
    expect(namespaces.get('public')?.isDefault).toBe(true);

    const entities = byName(model.objects.entity);
    expect([...entities.keys()].sort()).toEqual([
      'customers',
      'order_lines',
      'order_summary',
      'orders',
    ]);
    expect(entities.get('orders')?.kind).toBe('table');
    expect(entities.get('order_summary')?.kind).toBe('view');
    expect(entities.get('order_summary')?.namespaceId).toBe(namespaces.get('billing')?.id);
  });

  it('produces the fields with canonical types, nullability and ordinals', async () => {
    const { model } = await importDdl(ECOMMERCE_DDL);
    const orders = byName(model.objects.entity).get('orders');
    const fields = Object.values(model.objects.field)
      .filter((field) => field.entityId === orders?.id)
      .sort((a, b) => a.ordinal - b.ordinal);

    expect(fields.map((f) => f.name)).toEqual([
      'id',
      'customer_id',
      'status',
      'quantity',
      'total',
      'net_total',
      'placed_at',
    ]);
    expect(fields.map((f) => f.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6]);

    const total = fields.find((f) => f.name === 'total');
    expect(total?.type).toEqual({ name: 'numeric', args: [12, 2] });
    expect(total?.isNullable).toBe(false);

    // `character varying` and `timestamp with time zone` are ALIASES: the stored ref is
    // canonical either way, which is what keeps a re-import from drifting.
    const customers = byName(model.objects.entity).get('customers');
    const email = Object.values(model.objects.field).find(
      (f) => f.entityId === customers?.id && f.name === 'email',
    );
    expect(email?.type).toEqual({ name: 'varchar', args: [255] });

    const tags = Object.values(model.objects.field).find(
      (f) => f.entityId === customers?.id && f.name === 'tags',
    );
    expect(tags?.type).toEqual({ name: 'text', dimensions: 1 });
  });

  it('reads a DEFAULT without swallowing the constraint that follows it', async () => {
    const { model } = await importDdl(ECOMMERCE_DDL);
    const placedAt = Object.values(model.objects.field).find((f) => f.name === 'placed_at');
    // `DEFAULT now() NOT NULL` — an offset-based reader that scans to the next comma takes
    // `now() NOT NULL` and produces DDL PostgreSQL rejects on the way back out.
    expect(placedAt?.engineProps.default).toBe('now()');
    expect(placedAt?.isNullable).toBe(false);
  });

  it('reads identity, generated and enum-defaulted columns', async () => {
    const { model } = await importDdl(ECOMMERCE_DDL);
    const fields = byName(model.objects.field);
    expect(
      Object.values(model.objects.field).find(
        (f) => f.name === 'id' && f.engineProps.identity === 'always',
      ),
    ).toBeDefined();
    expect(fields.get('net_total')?.engineProps.generatedExpression).toBe('total * 0.9');
    expect(fields.get('status')?.engineProps.default).toBe("'pending'");
  });

  it('binds a column to the user-defined type it names', async () => {
    const { model } = await importDdl(ECOMMERCE_DDL);
    const types = byName(model.objects.customType);
    expect(types.get('order_status')?.kind).toBe('enum');
    expect(types.get('order_status')?.engineProps.labels).toEqual([
      'pending',
      'paid',
      'refunded',
      'void',
    ]);
    expect(types.get('positive_int')?.kind).toBe('domain');
    expect(types.get('positive_int')?.engineProps).toEqual({
      baseType: 'integer',
      notNull: true,
      checks: ['VALUE > 0'],
    });

    const status = byName(model.objects.field).get('status');
    expect(status?.type.customTypeId).toBe(types.get('order_status')?.id);
  });

  it('produces the links, including one whose target is defined earlier and one later', async () => {
    const { model } = await importDdl(ECOMMERCE_DDL);
    const entities = model.objects.entity;
    const fields = model.objects.field;
    const describe_ = (linkName: string): string => {
      const link = byName(model.objects.link).get(linkName);
      const names = (ids: readonly Id[]): string => ids.map((id) => fields[id]?.name ?? '?').join(',');
      const side = (endpoint: { entityId: Id; fieldIds: readonly Id[] } | undefined): string =>
        `${entities[endpoint?.entityId ?? '']?.name ?? '?'}(${names(endpoint?.fieldIds ?? [])})`;
      return `${side(link?.from)}->${side(link?.to)}`;
    };

    expect(describe_('orders_customer_id_fkey')).toBe('orders(customer_id)->customers(id)');
    expect(describe_('order_lines_order_id_fkey')).toBe('order_lines(order_id)->orders(id)');
    expect(byName(model.objects.link).get('orders_customer_id_fkey')?.engineProps).toEqual({
      onDelete: 'restrict',
      onUpdate: 'cascade',
    });
  });

  it('produces the constraints, with a composite primary key kept in order', async () => {
    const { model } = await importDdl(ECOMMERCE_DDL);
    const pk = byName(model.objects.constraint).get('order_lines_pkey');
    expect(pk?.kind).toBe('primaryKey');
    expect(pk?.fieldIds.map((id) => model.objects.field[id]?.name)).toEqual([
      'order_id',
      'line_no',
    ]);

    const check = byName(model.objects.constraint).get('orders_total_positive');
    expect(check?.kind).toBe('check');
    expect(check?.engineProps.expression).toBe('total > 0');
    // A CHECK names its columns in SQL text, so `fieldIds` stays empty and
    // `extractReferences` is what turns the text into ids (§3.1).
    expect(check?.fieldIds).toEqual([]);
    // `total` is ambiguous by NAME — the view has a column of that name too — so the
    // assertion names the one on `orders`, which is what the CHECK body means.
    const ordersId = byName(model.objects.entity).get('orders')?.id;
    const ordersTotal = Object.values(model.objects.field).find(
      (f) => f.entityId === ordersId && f.name === 'total',
    );
    expect(check?.refs?.fieldIds).toContain(ordersTotal?.id);
  });

  it('produces the indexes, with expression, partial and INCLUDE forms intact', async () => {
    const { model } = await importDdl(ECOMMERCE_DDL);
    const indexes = byName(model.objects.index);

    const composite = indexes.get('orders_customer_id_idx');
    expect(composite?.columns.map((c) => [c.role, model.objects.field[c.fieldId ?? '']?.name, c.direction])).toEqual([
      ['key', 'customer_id', undefined],
      ['key', 'placed_at', 'desc'],
      ['include', 'total', undefined],
    ]);

    expect(indexes.get('orders_open_idx')?.engineProps.where).toBe('total > 0');

    const expression = indexes.get('customers_email_lower_idx');
    expect(expression?.isUnique).toBe(true);
    expect(expression?.columns[0]?.expression).toBe('lower(email)');
    expect(expression?.columns[0]?.fieldId).toBeNull();
  });

  it('applies every statement in the file', async () => {
    const { report } = await importDdl(ECOMMERCE_DDL);
    expect(report.countsByStatus.applied).toBe(report.statementCount);
    expect(report.objectCounts).toEqual({
      namespace: 2,
      customType: 2,
      entity: 4,
      field: 19,
      constraint: 5, // the two foreign keys are Links, not Constraints
      index: 3,
      link: 2,
    });
  });
});

describe('the report accounts for every statement (§9.1)', () => {
  it('names each refused statement, its kind, its reason and where it is', async () => {
    const { report } = await importDdl(MIXED_DDL);
    const rows = report.statements.map((s) => ({ kind: s.kind, status: s.status }));

    expect(rows).toEqual([
      { kind: 'SET', status: 'ignored' },
      { kind: 'TRANSACTION', status: 'ignored' },
      { kind: 'CREATE TABLE', status: 'applied' },
      { kind: 'CREATE TRIGGER', status: 'unsupported' },
      { kind: 'COMMENT', status: 'ignored' },
      { kind: 'ALTER TABLE', status: 'partial' },
      { kind: 'unparsed', status: 'failed' },
      { kind: 'TRANSACTION', status: 'ignored' },
    ]);

    // "3 statements could not be applied" is this subtraction and nothing else (§9.1).
    expect(report.statementCount - report.countsByStatus.applied).toBe(7);

    for (const statement of report.statements) {
      if (statement.status === 'applied') continue;
      expect(statement.reason).toBeTruthy();
      expect(statement.range.end).toBeGreaterThan(statement.range.start);
      expect(statement.range.line).toBeGreaterThanOrEqual(1);
      expect(statement.excerpt).not.toContain('\n');
    }

    const trigger = report.statements.find((s) => s.kind === 'CREATE TRIGGER');
    expect(trigger?.reason).toBe('Triggers are not part of the schema model');
  });

  it('reports a syntax error instead of throwing, and keeps the rest of the file', async () => {
    const result = await importDdl(MIXED_DDL);
    const failed = result.report.statements.filter((s) => s.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason).toContain('syntax error');

    // The point of splitting before parsing: one typo is one failed statement, not a
    // refused file. `invoices` still made it into the model.
    expect(byName(result.model.objects.entity).has('invoices')).toBe(true);

    // …and the failure reaches the diagnostics as a PROJECT-targeted entry with a range,
    // which is the only reason `DiagnosticTarget.type` admits 'project'.
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.target).toEqual({ type: 'project', id: 'p1' });
    expect(result.diagnostics[0]?.range).toBeDefined();
  });

  it('points each range at real text in the source', async () => {
    const { report } = await importDdl(MIXED_DDL);
    for (const statement of report.statements) {
      const slice = MIXED_DDL.slice(statement.range.start, statement.range.end);
      expect(slice.replace(/\s+/g, ' ').trim().slice(0, 20)).toBe(statement.excerpt.slice(0, 20));
    }
  });

  it('never throws on input no parser can make sense of', async () => {
    for (const source of ['', '   ', ';;;', 'not sql', "SELECT 'unterminated", '/* open']) {
      const result = await importDdl(source);
      expect(result.report.statements).toHaveLength(result.report.statementCount);
    }
  });
});

describe('statement splitting', () => {
  it('ignores a semicolon inside a string, a dollar-quote, a comment or parentheses', () => {
    const source = [
      "CREATE TABLE a (x text DEFAULT 'has ; inside');",
      'CREATE FUNCTION f() RETURNS int AS $body$ BEGIN; RETURN 1; END; $body$ LANGUAGE plpgsql;',
      '-- a comment with ; in it',
      '/* and a block ; comment */',
      'CREATE TABLE b (y int);',
    ].join('\n');

    const chunks = splitStatements(source);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.text).toContain('CREATE TABLE a');
    expect(chunks[1]?.text).toContain('$body$');
    expect(chunks[2]?.text).toBe('CREATE TABLE b (y int)');
  });

  it('drops chunks that hold only whitespace and comments', () => {
    expect(splitStatements('  \n-- nothing here\n/* nor here */\n')).toEqual([]);
  });
});

describe('determinism and the round trip', () => {
  it('produces an identical model and report on a second run', async () => {
    const first = await importDdl(ECOMMERCE_DDL);
    const second = await importDdl(ECOMMERCE_DDL);
    expect(second.model).toEqual(first.model);
    expect(second.report).toEqual(first.report);
  });

  it('reaches a fixed point after one DDL -> IR -> DDL trip', async () => {
    const first = await importDdl(ECOMMERCE_DDL);
    const once = renderStatements(await EXPORTER.export(exportInput(first)));

    const second = await importDdl(once, 're');
    // Everything the exporter wrote is something the importer reads back: no statement of
    // its own output defeats it.
    expect(second.report.countsByStatus.applied).toBe(second.report.statementCount);

    const twice = renderStatements(await EXPORTER.export(exportInput(second)));
    expect(twice).toBe(once);
    expect(second.report.objectCounts).toEqual(first.report.objectCounts);
  });
});

function exportInput(result: ImportResult): Parameters<typeof EXPORTER.export>[0] {
  return {
    model: fullyVisible(result.model),
    options: {
      format: 'ddl',
      includeComments: true,
      includeDrops: false,
      includeIfNotExists: false,
      engineOptions: {},
    },
    context: { projectId: 'p1', serverVersion: '16' },
  };
}
