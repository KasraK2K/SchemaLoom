import * as argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import { ARGON2_OPTIONS, hashPassword, verifyPassword } from './password';

describe('password hashing', () => {
  it('round-trips a password and rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery stapl')).toBe(false);
  });

  it('is argon2id at the documented cost, and says so in the encoded hash', async () => {
    expect(ARGON2_OPTIONS.type).toBe(argon2.argon2id);
    const hash = await hashPassword('whatever');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).toContain(`m=${String(ARGON2_OPTIONS.memoryCost)}`);
    expect(hash).toContain(`t=${String(ARGON2_OPTIONS.timeCost)}`);
    expect(hash).toContain(`p=${String(ARGON2_OPTIONS.parallelism)}`);
  });

  it('salts: the same password hashes differently every time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('treats a corrupt stored hash as a failed login, not a crash', async () => {
    await expect(verifyPassword('not-a-hash', 'x')).resolves.toBe(false);
  });
});
