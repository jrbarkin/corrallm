import { request } from 'node:http';
import { Readable } from 'node:stream';

import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * A fetch over `node:http`, for a test's clients of a server the test kills while they talk to it.
 * Node's own fetch (its bundled undici) sets each request's socket type of service as it writes
 * it, and on macOS that throws EINVAL, uncaught, from a socket whose peer has just died: a crash
 * test would fail for the client's sake, never the server's. Here a request to a server that went
 * fails (or its body errors) as any request does.
 */
export const httpFetch: FetchLike = (url, init = {}) =>
  new Promise<Response>((resolve, reject) => {
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init.headers));
    const sent = request(
      new URL(url),
      { method, headers, ...(init.signal ? { signal: init.signal } : {}) },
      (got) => {
        const answered = new Headers();
        for (const [name, value] of Object.entries(got.headers)) {
          if (value === undefined) continue;
          for (const one of Array.isArray(value) ? value : [value]) answered.append(name, one);
        }
        const status = got.statusCode ?? 0;
        const empty = method === 'HEAD' || status === 204 || status === 304;
        if (empty) got.resume();
        resolve(
          new Response(empty ? null : (Readable.toWeb(got) as ReadableStream<Uint8Array>), {
            status,
            statusText: got.statusMessage ?? '',
            headers: answered,
          }),
        );
      },
    );
    sent.on('error', reject);
    const { body } = init;
    if (body === undefined || body === null) sent.end();
    else if (typeof body === 'string') sent.end(body);
    else reject(new TypeError('httpFetch sends only a string body.'));
  });
