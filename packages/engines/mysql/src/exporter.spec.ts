import { renderStatements } from '@schemaloom/engine-sdk';
import { describe, expect, it } from 'vitest';
import { ECOMMERCE_DDL } from './conformance-ddl.js';
import { redactedModel } from './conformance-fixtures.js';
import { EXPORTER } from './exporter.js';
import { fullyVisible } from './fixture-model.js';
import { IMPORTER } from './importer.js';

const options = {
  format: 'ddl',
  includeComments: true,
  includeDrops: false,
  includeIfNotExists: false,
  engineOptions: {},
};
const context = { projectId: 'p1', serverVersion: 'MySQL 8.4' };

async function imported() {
  let n = 0;
  const { model } = await IMPORTER.import(
    ECOMMERCE_DDL,
    { format: 'ddl', defaultNamespace: null, caseFolding: 'preserve', engineOptions: {} },
    { ...context, newId: () => `id${String((n += 1)).padStart(4, '0')}` },
  );
  return model;
}

describe('MySQL export', () => {
  it('writes tables in SHOW CREATE TABLE form, then foreign keys, then the view', async () => {
    const result = await EXPORTER.export({
      model: fullyVisible(await imported()),
      options,
      context,
    });
    expect(result.statements.map((s) => s.kind)).toEqual([
      'CREATE TABLE',
      'CREATE TABLE',
      'CREATE VIEW',
      'ALTER TABLE',
    ]);
    const sql = renderStatements(result);
    expect(sql).toContain('`id` bigint unsigned NOT NULL AUTO_INCREMENT');
    expect(sql).toContain("`status` enum('active','suspended','closed') NOT NULL DEFAULT 'active'");
    expect(sql).toContain(
      '`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
    );
    expect(sql).toContain('KEY `idx_name_prefix` (`full_name`(20))');
    expect(sql).toContain('FULLTEXT KEY `ft_name` (`full_name`)');
    expect(sql).toContain(') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
    expect(sql).toContain(
      'ALTER TABLE `orders` ADD CONSTRAINT `fk_orders_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE',
    );
    expect(sql).toMatch(
      /CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `big_orders` AS select/,
    );
  });

  it('comments each documented object in its own statement, and says when it left things out', async () => {
    const result = await EXPORTER.export({ model: redactedModel(), options, context });
    const sql = renderStatements(result);
    expect(result.incomplete).toBe(true);
    expect(result.statements[0]?.text).toBe(
      '-- Some objects are not included because of your access level.',
    );
    expect(sql).toContain(
      "ALTER TABLE `orders` COMMENT = 'Every customer''s orders, one row per order'",
    );
    // `orders` has a restricted column, so redaction blanked its columns' props (R27).
    expect(sql).toContain(
      "MODIFY COLUMN `customer_id` bigint NOT NULL COMMENT 'Who placed the order'",
    );
    // The stub, the masked column and everything naming them are gone, by name.
    expect(sql).not.toContain('customers');
    expect(sql).not.toMatch(/`total`/);
    expect(result.diagnostics).toEqual([]);
  });
});
