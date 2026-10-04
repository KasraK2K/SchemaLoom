import { describe, expect, it } from 'vitest';
import { sameViewBody } from './view-body.js';

// Each `printed` is what pg_dump wrote for `written` (PostgreSQL 16).
const PAIRS: readonly (readonly [written: string, printed: string])[] = [
  [
    'select id, total from orders where total > 100',
    'SELECT id,\n    total\n   FROM public.orders\n  WHERE (total > (100)::numeric);',
  ],
  [
    "select o.id, c.name from orders o join customers c on c.id = o.customer_id where o.status = 'paid'",
    "SELECT o.id,\n    c.name\n   FROM (public.orders o\n     JOIN public.customers c ON ((c.id = o.customer_id)))\n  WHERE ((o.status)::text = 'paid'::text);",
  ],
  [
    "select id from orders where status in ('a','b') order by id",
    "SELECT id\n   FROM public.orders\n  WHERE ((status)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[]))\n  ORDER BY id;",
  ],
  [
    'select count(*) as n, upper(note) from orders group by note having count(*) > 1',
    'SELECT count(*) AS n,\n    upper(note) AS upper\n   FROM public.orders\n  GROUP BY note\n HAVING (count(*) > 1);',
  ],
  // Older servers qualify the columns of a single-table view.
  ['select id from orders', 'SELECT orders.id\n   FROM public.orders;'],
];

describe('sameViewBody', () => {
  it.each(PAIRS)('%s', async (written, printed) => {
    expect(await sameViewBody(written, printed)).toBe(true);
  });

  it('still tells real changes apart', async () => {
    expect(await sameViewBody('select id from orders', 'select id from customers')).toBe(false);
    expect(await sameViewBody('select id from orders', 'select id, total from orders')).toBe(false);
    expect(
      await sameViewBody(
        'select id from orders where total > 100',
        'select id from orders where total > 200',
      ),
    ).toBe(false);
    expect(await sameViewBody('select id from orders', 'select id from billing.orders')).toBe(
      false,
    );
    expect(
      await sameViewBody('select cast(total as int) from orders', 'select total from orders'),
    ).toBe(false);
    expect(
      await sameViewBody(
        "select id from orders where status in ('a')",
        "select id from orders where status not in ('a')",
      ),
    ).toBe(false);
  });

  it('matches a join written without qualifiers, given the columns of each table', async () => {
    const columns = (t: string) =>
      ({ orders: ['id', 'total', 'customer_id'], customers: ['id', 'name'] })[t];
    const written = 'select total, name from orders o join customers c on c.id = customer_id';
    const printed =
      'SELECT o.total,\n    c.name\n   FROM (public.orders o\n     JOIN public.customers c ON ((c.id = o.customer_id)));';
    expect(await sameViewBody(written, printed, columns)).toBe(true);
    // Without the columns, or when a table is unknown, nothing is guessed.
    expect(await sameViewBody(written, printed)).toBe(false);
    expect(
      await sameViewBody(written, printed, (t) => (t === 'orders' ? ['total'] : undefined)),
    ).toBe(false);
    // The qualifier still matters.
    expect(
      await sameViewBody(
        'select c.name from orders o join customers c on c.id = o.customer_id',
        'SELECT o.name FROM (public.orders o JOIN public.customers c ON ((c.id = o.customer_id)));',
        columns,
      ),
    ).toBe(false);
  });

  it('is false when a side does not parse', async () => {
    expect(await sameViewBody('select id from orders', 'select id from')).toBe(false);
  });
});
