import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Phase 6 §3.2 — the SSRF guard. Reading a database means the api opens a connection to a
 * host the user typed, so without this anyone with `schema:edit` could probe the api's own
 * network (Redis, the metadata service at 169.254.169.254, the app database).
 *
 * The host is resolved ONCE here, and the engine connects to the address that was checked,
 * so a DNS answer that changes between check and connect (rebinding) cannot slip through.
 * A name that resolves to several addresses is refused if ANY of them is blocked.
 */
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64 can map onto a private IPv4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv6');
}

/** `::ffff:10.0.0.1` is 10.0.0.1: check the embedded IPv4, or the mapping is a bypass. */
export function isBlockedAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped !== undefined) return BLOCKED.check(mapped, 'ipv4');
  const family = isIP(address);
  if (family === 0) return true;
  return BLOCKED.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export type Resolve = (host: string) => Promise<readonly string[]>;

const dnsResolve: Resolve = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * The address to connect to. `allowPrivate` is `INTROSPECT_ALLOW_PRIVATE_HOSTS`, for a
 * self-hosted install reading databases on its own network.
 */
export async function resolveCheckedAddress(
  host: string,
  allowPrivate: boolean,
  resolve: Resolve = dnsResolve,
): Promise<string> {
  let addresses: readonly string[];
  try {
    addresses = await resolve(host);
  } catch {
    addresses = [];
  }
  const first = addresses[0];
  if (first === undefined) {
    throw new UnprocessableEntityException({
      code: 'introspect.unreachable',
      message: `Could not find a host named ${host}.`,
    });
  }
  if (!allowPrivate && addresses.some(isBlockedAddress)) {
    throw new UnprocessableEntityException({
      code: 'introspect.private_host',
      message:
        'That host is on a private or internal network, which this server does not connect to. ' +
        'A self-hosted install can allow it with INTROSPECT_ALLOW_PRIVATE_HOSTS=true.',
    });
  }
  return first;
}

/** `INTROSPECTION_ENABLED=false` makes the routes disappear rather than refuse. */
export function assertIntrospectionEnabled(enabled: boolean): void {
  if (!enabled) throw new NotFoundException({ code: 'not_found' });
}
