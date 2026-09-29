import { describe, expect, it } from 'vitest';
import { afterFirstFactor, safeNextPath } from './auth-api';

/**
 * `?next=` is attacker-controlled: it is read straight off the URL of a page anyone can
 * link to. An unvalidated redirect there is a good phishing primitive precisely because
 * the victim really did just authenticate on the real site before being sent away.
 */
describe('safeNextPath', () => {
  it('keeps an ordinary in-app path', () => {
    expect(safeNextPath('/acme/p/prj_1')).toBe('/acme/p/prj_1');
    expect(safeNextPath('/acme/p/prj_1?tab=docs')).toBe('/acme/p/prj_1?tab=docs');
  });

  it('falls back when there is nothing to honour', () => {
    expect(safeNextPath(null)).toBe('/');
    expect(safeNextPath(undefined)).toBe('/');
    expect(safeNextPath('')).toBe('/');
  });

  it.each([
    ['absolute http', 'http://evil.test/steal'],
    ['absolute https', 'https://evil.test/steal'],
    ['protocol-relative', '//evil.test/steal'],
    ['backslash-relative', '/\\evil.test/steal'],
    ['scheme-relative with creds', 'https://user@evil.test'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['bare host', 'evil.test'],
  ])('refuses an off-origin target: %s', (_label, attack) => {
    expect(safeNextPath(attack)).toBe('/');
  });

  it('honours an explicit fallback', () => {
    expect(safeNextPath('https://evil.test', '/dashboard')).toBe('/dashboard');
  });
});

describe('afterFirstFactor', () => {
  it('sends a 2FA login to the code prompt, carrying a SAFE next', () => {
    expect(afterFirstFactor({ mfaRequired: true }, '/acme')).toBe('/two-factor?next=%2Facme');
    expect(afterFirstFactor({ mfaRequired: true }, 'https://evil.test')).toBe(
      '/two-factor?next=%2F',
    );
  });
});
