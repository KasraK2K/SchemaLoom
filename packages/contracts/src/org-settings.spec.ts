import { describe, expect, it } from 'vitest';
import { applyOrgSettingsPatch, orgSettingsPatchSchema, readOrgSettings } from './org-settings.js';

const GRAPHITE = { theme: 'blueprint', variant: 'graphite', mode: 'system' } as const;

describe('org settings (docs/phase17/ORG-DEFAULT.md)', () => {
  it('a partial patch keeps the keys it does not send', () => {
    const stored = { allowGuestInvites: false, defaultAppearance: null };
    expect(applyOrgSettingsPatch(stored, { defaultAppearance: GRAPHITE })).toEqual({
      allowGuestInvites: false,
      defaultAppearance: GRAPHITE,
    });
    expect(
      applyOrgSettingsPatch({ defaultAppearance: GRAPHITE }, { allowGuestInvites: false }),
    ).toEqual({
      allowGuestInvites: false,
      defaultAppearance: GRAPHITE,
    });
  });

  it('null clears the default; an empty row reads as the defaults', () => {
    expect(
      applyOrgSettingsPatch({ defaultAppearance: GRAPHITE }, { defaultAppearance: null }),
    ).toEqual({
      allowGuestInvites: true,
      defaultAppearance: null,
    });
    expect(readOrgSettings(null)).toEqual({ allowGuestInvites: true, defaultAppearance: null });
  });

  it('a variant that belongs to another theme is refused', () => {
    const bad = { defaultAppearance: { theme: 'blueprint', variant: 'jade', mode: 'dark' } };
    expect(orgSettingsPatchSchema.safeParse(bad).success).toBe(false);
    expect(() => applyOrgSettingsPatch({}, bad as never)).toThrow();
  });

  it('a typo in a patch is refused, and a corrupt stored default reads as none', () => {
    expect(orgSettingsPatchSchema.safeParse({ allowGuestInvite: false }).success).toBe(false);
    expect(
      readOrgSettings({ defaultAppearance: { theme: 'nope' }, allowGuestInvites: 'x' }),
    ).toEqual({
      allowGuestInvites: true,
      defaultAppearance: null,
    });
  });
});
