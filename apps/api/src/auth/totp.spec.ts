import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  hashRecoveryCode,
  hotp,
  otpauthUri,
  totpStep,
  verifyTotp,
} from './totp';

const RFC_KEY = Buffer.from('12345678901234567890');
const KEY = Buffer.alloc(32, 7).toString('base64');

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 test vectors', () => {
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [time, code] of vectors) expect(hotp(RFC_KEY, totpStep(time * 1000), 8)).toBe(code);
  });

  it('accepts ±1 step and returns the matched step, refuses anything further', () => {
    const now = 1111111111_000;
    const step = totpStep(now);
    expect(verifyTotp(RFC_KEY, hotp(RFC_KEY, step), now)).toBe(step);
    expect(verifyTotp(RFC_KEY, hotp(RFC_KEY, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(RFC_KEY, hotp(RFC_KEY, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(RFC_KEY, hotp(RFC_KEY, step - 2), now)).toBeNull();
    expect(verifyTotp(RFC_KEY, 'abcdef', now)).toBeNull();
  });

  it('round-trips base32 (RFC 4648 vector) and builds an otpauth URI', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    expect(otpauthUri('a@example.com', RFC_KEY)).toBe(
      `otpauth://totp/SchemaLoom%3Aa%40example.com?secret=${base32Encode(RFC_KEY)}&issuer=SchemaLoom&algorithm=SHA1&digits=6&period=30`,
    );
  });
});

describe('secret encryption', () => {
  it('round-trips, and a tampered ciphertext fails instead of decrypting to garbage', () => {
    const stored = encryptSecret(RFC_KEY, KEY);
    expect(stored).not.toContain(RFC_KEY.toString('base64url'));
    expect(decryptSecret(stored, KEY)).toEqual(RFC_KEY);
    const [iv, tag, ct] = stored.split('.');
    const flipped = `${iv!}.${tag!}.${ct!.startsWith('A') ? 'B' : 'A'}${ct!.slice(1)}`;
    expect(() => decryptSecret(flipped, KEY)).toThrow();
  });
});

describe('recovery codes', () => {
  it('hash the same regardless of case, spaces and dashes', () => {
    expect(hashRecoveryCode('ABCDE-fghij')).toBe(hashRecoveryCode(' abcde fghij'));
  });
});
