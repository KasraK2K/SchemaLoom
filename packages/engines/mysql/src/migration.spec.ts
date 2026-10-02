import { renderMigrationScript } from '@schemaloom/engine-sdk';
import { diffModels } from '@schemaloom/schema-model';
import { describe, expect, it } from 'vitest';
import { annotateDiff } from './annotate.js';
import { CONFORMANCE_FIXTURES } from './conformance-fixtures.js';
import { MIGRATION_GENERATOR } from './migration.js';

async function script(
  name: string,
  allowDestructive = false,
): Promise<{ sql: string; unsupported: number; transaction: unknown }> {
  const pair = CONFORMANCE_FIXTURES.migrations.find((m) => m.name === name);
  if (pair === undefined) throw new Error(`no fixture ${name}`);
  const plan = await MIGRATION_GENERATOR.generate({
    diff: annotateDiff(diffModels(pair.before, pair.after)),
    before: pair.before,
    after: pair.after,
    options: { allowDestructive, transactional: true, engineOptions: {} },
    context: { projectId: 'p1', serverVersion: 'MySQL 8.4' },
  });
  return {
    sql: renderMigrationScript(plan, { separator: ';', lineComment: '--' }),
    unsupported: plan.unsupported.length,
    transaction: plan.transaction,
  };
}

describe('MySQL migrations', () => {
  it('adds a column in place and indexes it, and says the script is not transactional', async () => {
    const { sql, unsupported, transaction } = await script('add a column and an index');
    expect(unsupported).toBe(0);
    expect(transaction).toBeNull();
    expect(sql).toBe(
      [
        '-- MySQL commits each schema change as it runs; this script cannot be rolled back as a whole.',
        'ALTER TABLE `customers` ADD COLUMN `nickname` varchar(64) NULL AFTER `updated_at`;',
        'CREATE INDEX `idx_nickname` ON `customers` (`nickname`);',
      ].join('\n'),
    );
  });

  it('comments out a dropped column unless destructive steps are allowed', async () => {
    expect((await script('drop a column')).sql).toContain(
      '-- ALTER TABLE `customers` DROP COLUMN `updated_at`;',
    );
    expect((await script('drop a column', true)).sql).toMatch(
      /^ALTER TABLE `customers` DROP COLUMN `updated_at`;$/m,
    );
  });

  it('restates the whole column for a change, as MySQL requires', async () => {
    const { sql } = await script('narrow a varchar and require a value');
    expect(sql).toContain('ALTER TABLE `customers` MODIFY COLUMN `email` varchar(64) NOT NULL;');
    expect(sql).toContain('ALTER TABLE `customers` MODIFY COLUMN `bio` text NOT NULL;');
  });

  it('renames before anything else, so later steps use the new names', async () => {
    const { sql } = await script('rename a table, a column and an index');
    expect(sql.split('\n').slice(1)).toEqual([
      'RENAME TABLE `customers` TO `clients`;',
      'ALTER TABLE `clients` RENAME COLUMN `email` TO `email_address`;',
      'ALTER TABLE `clients` RENAME INDEX `idx_email_prefix` TO `idx_email_address_prefix`;',
    ]);
  });
});
