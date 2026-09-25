import { describe, expect, it } from 'vitest';
import { NAMEDATALEN_BYTES, normalizeName, truncateToBytes, utf8ByteLength } from './normalize-name.js';

describe('normalizeName — case folding', () => {
  it('folds an unquoted identifier to lower case', () => {
    expect(normalizeName('Orders')).toBe('orders');
    expect(normalizeName('ORDER_ITEMS')).toBe('order_items');
  });

  it('makes Orders and orders the same object — the whole reason core takes this function', () => {
    expect(normalizeName('Orders')).toBe(normalizeName('orders'));
  });

  it('is idempotent', () => {
    for (const name of ['Orders', 'É'.repeat(40), 'a'.repeat(100), '']) {
      expect(normalizeName(normalizeName(name))).toBe(normalizeName(name));
    }
  });
});

describe('normalizeName — NAMEDATALEN truncation', () => {
  it('leaves a name at the limit alone', () => {
    const name = 'a'.repeat(NAMEDATALEN_BYTES);
    expect(normalizeName(name)).toBe(name);
  });

  it('truncates an over-long ASCII name to 63 characters', () => {
    const result = normalizeName('b'.repeat(200));
    expect(result).toHaveLength(63);
    expect(utf8ByteLength(result)).toBe(63);
  });

  it('counts BYTES, not characters: 32 two-byte letters overflow 63 bytes', () => {
    // 'é' is two bytes in UTF-8, so 32 of them are 64 bytes — one over the limit.
    const name = 'é'.repeat(32);
    expect(utf8ByteLength(name)).toBe(64);

    const result = normalizeName(name);
    expect(result).toHaveLength(31);
    expect(utf8ByteLength(result)).toBe(62);
  });

  it('never splits a multi-byte character', () => {
    // 60 ASCII + one 4-byte emoji = 64 bytes; the emoji goes whole or not at all.
    const result = normalizeName(`${'a'.repeat(60)}\u{1F600}`);
    expect(result).toBe('a'.repeat(60));
    expect(utf8ByteLength(result)).toBe(60);
    expect(result).not.toContain('�');
  });

  it('keeps a multi-byte character that still fits exactly', () => {
    const result = normalizeName(`${'a'.repeat(59)}\u{1F600}`);
    expect(utf8ByteLength(result)).toBe(63);
    expect(result.endsWith('\u{1F600}')).toBe(true);
  });

  it('folds BEFORE it clips, so the OUTPUT is what is under 63 bytes', () => {
    // 'İ' (U+0130) lower-cases to two code points, three bytes — folding can GROW a name.
    const result = normalizeName('İ'.repeat(40));
    expect(utf8ByteLength(result)).toBeLessThanOrEqual(NAMEDATALEN_BYTES);
  });
});

describe('utf8ByteLength / truncateToBytes', () => {
  it('measures UTF-8 widths', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('€')).toBe(3);
    expect(utf8ByteLength('\u{1F600}')).toBe(4);
  });

  it('clips on a code-point boundary', () => {
    expect(truncateToBytes('a€b', 3)).toBe('a');
    expect(truncateToBytes('a€b', 4)).toBe('a€');
    expect(truncateToBytes('a€b', 99)).toBe('a€b');
  });
});
