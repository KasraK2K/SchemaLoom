import { describe, expect, it } from 'vitest';
import {
  ANA,
  ANALYSTS,
  BILLING,
  PROJECT,
  RESOURCES,
  anaEditorOnProject,
  customRole,
  entry,
  grant,
  role,
} from './access-fixture';
import { isInertGrant, previewGrant, toggleState } from './grant-warnings';

describe('previewGrant — the narrowing warning (§7.7)', () => {
  it('warns when a project Editor is given Viewer on an area', () => {
    const warnings = previewGrant(anaEditorOnProject(), RESOURCES, {
      target: BILLING,
      role: role('viewer'),
      canUseAi: false,
      canViewRestricted: false,
    });

    expect(warnings).toHaveLength(1);
    const [warning] = warnings;
    expect(warning?.code).toBe('narrows');
    // The sentence has to name the person, both roles, the area and the consequence —
    // "she is now read-only there" is the part nobody predicts.
    expect(warning?.message).toContain('Ana');
    expect(warning?.message).toContain('Editor');
    expect(warning?.message).toContain('Viewer');
    expect(warning?.message).toContain('Billing');
    expect(warning?.message).toContain('read-only');
    expect(warning?.code === 'narrows' ? warning.lost : []).toContain('schema:edit');
  });

  it('does NOT warn for a widening grant', () => {
    const ana = entry(ANA, [grant(ANA, PROJECT, 'viewer')]);
    expect(
      previewGrant(ana, RESOURCES, {
        target: BILLING,
        role: role('editor'),
        canUseAi: false,
        canViewRestricted: false,
      }),
    ).toEqual([]);
  });

  it('does NOT warn when the person has no access to lose', () => {
    expect(
      previewGrant(entry(ANA, []), RESOURCES, {
        target: BILLING,
        role: role('viewer'),
        canUseAi: false,
        canViewRestricted: false,
      }),
    ).toEqual([]);
  });

  it('does NOT warn when a toggle is added on top of the same role — toggles only add', () => {
    const ana = entry(ANA, [grant(ANA, BILLING, 'editor')]);
    expect(
      previewGrant(ana, RESOURCES, {
        target: BILLING,
        role: role('editor'),
        canUseAi: true,
        canViewRestricted: false,
      }),
    ).toEqual([]);
  });

  it('warns when turning a toggle OFF on an existing grant takes an atom away', () => {
    const ana = entry(ANA, [grant(ANA, BILLING, 'editor', { canUseAi: true })]);
    const warnings = previewGrant(ana, RESOURCES, {
      target: BILLING,
      role: role('editor'),
      canUseAi: false,
      canViewRestricted: false,
    });
    expect(warnings[0]?.code).toBe('narrows');
    expect(warnings[0]?.message).toContain('AI');
  });

  it('reports a grant that changes nothing rather than pretending it did something', () => {
    const ana = entry(ANA, [grant(ANA, PROJECT, 'editor')]);
    const warnings = previewGrant(ana, RESOURCES, {
      target: BILLING,
      role: role('editor'),
      canUseAi: false,
      canViewRestricted: false,
    });
    expect(warnings[0]?.code).toBe('no_effect');
  });

  it('says the grant is defeated, not that it narrowed, when a group keeps the wider role', () => {
    // E3: a narrowing grant narrows only the principal it hangs off. Ana's own set at
    // Billing does not drop, because the group grant is a different principal — so this
    // is §7.7's *defeated* grant, and the dialog must name the group rather than either
    // claiming a narrowing that did not happen or saying nothing at all.
    const ana = entry(ANA, [grant(ANALYSTS, PROJECT, 'editor')]);
    const warnings = previewGrant(ana, RESOURCES, {
      target: BILLING,
      role: role('viewer'),
      canUseAi: false,
      canViewRestricted: false,
    });
    expect(warnings).toHaveLength(1);
    const [warning] = warnings;
    expect(warning?.code).toBe('no_effect');
    expect(warning?.message).toContain('still an Editor');
    expect(warning?.message).toContain('the group Analysts');
    expect(warning?.code === 'no_effect' ? warning.via : []).toEqual(['the group Analysts']);
  });
});

describe('inert grants — R13', () => {
  it('flags an org owner, not an org admin (admins see only granted projects)', () => {
    expect(isInertGrant(entry(ANA, [], { orgRole: 'owner' }))).toBe(true);
    expect(isInertGrant(entry(ANA, [], { orgRole: 'admin' }))).toBe(false);
    expect(isInertGrant(entry(ANA, [], { orgRole: 'member' }))).toBe(false);
  });

  it('short-circuits the preview with a plain "no effect"', () => {
    const warnings = previewGrant(entry(ANA, [], { orgRole: 'owner' }), RESOURCES, {
      target: BILLING,
      role: role('viewer'),
      canUseAi: false,
      canViewRestricted: false,
    });
    expect(warnings[0]?.code).toBe('org_admin_inert');
    expect(warnings[0]?.message).toContain('no effect');
  });
});

describe('toggleState — additive only', () => {
  it('leaves a toggle free when the role does not carry the atom', () => {
    expect(toggleState(role('editor'), 'ai:use', false)).toEqual({
      checked: false,
      disabled: false,
      note: null,
    });
  });

  it('renders a role-implied toggle checked and disabled with the reason', () => {
    const analyst = customRole('Analyst', ['schema:view', 'ai:use']);
    expect(toggleState(analyst, 'ai:use', false)).toEqual({
      checked: true,
      disabled: true,
      note: 'always included in Analyst',
    });
  });

  it('does the same for restricted fields', () => {
    const auditor = customRole('Auditor', ['schema:view', 'field:viewRestricted']);
    const state = toggleState(auditor, 'field:viewRestricted', false);
    expect(state.checked).toBe(true);
    expect(state.disabled).toBe(true);
  });

  it('no built-in role implies either toggle', () => {
    for (const option of ['viewer', 'commenter', 'documenter', 'editor', 'manager']) {
      expect(toggleState(role(option), 'ai:use', false).disabled).toBe(false);
      expect(toggleState(role(option), 'field:viewRestricted', false).disabled).toBe(false);
    }
  });
});
