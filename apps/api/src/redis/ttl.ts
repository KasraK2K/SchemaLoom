import type { Redis } from 'ioredis';

/**
 * Doc 01 §4.4 rule 1 — **every cache and rate-limit key is written with an explicit
 * TTL. No exceptions.** This is what makes `--maxmemory-policy noeviction` (§10) safe:
 * the permission cache is one entry per (principal, resource) pair and would otherwise
 * grow without bound until Redis started rejecting *writes* — including queue writes —
 * on the one instance that carries the queues. `noeviction` protects the queue; TTLs
 * protect `noeviction`.
 *
 * Call `setWithTtl`, never `client.set(key, value)`. A plain `SET` is the violation.
 */
export function setWithTtl(
  client: Redis,
  key: string,
  value: string,
  ttlSec: number,
): Promise<'OK' | null> {
  if (!Number.isInteger(ttlSec) || ttlSec <= 0) {
    throw new RangeError(`TTL must be a positive whole number of seconds, got ${String(ttlSec)}`);
  }
  return client.set(key, value, 'EX', ttlSec);
}

/** §9.1 cap for a permission-map entry. A cap, not a constant — see `cappedTtlSec`. */
export const PERMISSION_MAP_TTL_CAP_SEC = 300;

/** §9.1 TTL for the permission skeleton. */
export const PERMISSION_SKELETON_TTL_SEC = 600;

/**
 * `min(cap, validUntil − now)` — a REMAINING-LIFETIME subtraction.
 *
 * RECONCILIATION "still open" note: doc 01 §4.4 writes this as `min(300s, validUntil)`
 * in one place. Taken literally against an absolute timestamp that always picks 300 and
 * silently disables the expiry-derived TTL, leaving an expiring share link with a
 * 300-second permission map behind it. It is the subtraction.
 *
 * @returns whole seconds, or `null` when the subject has already expired (nothing to cache).
 */
export function cappedTtlSec(
  validUntil: Date | null | undefined,
  now: Date,
  capSec: number = PERMISSION_MAP_TTL_CAP_SEC,
): number | null {
  if (!validUntil) return capSec;
  const remaining = Math.floor((validUntil.getTime() - now.getTime()) / 1000);
  if (remaining <= 0) return null;
  return Math.min(capSec, remaining);
}
