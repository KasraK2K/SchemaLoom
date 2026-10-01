import { UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { Client } from 'ssh2';

/**
 * Phase 6 §10.3 — a one-read SSH tunnel. It listens on `127.0.0.1:0`, and every connection to
 * it is forwarded by the bastion to `dstHost:dstPort`. The bastion resolves `dstHost`, which is
 * the point: the database may only exist on the bastion's network.
 *
 * `address` must be what core's SSRF guard checked. Nothing here echoes a key, passphrase or
 * password: ssh2's own messages are replaced, not passed on.
 */
export interface TunnelOptions {
  readonly address: string;
  readonly port: number;
  readonly username: string;
  readonly privateKey?: string;
  readonly passphrase?: string;
  readonly password?: string;
  /** `SHA256:…`; when set, any other host key is refused before authentication */
  readonly pinnedHostKey?: string;
  readonly dstHost: string;
  readonly dstPort: number;
}

export interface Tunnel {
  /** the local port the engine connects to */
  readonly port: number;
  /** the bastion's key as seen this time, so the form can offer to pin it */
  readonly hostKey: string;
  close(): void;
}

const HANDSHAKE_TIMEOUT_MS = 20_000;

/** OpenSSH's format: `SHA256:` + unpadded base64 of the key blob's SHA-256. */
export const hostKeyFingerprint = (key: Buffer): string =>
  `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

/** Tolerates a pasted value without the prefix or with base64 padding. */
const normalizeFingerprint = (value: string): string =>
  `SHA256:${value
    .trim()
    .replace(/^SHA256:/i, '')
    .replace(/=+$/, '')}`;

const failure = (code: 'unreachable' | 'auth_failed' | 'host_key_mismatch', message: string) =>
  new UnprocessableEntityException({ code: `introspect.ssh_${code}`, message });

export function openTunnel(options: TunnelOptions): Promise<Tunnel> {
  const pinned =
    options.pinnedHostKey === undefined || options.pinnedHostKey.trim() === ''
      ? null
      : normalizeFingerprint(options.pinnedHostKey);

  return new Promise<Tunnel>((resolve, reject) => {
    const client = new Client();
    let server: Server | undefined;
    let hostKey = '';
    let mismatch = false;
    let settled = false;

    const close = () => {
      server?.close();
      client.end();
    };
    const fail = (error: Error) => {
      close();
      if (settled) return;
      settled = true;
      reject(error);
    };

    client.on('ready', () => {
      const listener = createServer((socket) => {
        client.forwardOut('127.0.0.1', 0, options.dstHost, options.dstPort, (error, stream) => {
          if (error !== undefined) {
            socket.destroy();
            return;
          }
          socket.on('error', () => stream.destroy());
          stream.on('error', () => socket.destroy());
          socket.pipe(stream).pipe(socket);
        });
      });
      server = listener;
      listener.on('error', () => {
        fail(failure('unreachable', 'Could not open the local end of the SSH tunnel.'));
      });
      listener.listen(0, '127.0.0.1', () => {
        settled = true;
        resolve({ port: (listener.address() as AddressInfo).port, hostKey, close });
      });
    });

    client.on('error', (error: Error & { level?: string }) => {
      if (mismatch) {
        fail(
          failure(
            'host_key_mismatch',
            `The SSH server's host key is ${hostKey}, not the pinned one. Someone may be ` +
              'intercepting the connection; check the key with the server’s administrator.',
          ),
        );
      } else if (error.level === 'client-authentication') {
        fail(failure('auth_failed', 'The SSH server refused the user, key or password.'));
      } else {
        fail(failure('unreachable', 'Could not reach the SSH server.'));
      }
    });
    client.on('close', () => {
      fail(failure('unreachable', 'The SSH server closed the connection.'));
    });

    try {
      client.connect({
        host: options.address,
        port: options.port,
        username: options.username,
        ...(options.privateKey === undefined ? {} : { privateKey: options.privateKey }),
        ...(options.passphrase === undefined ? {} : { passphrase: options.passphrase }),
        ...(options.password === undefined ? {} : { password: options.password }),
        readyTimeout: HANDSHAKE_TIMEOUT_MS,
        hostVerifier: (key: Buffer) => {
          hostKey = hostKeyFingerprint(key);
          mismatch = pinned !== null && pinned !== hostKey;
          return !mismatch;
        },
      });
    } catch {
      // ssh2 parses the key synchronously; its message can quote the key's header.
      fail(failure('auth_failed', 'The private key could not be read. Is the passphrase right?'));
    }
  });
}
