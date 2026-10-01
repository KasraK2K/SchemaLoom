import { createServer, connect, type AddressInfo, type Server as NetServer } from 'node:net';
import { Server as SshServer, utils } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostKeyFingerprint, openTunnel, type TunnelOptions } from './ssh-tunnel';

/**
 * Phase 6 §10.3 against a real, in-process SSH server: password login, forwarding to a local
 * echo server that stands in for the database, host-key pinning and the failure codes.
 */

const hostKeys = utils.generateKeyPairSync('ed25519');
const clientKeys = utils.generateKeyPairSync('ed25519', {
  passphrase: 'pp',
  cipher: 'aes256-cbc',
  rounds: 16,
});
const clientPublic = utils.parseKey(clientKeys.public);

let echo: NetServer;
let ssh: SshServer;
let sshPort = 0;
let echoPort = 0;
let fingerprint = '';

const listen = (server: NetServer | SshServer): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });

beforeAll(async () => {
  echo = createServer((socket) => socket.pipe(socket));
  echoPort = await listen(echo);

  ssh = new SshServer({ hostKeys: [hostKeys.private] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.username !== 'tunnel') {
        ctx.reject();
        return;
      }
      if (ctx.method === 'password' && ctx.password === 'right') {
        ctx.accept();
        return;
      }
      if (
        ctx.method === 'publickey' &&
        !(clientPublic instanceof Error) &&
        ctx.key.data.equals(clientPublic.getPublicSSH())
      ) {
        ctx.accept();
        return;
      }
      ctx.reject();
    });
    client.on('ready', () => {
      client.on('tcpip', (accept, _reject, info) => {
        const upstream = connect(info.destPort, info.destIP);
        const channel = accept();
        upstream.on('error', () => channel.destroy());
        channel.pipe(upstream).pipe(channel);
      });
    });
    client.on('error', () => undefined);
  });
  sshPort = await listen(ssh);

  const parsed = utils.parseKey(hostKeys.public);
  if (parsed instanceof Error) throw parsed;
  fingerprint = hostKeyFingerprint(parsed.getPublicSSH());
});

afterAll(() => {
  ssh.close();
  echo.close();
});

const base = (): TunnelOptions => ({
  address: '127.0.0.1',
  port: sshPort,
  username: 'tunnel',
  password: 'right',
  dstHost: '127.0.0.1',
  dstPort: echoPort,
});

const roundTrip = (port: number, text: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(text));
    socket.once('data', (data) => {
      socket.end();
      resolve(data.toString());
    });
    socket.on('error', reject);
  });

describe('openTunnel', () => {
  it('forwards through the bastion and reports its host key', async () => {
    const tunnel = await openTunnel(base());
    try {
      expect(tunnel.hostKey).toBe(fingerprint);
      expect(await roundTrip(tunnel.port, 'ping')).toBe('ping');
    } finally {
      tunnel.close();
    }
  });

  it('logs in with a passphrase-protected key', async () => {
    const tunnel = await openTunnel({
      ...base(),
      password: undefined,
      privateKey: clientKeys.private,
      passphrase: 'pp',
    });
    tunnel.close();
  });

  it('accepts a pinned key pasted without the prefix', async () => {
    const tunnel = await openTunnel({
      ...base(),
      pinnedHostKey: ` ${fingerprint.replace('SHA256:', '')}= `,
    });
    tunnel.close();
  });

  it('refuses a different host key before logging in', async () => {
    await expect(
      openTunnel({
        ...base(),
        pinnedHostKey: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }),
    ).rejects.toMatchObject({
      response: { code: 'introspect.ssh_host_key_mismatch' },
    });
  });

  it('maps a refused password and an unreadable key to auth_failed without echoing them', async () => {
    const wrong = openTunnel({ ...base(), password: 'wr0ng-secret' });
    await expect(wrong).rejects.toMatchObject({ response: { code: 'introspect.ssh_auth_failed' } });
    await wrong.catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toContain('wr0ng-secret');
    });

    await expect(
      openTunnel({
        ...base(),
        password: undefined,
        privateKey: clientKeys.private,
        passphrase: 'no',
      }),
    ).rejects.toMatchObject({ response: { code: 'introspect.ssh_auth_failed' } });
  });

  it('maps a closed port to unreachable', async () => {
    const probe = createServer();
    const closed = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));
    await expect(openTunnel({ ...base(), port: closed })).rejects.toMatchObject({
      response: { code: 'introspect.ssh_unreachable' },
    });
  });
});
