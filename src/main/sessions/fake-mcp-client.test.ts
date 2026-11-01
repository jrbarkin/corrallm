import { describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

import type { ToolListing } from '../../shared/api/registry';
import type { AgentChannel } from './connector';
import { connectChannel, connectHttp, connectServer } from './fake-mcp-client.mjs';

const tool: ToolListing = {
  name: 'fixture_read',
  description: 'A fixture read',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  annotations: { readOnlyHint: true, destructiveHint: false },
};
const success: CallToolResult = { content: [{ type: 'text', text: '{}' }], structuredContent: {} };
const failure: CallToolResult = {
  isError: true,
  content: [{ type: 'text', text: 'Not in reach.' }],
};

describe('the shared fake MCP client', () => {
  it('lists and calls through the delivered in-process MCP server instance', async () => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- Exercise the low-level server instance delivered by the SDK entry.
    const server = new Server(
      { name: 'corrallm', version: 'test' },
      { capabilities: { tools: {} } },
    );
    const listed = vi.fn(() => ({ tools: [tool] }));
    const called = vi.fn<(_params: unknown) => CallToolResult>(() => success);
    server.setRequestHandler(ListToolsRequestSchema, listed);
    server.setRequestHandler(CallToolRequestSchema, ({ params }) => called(params));
    const client = await connectServer(server);
    try {
      expect(await client.list()).toEqual([tool]);
      expect(listed).toHaveBeenCalledOnce();
      const args = { ordinary: 'text' };
      expect(await client.call(tool.name, args)).toEqual(success);
      expect(called.mock.calls[0]).toEqual([{ name: tool.name, arguments: args }]);
    } finally {
      await client.close();
    }
  });

  it('lists and calls through its bound channel, preserving arguments, errors and cancellation', async () => {
    const list = vi.fn(() => [tool]);
    const call = vi.fn<AgentChannel['call']>().mockResolvedValue(success);
    const channel: AgentChannel = { list, call };
    const client = connectChannel(channel);
    expect(await client.list()).toEqual([tool]);
    expect(list).toHaveBeenCalledOnce();
    const args = { canvas: 'named-by-the-call', extra: ['ordinary input'] };
    const controller = new AbortController();
    expect(await client.call(tool.name, args, controller.signal)).toBe(success);
    expect(call).toHaveBeenCalledExactlyOnceWith(tool.name, args, controller.signal);
    call.mockResolvedValueOnce(failure);
    expect(await client.call(tool.name, {})).toBe(failure);
    call.mockImplementationOnce(
      (_name, _args, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new Error('Stopped'));
            },
            { once: true },
          );
        }),
    );
    const pending = client.call(tool.name, {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('Stopped');
    await client.close();
    await expect(client.list()).rejects.toThrow('closed');
    await expect(client.call(tool.name, {})).rejects.toThrow('closed');
  });

  it.each(['json', 'sse'])(
    'performs initialize, tools/list and tools/call over HTTP %s with the delivered credential',
    async (wire) => {
      const token = 'fake-generation-canary';
      const requests: { method: string; params?: unknown }[] = [];
      const fetcher = vi.fn<typeof fetch>((_url, init) => {
        expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
        expect(init?.redirect).toBe('error');
        if (init?.method === 'GET') return Promise.resolve(new Response(null, { status: 405 }));
        if (init?.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON request');
        const rpc = JSON.parse(init.body) as {
          id?: number;
          method: string;
          params?: { protocolVersion?: string };
        };
        requests.push(rpc);
        let result: unknown;
        switch (rpc.method) {
          case 'initialize':
            result = {
              protocolVersion: rpc.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'corrallm', version: 'test' },
            };
            break;
          case 'notifications/initialized':
            return Promise.resolve(new Response(null, { status: 202 }));
          case 'tools/list':
            result = { tools: [tool] };
            break;
          case 'tools/call':
            result =
              requests.filter((one) => one.method === 'tools/call').length === 1
                ? success
                : failure;
            break;
          default:
            throw new Error('Unexpected method');
        }
        const reply = { jsonrpc: '2.0', id: rpc.id, result };
        return Promise.resolve(
          wire === 'json'
            ? Response.json(reply)
            : new Response(`event: message\ndata: ${JSON.stringify(reply)}\n\n`, {
                headers: { 'Content-Type': 'text/event-stream' },
              }),
        );
      });
      const client = await connectHttp(
        { url: 'http://127.0.0.1:1234/mcp', token },
        { fetch: fetcher },
      );
      try {
        expect(await client.list()).toEqual([tool]);
        const args = { ordinary: 'text' };
        expect(await client.call(tool.name, args)).toEqual(success);
        expect(await client.call(tool.name, {})).toEqual(failure);
        expect(requests.map((one) => one.method)).toEqual([
          'initialize',
          'notifications/initialized',
          'tools/list',
          'tools/call',
          'tools/call',
        ]);
        expect(requests[3]?.params).toEqual({ name: tool.name, arguments: args });
      } finally {
        await client.close();
      }
    },
  );

  it.each([
    'not a URL',
    'https://127.0.0.1:1234/mcp',
    'http://example.com/mcp',
    'http://name:password@127.0.0.1/mcp',
    'http://127.0.0.1/mcp?token=x',
    'http://127.0.0.1/mcp#x',
    'http://127.0.0.1/other',
  ])('refuses %s before handing a credential to HTTP', async (url) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(connectHttp({ url, token: 'canary' }, { fetch: fetcher })).rejects.toThrow(
      'loopback',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
