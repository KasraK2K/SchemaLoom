import { describe, expect, it } from 'vitest';
import { sameViewBody } from './view-body.js';

// Each pair is what MySQL 8.4 and MariaDB 11.4 `SHOW CREATE VIEW` wrote for the first body.
const PAIRS: readonly (readonly string[])[] = [
  [
    'select id, total from orders where total > 100',
    'select `orders`.`id` AS `id`,`orders`.`total` AS `total` from `orders` where (`orders`.`total` > 100)',
    'select `orders`.`id` AS `id`,`orders`.`total` AS `total` from `orders` where `orders`.`total` > 100',
  ],
  [
    "select o.id, c.name from orders o join customers c on c.id = o.customer_id where o.status = 'paid'",
    "select `o`.`id` AS `id`,`c`.`name` AS `name` from (`orders` `o` join `customers` `c` on((`c`.`id` = `o`.`customer_id`))) where (`o`.`status` = 'paid')",
    "select `o`.`id` AS `id`,`c`.`name` AS `name` from (`orders` `o` join `customers` `c` on(`c`.`id` = `o`.`customer_id`)) where `o`.`status` = 'paid'",
  ],
  [
    "select id, cast(total as signed) as t, ((total * 2)) as dbl from orders where (status in ('a','b')) order by id",
    "select `orders`.`id` AS `id`,cast(`orders`.`total` as signed) AS `t`,(`orders`.`total` * 2) AS `dbl` from `orders` where (`orders`.`status` in ('a','b')) order by `orders`.`id`",
    "select `orders`.`id` AS `id`,cast(`orders`.`total` as signed) AS `t`,`orders`.`total` * 2 AS `dbl` from `orders` where `orders`.`status` in ('a','b') order by `orders`.`id`",
  ],
  [
    'select count(*) as n, upper(note) from orders group by note having count(*) > 1',
    'select count(0) AS `n`,upper(`orders`.`note`) AS `upper(note)` from `orders` group by `orders`.`note` having (count(0) > 1)',
    'select count(0) AS `n`,ucase(`orders`.`note`) AS `upper(note)` from `orders` group by `orders`.`note` having count(0) > 1',
  ],
];

describe('sameViewBody', () => {
  it.each(PAIRS)('%s', async (written, ...printed) => {
    for (const body of printed) expect(await sameViewBody(written, body)).toBe(true);
  });

  it('still tells real changes apart', async () => {
    const differ = [
      ['select id from orders', 'select id from customers'],
      ['select id from orders', 'select id, total from orders'],
      ['select id from orders where total > 100', 'select id from orders where total > 200'],
      ['select id as a from orders', 'select id as b from orders'],
      ['select cast(total as signed) from orders', 'select total from orders'],
      ['select count(*) from orders', 'select count(1) from orders'],
    ];
    for (const [a, b] of differ) expect(await sameViewBody(a ?? '', b ?? '')).toBe(false);
  });

  it('is false when a side does not parse', async () => {
    expect(await sameViewBody('select id from orders', 'select id from')).toBe(false);
  });
});
