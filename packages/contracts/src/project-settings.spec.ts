import { describe, expect, it } from 'vitest';
import { applyProjectSettingsPatch, projectSettingsPatchSchema } from './project-settings.js';

describe('project settings (doc 02 §7)', () => {
  it('a patch changes only the keys it sends', () => {
    const stored = { ai: { enabled: true, includeDocsInContext: false } };
    expect(applyProjectSettingsPatch(stored, { ai: { enabled: false } })).toEqual({
      ai: { enabled: false, includeDocsInContext: false },
    });
  });

  it('an empty or unreadable row reads as the defaults, and stale keys are stripped', () => {
    expect(applyProjectSettingsPatch({}, {})).toEqual({
      ai: { enabled: true, includeDocsInContext: true },
    });
    expect(applyProjectSettingsPatch({ ai: 'junk' }, {})).toEqual({
      ai: { enabled: true, includeDocsInContext: true },
    });
    expect(applyProjectSettingsPatch({ gridSize: 8 }, {})).toEqual({
      ai: { enabled: true, includeDocsInContext: true },
    });
  });

  it('a typo in a patch is refused, not ignored', () => {
    expect(projectSettingsPatchSchema.safeParse({ ai: { enabeld: false } }).success).toBe(false);
    expect(projectSettingsPatchSchema.safeParse({ restrictedFieldMode: 'hide' }).success).toBe(
      false,
    );
  });
});
