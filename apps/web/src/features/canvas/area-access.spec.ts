import { describe, expect, it } from 'vitest';
import type { AccessList } from '@/features/sharing/model';
import { accessLines, sharedWith } from './area-access';
import { AREA_BILLING, AREA_CRM, fixtureModel } from './model-fixture';

const model = fixtureModel();

const principal = (id: string) => ({ kind: 'user' as const, id, label: id });
const grant = (id: string, areaId: string, resourceType: 'area' | 'project' = 'area') => ({
  id: `g_${id}_${areaId}`,
  principal: principal(id),
  resourceType,
  resourceId: areaId,
  resourceName: areaId,
  roleKey: 'viewer',
  roleName: 'Viewer',
  atoms: [],
  canUseAi: false,
  canViewRestricted: false,
  expiresAt: null,
});
const entry = (id: string, ...grants: ReturnType<typeof grant>[]) => ({
  principal: principal(id),
  orgRole: null,
  email: null,
  grants,
});

const access = (canManage: boolean): AccessList => ({
  canManage,
  resources: [],
  roles: [],
  entries: [
    entry('ana', grant('ana', AREA_BILLING)),
    entry('bo', grant('bo', AREA_BILLING)),
    entry('cy', grant('cy', AREA_BILLING)),
    // a project-wide grant is not what a card changes
    entry('di', grant('di', 'p1', 'project')),
  ],
});

describe('who an area is shared with', () => {
  it('counts the principals holding a grant on the area itself', () => {
    expect(sharedWith(access(true), AREA_BILLING)).toBe(3);
    expect(sharedWith(access(true), AREA_CRM)).toBe(0);
  });
});

describe('accessLines', () => {
  it('says who will see a table that joins a shared area', () => {
    const lines = accessLines(access(true), model, {
      tables: ['invoices'],
      from: new Set(),
      to: AREA_BILLING,
    });
    expect(lines).toEqual(['Billing is shared with 3 people. They will see `invoices` too.']);
  });

  it('says who may lose a table that leaves a shared area', () => {
    const lines = accessLines(access(true), model, {
      tables: ['invoices', 'payments', 'refunds'],
      from: new Set([AREA_BILLING]),
      to: null,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Billing is shared with 3 people');
    expect(lines[0]).toContain('`invoices`, `payments` and 1 more');
    expect(lines[0]).toContain('no longer see');
  });

  it('says both when a table moves between two shared areas', () => {
    const both = access(true);
    both.entries.push(entry('ed', grant('ed', AREA_CRM)));
    const lines = accessLines(both, model, {
      tables: ['invoices'],
      from: new Set([AREA_BILLING]),
      to: AREA_CRM,
    });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('CRM is shared with 1 person.');
  });

  it('says nothing for a move inside one area, or between areas nobody was given', () => {
    const same = { tables: ['x'], from: new Set([AREA_BILLING]), to: AREA_BILLING };
    expect(accessLines(access(true), model, same)).toEqual([]);
    const none = { tables: ['x'], from: new Set([AREA_CRM]), to: null };
    expect(accessLines(access(true), model, none)).toEqual([]);
  });

  it('warns that ungrouping removes the sharing', () => {
    const lines = accessLines(access(true), model, {
      tables: ['invoices'],
      from: new Set([AREA_BILLING]),
      to: null,
      ungroup: true,
    });
    expect(lines).toEqual(['Billing is shared with 3 people. Ungrouping removes that sharing.']);
  });

  it('says nothing to someone who cannot see the grants', () => {
    expect(
      accessLines(access(false), model, { tables: ['x'], from: new Set(), to: AREA_BILLING }),
    ).toEqual([]);
  });
});
