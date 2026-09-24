import * as argon2 from 'argon2';

/**
 * argon2id, OWASP Password Storage minimum: m = 19 MiB, t = 2, p = 1.
 *
 * Why these numbers and not "more is better": the api runs many concurrent requests in
 * one process, and memoryCost is charged per *in-flight hash*, not per process. At 19
 * MiB a burst of 50 simultaneous logins costs ~1 GiB of RSS; at the 64 MiB some guides
 * suggest it is 3.2 GiB and the container is OOM-killed, which is a worse outcome than
 * a marginally cheaper hash. Raise `timeCost` before `memoryCost` if the threat model
 * changes — it is the axis that does not multiply by concurrency.
 *
 * argon2 embeds every parameter in the encoded hash, so `verify` keeps working against
 * rows written under older settings; changing these does not invalidate stored hashes.
 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
}

/** Never throws on a malformed stored hash — a corrupt row is a failed login, not a 500. */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/**
 * Burns roughly one hash's worth of time on a login for an address that has no password
 * (unknown user, or OAuth-only). Without it, "user exists" is a timing oracle on an
 * endpoint that deliberately returns one uniform error.
 */
export async function burnPasswordTime(plain: string): Promise<void> {
  await argon2.hash(plain, ARGON2_OPTIONS);
}
