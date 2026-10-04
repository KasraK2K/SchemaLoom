import { describe, expect, it } from 'vitest';
import { detectImportFormat } from './create-project';

describe('detectImportFormat (Phase 7b)', () => {
  const both = [{ id: 'ddl' }, { id: 'prisma' }];

  it('reads a Prisma schema as one', () => {
    expect(detectImportFormat('datasource db {\n  provider = "postgresql"\n}', both)).toBe(
      'prisma',
    );
    expect(detectImportFormat('// users\nmodel User {\n  id Int @id\n}', both)).toBe('prisma');
  });

  it('leaves SQL, and engines without the format, to the default', () => {
    expect(detectImportFormat('CREATE TABLE model (id int);', both)).toBeUndefined();
    expect(
      detectImportFormat('-- model User {\nCREATE TABLE users (id int);', both),
    ).toBeUndefined();
    expect(detectImportFormat('model User {\n  id Int @id\n}', [{ id: 'ddl' }])).toBeUndefined();
  });
});
