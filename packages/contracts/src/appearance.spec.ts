import { describe, expect, it } from 'vitest';
import { DEFAULT_APPEARANCE, appearanceInputSchema, readAppearance } from './appearance.js';

describe('appearance', () => {
  it('accepts a theme with one of its own variants', () => {
    expect(
      appearanceInputSchema.safeParse({ theme: 'blueprint', variant: 'olive', mode: 'dark' })
        .success,
    ).toBe(true);
  });

  it("refuses another theme's variant, and unknown keys", () => {
    expect(
      appearanceInputSchema.safeParse({ theme: 'blueprint', variant: 'jade', mode: 'dark' })
        .success,
    ).toBe(false);
    expect(
      appearanceInputSchema.safeParse({ theme: 'studio', variant: 'jade', mode: 'dark', x: 1 })
        .success,
    ).toBe(false);
  });

  it('reads anything unrecognisable back as the default', () => {
    expect(readAppearance({})).toEqual(DEFAULT_APPEARANCE);
    expect(readAppearance({ theme: 'neon', variant: 'x', mode: 'dark' })).toEqual(
      DEFAULT_APPEARANCE,
    );
  });
});
