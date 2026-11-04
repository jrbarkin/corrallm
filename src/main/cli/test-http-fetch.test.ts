import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { httpFetch } from './test-http-fetch';

/*
 * The crash test's clients fetch over node:http, not Node's own fetch (see test-http-fetch.ts):
 * what they rely on, a JSON answer, a streamed one, a refusal and a server that dies mid-answer.
 */

let server: Server | undefined;
afterEach(async () => {
  const open = server;
  server = undefined;
  if (open !== undefined) await new Promise((resolve) => open.close(resolve));
});

async function serving(handle: (req: IncomingMessage, res: ServerResponse) => void) {
  const made = createServer(handle);
  server = made;
  await new Promise<void>((resolve) => made.listen(0, '127.0.0.1', resolve));
  const { port } = made.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}/mcp`;
}

describe('httpFetch', () => {
  it('sends its method, headers and body, and reads a JSON answer', async () => {
    const url = await serving((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'kept' });
        res.end(JSON.stringify({ method: req.method, auth: req.headers.authorization, body }));
      });
    });
    const got = await httpFetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{"ok":true}',
    });
    expect(got.status).toBe(200);
    expect(got.headers.get('mcp-session-id')).toBe('kept');
    expect(await got.json()).toEqual({ method: 'POST', auth: 'Bearer t', body: '{"ok":true}' });
  });

  it('streams an answer as it comes, and gives no body for 202 Accepted', async () => {
    const url = await serving((req, res) => {
      if (req.method === 'DELETE') {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => res.end('data: two\n\n'), 20);
    });
    const got = await httpFetch(url);
    expect(await got.text()).toBe('data: one\n\ndata: two\n\n');
    expect((await httpFetch(url, { method: 'DELETE' })).status).toBe(202);
  });

  it('fails, never throws uncaught, when the server is gone or dies mid-answer', async () => {
    const url = await serving((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => res.socket?.destroy(), 10);
    });
    const got = await httpFetch(url);
    await expect(got.text()).rejects.toThrow();
    const open = server;
    server = undefined;
    if (open !== undefined) await new Promise((resolve) => open.close(resolve));
    await expect(httpFetch(url, { method: 'POST', body: '{}' })).rejects.toThrow();
  });
});
