import { describe, expect, it } from 'vitest';
import { isBlockedAddress, resolveCheckedAddress } from './address-guard';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '64:ff9b::a00:1',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '203.0.113.7', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])(
    'allows %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe('resolveCheckedAddress', () => {
  const fixed = (addresses: readonly string[]) => () => Promise.resolve(addresses);

  it('returns the first resolved public address', async () => {
    await expect(
      resolveCheckedAddress('db.example.com', false, fixed(['203.0.113.7', '203.0.113.8'])),
    ).resolves.toBe('203.0.113.7');
  });

  it('refuses a name when any of its addresses is private', async () => {
    await expect(
      resolveCheckedAddress('rebind.example.com', false, fixed(['203.0.113.7', '10.0.0.5'])),
    ).rejects.toMatchObject({ response: { code: 'introspect.private_host' } });
  });

  it('allows private addresses when the self-host flag is set', async () => {
    await expect(resolveCheckedAddress('postgres', true, fixed(['172.18.0.2']))).resolves.toBe(
      '172.18.0.2',
    );
  });

  it('reports a name that does not resolve as unreachable', async () => {
    await expect(
      resolveCheckedAddress('nope.invalid', false, () => Promise.reject(new Error('ENOTFOUND'))),
    ).rejects.toMatchObject({ response: { code: 'introspect.unreachable' } });
  });
});
