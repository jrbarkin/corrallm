import { request } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '../../shared/messages';
import { startApiServer } from './mcp';
import type { ApiClient, ApiServer } from './mcp';
import { OPERATIONS } from './operations';
import type { Api } from './operations';

const ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const TOKENS = new Map<string, ApiClient>([
  ['agent-token', { name: 'claude', scope: 'agent' }],
  ['outside-token', { name: 'you', scope: 'outside' }],
]);
const HEADERS = {
  Authorization: 'Bearer agent-token',
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};
const MESSAGE: Message = {
  id: ID,
  from: 'codex',
  to: 'you',
  kind: 'text',
  body: 'Done.',
  at: 123,
};

function fakeApi() {
  return {
    message: vi.fn<Api['message']>().mockResolvedValue({ id: ID }),
    reply: vi.fn<Api['reply']>().mockResolvedValue({ id: ID }),
    status: vi.fn<Api['status']>().mockResolvedValue({ agents: [], pending: [MESSAGE] }),
    wait: vi.fn<Api['wait']>().mockResolvedValue(null),
  };
}

let api: ReturnType<typeof fakeApi>;
let server: ApiServer;
let clients: Client[];

beforeEach(async () => {
  api = fakeApi();
  clients = [];
  server = await startApiServer({ api, clientOf: (token) => TOKENS.get(token), port: 0 });
});

afterEach(async () => {
  for (const client of clients) await client.close();
  await server.close();
});

async function connect(token = 'agent-token') {
  const client = new Client({ name: 'test', version: '1' });
  clients.push(client);
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport as Transport);
  expect(transport.sessionId).toBeUndefined();
  return client;
}

function post(body: string, headers: Record<string, string> = HEADERS): Promise<number> {
  return new Promise((resolve, reject) => {
    const sent = request(server.url, { method: 'POST', agent: false, headers }, (response) => {
      response.resume();
      response.on('end', () => {
        resolve(response.statusCode ?? 0);
      });
    });
    sent.on('error', reject);
    sent.write(body);
    sent.end();
  });
}

function holdWait() {
  const started = Promise.withResolvers<AbortSignal>();
  const aborted = Promise.withResolvers<undefined>();
  api.wait.mockImplementation(
    (_from, _args, signal) =>
      new Promise((resolve) => {
        started.resolve(signal);
        signal.addEventListener(
          'abort',
          () => {
            aborted.resolve(undefined);
            resolve(null);
          },
          { once: true },
        );
      }),
  );
  return { started: started.promise, aborted: aborted.promise };
}

describe('the MCP API server', () => {
  it.each([undefined, 'Bearer wrong-token', 'Basic agent-token', 'Bearer '])(
    'refuses an unknown or missing bearer token (%s) before reading the request',
    async (authorization) => {
      const response = await fetch(server.url, {
        method: 'POST',
        headers: authorization === undefined ? {} : { Authorization: authorization },
        body: 'not JSON',
      });
      expect(response.status).toBe(401);
      await response.body?.cancel();
      expect(api.message).not.toHaveBeenCalled();
    },
  );

  it('serves only /mcp, on 127.0.0.1', async () => {
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${String(server.port)}/mcp`);
    const response = await fetch(server.url.replace('/mcp', '/other'), { headers: HEADERS });
    expect(response.status).toBe(404);
    await response.body?.cancel();
  });

  it.each(['evil.example:1234', '127.0.0.1:1', 'localhost'])(
    'refuses a Host other than this server (%s)',
    async (host) => {
      const status = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), {
        ...HEADERS,
        Host: host,
      });
      expect(status).toBe(403);
    },
  );

  it('accepts localhost with its own port as Host', async () => {
    const status = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), {
      ...HEADERS,
      Host: `localhost:${String(server.port)}`,
    });
    expect(status).toBe(200);
  });

  it.each([false, true])('refuses bodies over 1 MB (chunked: %s)', async (chunked) => {
    const body = 'x'.repeat(1024 * 1024 + 1);
    const status = await post(body, {
      ...HEADERS,
      ...(chunked ? {} : { 'Content-Length': String(Buffer.byteLength(body)) }),
    });
    expect(status).toBe(413);
    expect(api.message).not.toHaveBeenCalled();
  });

  it.each([
    ['agent-token', ['message', 'reply']],
    ['outside-token', ['message', 'reply', 'status']],
  ] as const)('lists the operations for %s, with their schemas', async (token, names) => {
    const client = await connect(token);
    const { tools } = await client.listTools();
    expect(tools).toEqual(
      names.map((name) => ({
        name,
        description: OPERATIONS[name].description,
        inputSchema: OPERATIONS[name].input,
      })),
    );
  });

  it('calls message as the client and returns JSON text and structured content', async () => {
    const client = await connect();
    const args = { to: 'codex', body: 'Make the tests pass', replyTo: ID };
    const result = await client.callTool({ name: 'message', arguments: args });
    expect(api.message).toHaveBeenCalledExactlyOnceWith('claude', args);
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ id: ID }) }],
      structuredContent: { id: ID },
    });
  });

  it('returns the argument error without calling the Api', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'message', arguments: { to: 'codex' } });
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('body is text') as unknown }],
    });
    expect(api.message).not.toHaveBeenCalled();
  });

  it.each(['status', 'wait', 'missing', 'toString'])(
    'refuses %s when the client cannot call it',
    async (name) => {
      const client = await connect();
      await expect(client.callTool({ name })).rejects.toThrow(/tool/i);
      expect(api.status).not.toHaveBeenCalled();
      expect(api.wait).not.toHaveBeenCalled();
    },
  );

  it('calls reply and status as the client', async () => {
    const client = await connect('outside-token');
    await client.callTool({ name: 'reply', arguments: { to: ID, text: 'yes' } });
    expect(api.reply).toHaveBeenCalledExactlyOnceWith('you', { to: ID, text: 'yes' });
    const result = await client.callTool({ name: 'status' });
    expect(api.status).toHaveBeenCalledExactlyOnceWith('you');
    expect(result.structuredContent).toEqual({ agents: [], pending: [MESSAGE] });
  });

  it('returns an Api failure as a tool error', async () => {
    api.message.mockRejectedValue(new Error('The agent has stopped.'));
    const client = await connect();
    expect(
      await client.callTool({
        name: 'message',
        arguments: { to: 'codex', body: 'hi' },
      }),
    ).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'The agent has stopped.' }],
    });
  });

  it.each([MESSAGE, null])('lets an outside client call wait and return %j', async (message) => {
    api.wait.mockResolvedValue(message);
    const client = await connect('outside-token');
    const result = await client.callTool({ name: 'wait', arguments: { for: ID } });
    expect(api.wait).toHaveBeenCalledExactlyOnceWith(
      'you',
      { for: ID, timeoutSeconds: 600 },
      expect.any(AbortSignal),
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify(message) }],
      ...(message === null ? {} : { structuredContent: message }),
    });
  });

  it('aborts wait when the client aborts its HTTP request', async () => {
    const waiting = holdWait();
    const client = await connect('outside-token');
    const call = client.callTool({ name: 'wait' }).catch(() => undefined);
    const signal = await waiting.started;
    expect(signal.aborted).toBe(false);
    await client.close();
    await waiting.aborted;
    expect(signal.aborted).toBe(true);
    await call;
  });

  it('aborts wait and ends open connections when the server closes', async () => {
    const waiting = holdWait();
    const client = await connect('outside-token');
    const call = client.callTool({ name: 'wait' }).catch(() => undefined);
    const signal = await waiting.started;
    expect(signal.aborted).toBe(false);
    await server.close();
    await waiting.aborted;
    expect(signal.aborted).toBe(true);
    await client.close();
    await call;
    await expect(fetch(server.url)).rejects.toThrow();
  });
});
