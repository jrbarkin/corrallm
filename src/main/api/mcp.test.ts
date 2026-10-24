import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { TOKEN_REPLACED } from '../../shared/api/errors';
import { MAX_REQUEST_BYTES } from '../../shared/api/limits';
import { opsFor, toolName } from '../../shared/api/registry';
import SNAPSHOT from '../../shared/api/surface.snap.json';
import type { Party } from '../../shared/api/surface';
import { createDispatcher } from '../core/call';
import type { Dispatcher } from '../core/call';
import type { Caller, TokenCaller } from '../core/caller';
import { createCore } from '../core/core';
import type { Core } from '../core/core';
import {
  CALLERS,
  CANVAS,
  isLead,
  NO_DESKTOP,
  PROPOSAL,
  RESOLVERS,
  testRegistry,
} from '../core/test-registry';
import { startApiServer } from './mcp';
import type { ApiServer, ApiServerOptions } from './mcp';

const TOKENS: Readonly<Record<string, Exclude<Party, 'you'>>> = {
  'lead-token': 'lead',
  'worker-token': 'worker',
  'read-token': 'outside-read',
  'write-token': 'outside-write',
};
const clientOf = (token: string) => {
  const party = TOKENS[token];
  return party === undefined ? undefined : (CALLERS[party] as TokenCaller);
};
const HEADERS = {
  Authorization: 'Bearer write-token',
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};
const LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

let registry: ReturnType<typeof testRegistry>;
let core: Dispatcher;
let server: ApiServer;
let clients: Client[];

beforeEach(async () => {
  registry = testRegistry();
  core = createDispatcher(registry, { isLead, resolvers: RESOLVERS, check: true });
  clients = [];
  server = await startApiServer({ core, clientOf, port: 0 });
});

afterEach(async () => {
  for (const client of clients) await client.close();
  await server.close();
});

async function connect(token = 'write-token', url = server.url) {
  const client = new Client({ name: 'test', version: '1' });
  clients.push(client);
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport as Transport);
  expect(transport.sessionId).toBeUndefined();
  return client;
}

function post(
  body: string,
  headers: Record<string, string> = HEADERS,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sent = request(server.url, { method: 'POST', agent: false, headers }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
      });
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, body: text });
      });
    });
    sent.on('error', reject);
    sent.write(body);
    sent.end();
  });
}

/** The status the server answers with before any of a request's body has been sent. */
function answerBeforeBody(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const sent = request(server.url, {
      method: 'POST',
      agent: false,
      headers: { ...headers, 'Content-Length': '1000' },
    });
    sent.on('response', (response) => {
      resolve(response.statusCode ?? 0);
      sent.destroy();
    });
    sent.on('error', reject);
    sent.flushHeaders();
  });
}

/** `headers` without the header `name`. */
function without(headers: Record<string, string>, name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => key !== name));
}

function jsonRpcError(code: number, message: string) {
  return JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null });
}

describe('the MCP server’s request checks', () => {
  it('serves only /mcp, on 127.0.0.1', async () => {
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${String(server.port)}/mcp`);
    const response = await fetch(server.url.replace('/mcp', '/other'), { headers: HEADERS });
    expect(response.status).toBe(404);
    await response.body?.cancel();
    // Nor a token in a query string.
    const query = await fetch(`${server.url}?token=write-token`, { method: 'POST', body: LIST });
    expect(query.status).toBe(404);
    await query.body?.cancel();
  });

  it.each(['evil.example:1234', '127.0.0.1:1', 'localhost'])(
    'refuses a Host other than its own (%s), before the token and the body',
    async (host) => {
      expect(await post(LIST, { ...HEADERS, Host: host })).toEqual({
        status: 403,
        body: jsonRpcError(-32000, `Invalid Host header: ${host}`),
      });
      expect(
        await answerBeforeBody({ ...HEADERS, Authorization: 'Bearer wrong', Host: host }),
      ).toBe(403);
    },
  );

  it('accepts localhost with its own port as Host', async () => {
    const { status } = await post(LIST, { ...HEADERS, Host: `localhost:${String(server.port)}` });
    expect(status).toBe(200);
  });

  it.each(['http://evil.example', 'null', 'http://127.0.0.1'])(
    'refuses any Origin (%s) with 403, before the token and the body',
    async (origin) => {
      expect(await post(LIST, { ...HEADERS, Origin: origin })).toEqual({
        status: 403,
        body: jsonRpcError(-32000, `Requests from a web page are refused (Origin: ${origin})`),
      });
      expect(
        await answerBeforeBody({ ...HEADERS, Authorization: 'Bearer wrong', Origin: origin }),
      ).toBe(403);
    },
  );

  it.each([
    'text/plain',
    'application/json-seq',
    'text/plain; charset=utf-8',
    'application/json; charset=latin1',
  ])('refuses a body that isn’t exactly JSON (%s) with 415, before the token', async (type) => {
    expect(await post(LIST, { ...HEADERS, 'Content-Type': type })).toEqual({
      status: 415,
      body: jsonRpcError(-32000, 'Unsupported Media Type: the body must be application/json'),
    });
    expect(
      await answerBeforeBody({ ...HEADERS, Authorization: 'Bearer wrong', 'Content-Type': type }),
    ).toBe(415);
  });

  it('refuses a body with no media type, and takes JSON in UTF-8', async () => {
    const untyped = without(HEADERS, 'Content-Type');
    expect((await post(LIST, untyped)).status).toBe(415);
    expect(
      (await post(LIST, { ...HEADERS, 'Content-Type': 'Application/JSON; charset=UTF-8' })).status,
    ).toBe(200);
  });

  it.each([undefined, 'Bearer wrong-token', 'Basic write-token', 'Bearer '])(
    'refuses an unknown or missing bearer token (%s) before reading the body',
    async (authorization) => {
      const headers = without(HEADERS, 'Authorization');
      const sent =
        authorization === undefined ? headers : { ...headers, Authorization: authorization };
      expect((await post('not JSON', sent)).status).toBe(401);
      expect(await answerBeforeBody(sent)).toBe(401);
      expect(Object.values(registry.calls).flat()).toEqual([]);
    },
  );

  it('never takes a token for you, even if its lookup would say so', async () => {
    // A token's lookup can't name you, by its type…
    expectTypeOf<ReturnType<ApiServerOptions['clientOf']>>().toEqualTypeOf<
      TokenCaller | undefined
    >();
    // …nor by what it returns.
    await server.close();
    const you = CALLERS.you as unknown as TokenCaller;
    server = await startApiServer({ core, clientOf: () => you, port: 0 });
    expect((await post(LIST)).status).toBe(401);
  });

  it('tells a token its store made that no longer works why it is refused, and a stranger nothing', async () => {
    await server.close();
    server = await startApiServer({
      core,
      clientOf,
      stale: (token) => token === 'renewed-away',
      port: 0,
    });
    // Refused before any op runs, as any token it doesn't know is (a client's helper reads its
    // header again on a 401), with the sentence a call still going ends with.
    const replaced = await post(LIST, { ...HEADERS, Authorization: 'Bearer renewed-away' });
    expect(replaced.status).toBe(401);
    expect(replaced.body).toBe(jsonRpcError(-32001, TOKEN_REPLACED));
    const unknown = await post(LIST, { ...HEADERS, Authorization: 'Bearer never-made' });
    expect(unknown).toEqual({ status: 401, body: '' });
    expect(Object.values(registry.calls).flat()).toEqual([]);
  });

  it('answers a body that is not JSON with a parse error', async () => {
    expect(await post('not JSON')).toEqual({
      status: 400,
      body: jsonRpcError(-32700, 'Parse error: Invalid JSON'),
    });
  });

  // The client is still sending when a body goes over: the answer must reach it all the same,
  // every time, not a reset.
  it.each([
    [MAX_REQUEST_BYTES + 1, false],
    [MAX_REQUEST_BYTES + 1, true],
    [33 * 1024 * 1024, false],
    [33 * 1024 * 1024, true],
  ])(
    'refuses a body of %i bytes, over 32 MB, once it is read (chunked: %s)',
    async (size, chunked) => {
      const body = 'x'.repeat(size);
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(
          await post(body, { ...HEADERS, ...(chunked ? {} : { 'Content-Length': String(size) }) }),
        ).toEqual({
          status: 413,
          body: jsonRpcError(
            -32000,
            `Payload Too Large: Request body must not exceed ${String(MAX_REQUEST_BYTES)} bytes`,
          ),
        });
      }
      expect(Object.values(registry.calls).flat()).toEqual([]);
    },
  );

  it('drops a client that goes on sending far past 32 MB', async () => {
    await expect(post('x'.repeat(2 * MAX_REQUEST_BYTES + 1))).rejects.toThrow();
  });
});

describe('the MCP server’s tools', () => {
  it.each(Object.entries(TOKENS))(
    'lists to %s the tools of its party, with their schemas and hints',
    async (token, party) => {
      const client = await connect(token);
      const { tools } = await client.listTools();
      const names = opsFor(registry.surface, party);
      expect(tools.map((tool) => tool.name)).toEqual(names.map(toolName));
      for (const name of names) {
        const def = registry.ops[name];
        const surface = registry.surface[name];
        expect(tools.find((tool) => tool.name === toolName(name))).toEqual({
          name: toolName(name),
          description: def?.summary,
          inputSchema: def && z.toJSONSchema(def.input, { io: 'input' }),
          outputSchema: expect.objectContaining({ type: 'object' }) as unknown,
          annotations: {
            readOnlyHint: surface?.kind === 'read',
            destructiveHint: surface?.destructive === true,
          },
        });
      }
    },
  );

  it('gives instructions that stand alone in what Codex reads of them, 512 characters', async () => {
    const client = await connect();
    const instructions = client.getInstructions() ?? '';
    expect(instructions.length).toBeGreaterThan(0);
    expect(instructions.length).toBeLessThanOrEqual(512);
    expect(instructions).toMatch(/\.$/);
  });

  it('calls a tool as the token’s caller, answering JSON text and structured content', async () => {
    const client = await connect('worker-token');
    await client.listTools();
    const args = { canvas: CANVAS, to: 'peer', body: 'Make the tests pass' };
    expect(await client.callTool({ name: 'test_message', arguments: args })).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ sent: 'peer', revs: {} }) }],
      structuredContent: { sent: 'peer', revs: {} },
    });
    expect(registry.calls['test.message']).toEqual([args]);
  });

  it.each<[string, string, Record<string, unknown> | undefined, string]>([
    ['invalid arguments', 'test_message', { canvas: CANVAS, to: 'peer' }, 'invalid'],
    [
      'a tool its party may not call',
      'test_agent',
      { canvas: CANVAS, agent: 'helper' },
      'forbidden',
    ],
    ['a tool only you may call', 'test_yours', {}, 'human-only'],
    ['a tool that doesn’t exist', 'test_missing', undefined, 'not-found'],
    [
      'an id out of its reach',
      'test_message',
      { canvas: CANVAS, to: 'stranger', body: 'hi' },
      'not-found',
    ],
  ])('returns %s as an error value, through the SDK’s client', async (_what, name, args, code) => {
    const client = await connect('worker-token');
    await client.listTools();
    const result = await client.callTool({ name, ...(args ? { arguments: args } : {}) });
    expect(result).toEqual({
      isError: true,
      content: [
        { type: 'text', text: expect.any(String) as unknown },
        { type: 'text', text: expect.any(String) as unknown },
      ],
    });
    const [sentence, error] = result.content as { text: string }[];
    expect(JSON.parse(error?.text ?? '')).toEqual({ error: { code, sentence: sentence?.text } });
    expect(result).not.toHaveProperty('structuredContent');
  });

  it('returns a token’s proposal, which passes the tool’s outputSchema', async () => {
    const client = await connect('write-token');
    await client.listTools();
    expect(
      await client.callTool({
        name: 'test_delete',
        arguments: { canvas: CANVAS, agent: 'stranger' },
      }),
    ).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ proposed: PROPOSAL }) }],
      structuredContent: { proposed: PROPOSAL },
    });
    expect(registry.calls['test.delete']).toEqual([]);
  });

  it('aborts a call when the client aborts its HTTP request', async () => {
    const client = await connect('read-token');
    const holding = client
      .callTool({ name: 'test_hold', arguments: { canvas: CANVAS, agent: 'peer' } })
      .catch(() => undefined);
    await expect.poll(() => registry.calls['test.hold'].length).toBe(1);
    expect(registry.released).toEqual([]);
    await client.close();
    await expect.poll(() => registry.released.length).toBe(1);
    await holding;
  });

  it('aborts calls and ends open connections when the server closes', async () => {
    const client = await connect('read-token');
    const holding = client
      .callTool({ name: 'test_hold', arguments: { canvas: CANVAS, agent: 'peer' } })
      .catch(() => undefined);
    await expect.poll(() => registry.calls['test.hold'].length).toBe(1);
    await server.close();
    expect(registry.released).toHaveLength(1);
    await client.close();
    await holding;
    await expect(fetch(server.url)).rejects.toThrow();
  });
});

describe('the MCP server on the registry', () => {
  let profile: string;
  let real: Core;
  let served: ApiServer;

  beforeEach(async () => {
    profile = await mkdtemp(path.join(tmpdir(), 'corrallm-mcp-'));
    real = await createCore(
      {
        profile,
        app: { name: 'corrallm', version: '1.0.0' },
        check: true,
        distribution: 'local',
        leads: isLead,
      },
      NO_DESKTOP,
    );
    served = await startApiServer({ core: real, clientOf, port: 0 });
  });

  afterEach(async () => {
    await served.close();
    await real.close();
    await rm(profile, { recursive: true, force: true });
  });

  it.each(Object.entries(TOKENS))(
    'lists to %s exactly the tools surface.snap.json says',
    async (token, party) => {
      const client = await connect(token, served.url);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(SNAPSHOT.mcp[party]);
      expect(await client.callTool({ name: 'app_info' })).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ name: 'corrallm', version: '1.0.0' }) }],
        structuredContent: { name: 'corrallm', version: '1.0.0' },
      });
    },
  );

  it('serves a caller as the dispatcher would directly', async () => {
    const caller: Caller = CALLERS.worker;
    const client = await connect('worker-token', served.url);
    await client.listTools();
    const direct = await real.call('usage.get', {}, caller);
    expect(direct.ok).toBe(true);
    expect((await client.callTool({ name: 'usage_get' })).structuredContent).toEqual(
      direct.ok ? direct.value : undefined,
    );
  });

  it('gives the catalog through MCP as core.call does, past its output schema', async () => {
    const client = await connect('read-token', served.url);
    await client.listTools();
    const direct = await real.call('catalog.get', {}, CALLERS['outside-read']);
    if (!direct.ok) throw new Error(direct.error.sentence);
    expect(direct.value.adapters.map(({ id }) => id)).toEqual(['claude-code', 'codex']);
    expect((await client.callTool({ name: 'catalog_get' })).structuredContent).toEqual(
      direct.value,
    );
  });
});
