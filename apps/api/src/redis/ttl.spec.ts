import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { PERMISSION_MAP_TTL_CAP_SEC, cappedTtlSec, setWithTtl } from './ttl';

function fakeRedis(): { client: Redis; set: ReturnType<typeof vi.fn> } {
  const set = vi.fn().mockResolvedValue('OK');
  return { client: { set } as unknown as Redis, set };
}

describe('setWithTtl — §4.4 rule 1', () => {
  it('always writes an expiry', async () => {
    const { client, set } = fakeRedis();
    await expect(setWithTtl(client, 'k', 'v', 300)).resolves.toBe('OK');
    expect(set).toHaveBeenCalledWith('k', 'v', 'EX', 300);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a TTL of %s instead of writing a key that never expires',
    (ttl) => {
      const { client, set } = fakeRedis();
      expect(() => setWithTtl(client, 'k', 'v', ttl)).toThrow(RangeError);
      expect(set).not.toHaveBeenCalled();
    },
  );
});

describe('cappedTtlSec — min(cap, validUntil − now)', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const at = (sec: number): Date => new Date(now.getTime() + sec * 1000);

  it('caps a long-lived subject at 300s', () => {
    expect(cappedTtlSec(at(86_400), now)).toBe(PERMISSION_MAP_TTL_CAP_SEC);
  });

  it('uses the REMAINING lifetime when it is shorter than the cap', () => {
    // The bug this guards: `min(300, validUntil)` against an absolute timestamp
    // always picks 300 and leaves a 300s map behind an expiring share link.
    expect(cappedTtlSec(at(42), now)).toBe(42);
  });

  it('returns null for an already-expired subject', () => {
    expect(cappedTtlSec(at(-1), now)).toBeNull();
    expect(cappedTtlSec(now, now)).toBeNull();
  });

  it('uses the full cap when the subject never expires', () => {
    expect(cappedTtlSec(null, now)).toBe(PERMISSION_MAP_TTL_CAP_SEC);
    expect(cappedTtlSec(undefined, now)).toBe(PERMISSION_MAP_TTL_CAP_SEC);
  });
});
