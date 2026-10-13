import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { resolveCheckedAddress, type Resolve } from '../introspect/address-guard';

/**
 * Roadmap 24 — the `fetch` handed to the OpenAI SDK for an `openai_compatible` base URL. The
 * host is resolved and checked once per request and the socket connects to that address, so a
 * DNS answer cannot change between the check and the connect. Public providers (OpenAI,
 * Gemini, Anthropic) use the SDK's own fetch.
 */
export function guardedFetch(allowPrivate: boolean, resolve?: Resolve): typeof fetch {
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const address = await resolveCheckedAddress(url.hostname.replace(/^\[|\]$/g, ''), allowPrivate, resolve);
    const lookup = ((_host, options, callback) => {
      const family = address.includes(':') ? 6 : 4;
      if ((options as { all?: boolean }).all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    }) as LookupFunction;
    const headers = new Headers(init.headers);
    // The SDK sends JSON strings only. String(object) would silently send "[object Object]".
    if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') {
      throw new TypeError('guardedFetch sends string bodies only');
    }
    const body = init.body ?? undefined;
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise<Response>((resolveResponse, reject) => {
      const req = transport.request(
        url,
        { method: init.method ?? 'GET', headers: Object.fromEntries(headers), lookup, signal: init.signal ?? undefined },
        (res) => {
          const responseHeaders = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') responseHeaders.set(k, v);
            else if (Array.isArray(v)) for (const item of v) responseHeaders.append(k, item);
          }
          resolveResponse(
            new Response(Readable.toWeb(res), { status: res.statusCode ?? 0, headers: responseHeaders }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  };
}
