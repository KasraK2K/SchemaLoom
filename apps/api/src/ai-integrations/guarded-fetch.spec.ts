import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedFetch } from './guarded-fetch';

describe('guardedFetch (roadmap 24 §2.1 base_url)', () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      res.end(`data: ${req.method ?? ''} ${req.headers.host ?? ''}\n\n`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(
    () =>
      new Promise<void>((r) =>
        server.close(() => {
          r();
        }),
      ),
  );

  it('refuses a private address without the opt-in', async () => {
    await expect(guardedFetch(false)(`http://127.0.0.1:${String(port)}/v1/models`)).rejects.toThrow(
      /private/i,
    );
  });

  it('streams from an allowed address and keeps the Host header', async () => {
    const res = await guardedFetch(true, () => Promise.resolve(['127.0.0.1']))(
      `http://llm.local:${String(port)}/v1/models`,
      { method: 'POST', body: '{}' },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`data: one\n\ndata: POST llm.local:${String(port)}\n\n`);
  });
});
