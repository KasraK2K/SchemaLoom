import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_ROLES,
  BUILT_IN_ROLE_ORDER,
  BUILTIN_ROLE_IDS,
  type PermissionAtom,
} from '@schemaloom/contracts';

/**
 * Migration `0003_builtin_roles` seeds five rows that `access_grants.role_id`
 * points at with a real foreign key. `packages/contracts` declares the same ids
 * and the same atom sets in TypeScript. Nothing in PostgreSQL enforces that the
 * two agree.
 *
 * They drifted once already: the ids were "tidied" to a uniform 25 characters in
 * contracts while the migration kept the original mixed lengths, which would
 * have made every `findUnique({ id: BUILTIN_ROLE_IDS.commenter })` in the
 * resolver return null — a permission bug that reads as "this user has no
 * access" and is invisible until someone is wrongly denied.
 *
 * This parses the SQL and asserts the agreement, so the next edit to either side
 * fails here instead of in production.
 */
const MIGRATION = resolve(
  __dirname,
  '../../prisma/migrations/0003_builtin_roles/migration.sql',
);

interface SeededRole {
  id: string;
  key: string;
  atoms: string[];
}

function parseSeededRoles(): SeededRole[] {
  const sql = readFileSync(MIGRATION, 'utf8');
  // Each tuple: ('<id>', NULL, '<key>', '<Name>', ARRAY[...], true, false, now(), now())
  const rowRe =
    /\(\s*'([^']+)'\s*,\s*NULL\s*,\s*'([^']+)'\s*,\s*'[^']*'\s*,\s*ARRAY\[([\s\S]*?)\]/g;
  const rows: SeededRole[] = [];
  for (let m = rowRe.exec(sql); m !== null; m = rowRe.exec(sql)) {
    const atoms = [...m[3]!.matchAll(/'([^']+)'/g)].map((a) => a[1]!);
    rows.push({ id: m[1]!, key: m[2]!, atoms });
  }
  return rows;
}

describe('0003_builtin_roles agrees with @schemaloom/contracts', () => {
  const seeded = parseSeededRoles();

  it('parsed all five roles out of the migration', () => {
    expect(seeded).toHaveLength(5);
    expect(seeded.map((r) => r.key).sort()).toEqual([...BUILT_IN_ROLE_ORDER].sort());
  });

  it.each([...BUILT_IN_ROLE_ORDER])('%s: id matches BUILTIN_ROLE_IDS', (role) => {
    const row = seeded.find((r) => r.key === role);
    expect(row, `no seeded row for ${role}`).toBeDefined();
    expect(row!.id).toBe(BUILTIN_ROLE_IDS[role]);
  });

  it.each([...BUILT_IN_ROLE_ORDER])('%s: atoms match BUILT_IN_ROLES', (role) => {
    const row = seeded.find((r) => r.key === role)!;
    const expected = BUILT_IN_ROLES[role];
    expect(new Set(row.atoms as PermissionAtom[])).toEqual(expected);
  });

  it('every seeded id is distinct', () => {
    const ids = seeded.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the seed is re-runnable', () => {
    expect(readFileSync(MIGRATION, 'utf8')).toMatch(/ON CONFLICT \(id\) DO NOTHING/i);
  });
});
