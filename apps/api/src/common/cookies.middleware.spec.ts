import { describe, expect, it } from 'vitest';
import { parseCookieHeader } from './cookies.middleware';

describe('parseCookieHeader', () => {
  it('returns an empty object for a missing header', () => {
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader('')).toEqual({});
  });

  it('parses the SchemaLoom cookie set', () => {
    expect(parseCookieHeader('sl_access=abc; sl_refresh=def; sl_csrf=ghi')).toEqual({
      sl_access: 'abc',
      sl_refresh: 'def',
      sl_csrf: 'ghi',
    });
  });

  it('decodes percent-escapes and strips quotes', () => {
    expect(parseCookieHeader('a=%20x%2Fy; b="quoted"')).toEqual({ a: ' x/y', b: 'quoted' });
  });

  it('keeps the first occurrence of a duplicated name', () => {
    expect(parseCookieHeader('sl_csrf=real; sl_csrf=spoofed').sl_csrf).toBe('real');
  });

  it('survives malformed input rather than throwing', () => {
    expect(parseCookieHeader('=novalue; noequals; a=%E0%A4%A')).toEqual({ a: '%E0%A4%A' });
  });

  it('keeps an empty value', () => {
    expect(parseCookieHeader('sl_access=')).toEqual({ sl_access: '' });
  });
});
