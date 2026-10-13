import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { JsonRpcPeer, RpcFailure, startAppServer } from './rpc';
import type { AppServer, AppServerOptions, SpawnAppServer } from './rpc';

/** A fake `codex` that speaks the app server's protocol (fake-codex.mjs), run with node. */
const FAKE = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));

const servers: AppServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function start(
  options: Partial<AppServerOptions> = {},
  env: Record<string, string> = {},
): Promise<AppServer> {
  const server = await startAppServer({
    codex: '/home/me/.local/bin/codex',
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '', ...env },
    clientInfo: { name: 'corrallm', title: 'corrallm', version: '0.1.0' },
    spawn: (_codex, args, spawnOptions) => spawn(process.execPath, [FAKE, ...args], spawnOptions),
    ...options,
  });
  servers.push(server);
  return server;
}

describe('JsonRpcPeer', () => {
  it('pairs results with their requests, by id, in any order', async () => {
    const sent: unknown[] = [];
    const peer = new JsonRpcPeer((line) => sent.push(JSON.parse(line)));
    const first = peer.request('a', { x: 1 });
    const second = peer.request('b');
    // Always with params: Codex refuses a request without them ("missing field `params`").
    expect(sent).toEqual([
      { method: 'a', id: 1, params: { x: 1 } },
      { method: 'b', id: 2, params: {} },
    ]);
    peer.receive('{"id":2,"result":{"ok":2}}');
    peer.receive('{"id":1,"error":{"code":-32600,"message":"Not initialized"}}');
    await expect(second).resolves.toEqual({ ok: 2 });
    await expect(first).rejects.toMatchObject({ code: -32600, message: 'Not initialized' });
  });

  it('answers every request the server makes: as handled, or as not handled', async () => {
    const sent: unknown[] = [];
    const notified = vi.fn();
    const peer = new JsonRpcPeer((line) => sent.push(JSON.parse(line)), {
      notification: notified,
      request: (method) => {
        if (method === 'item/commandExecution/requestApproval') {
          return Promise.resolve({ decision: 'accept' });
        }
        if (method === 'item/tool/requestUserInput') {
          return Promise.reject(new RpcFailure(-32602, 'no such question'));
        }
        return Promise.reject(new Error('boom'));
      },
    });
    peer.receive('{"method":"turn/started","params":{"threadId":"t"}}');
    peer.receive('{"method":"item/commandExecution/requestApproval","id":0,"params":{}}');
    peer.receive('{"method":"item/tool/requestUserInput","id":"q","params":{}}');
    peer.receive('{"method":"attestation/generate","id":9}');
    await vi.waitFor(() => {
      expect(sent).toHaveLength(3);
    });
    expect(notified).toHaveBeenCalledWith('turn/started', { threadId: 't' });
    expect(sent).toEqual([
      { id: 0, result: { decision: 'accept' } },
      { id: 'q', error: { code: -32602, message: 'no such question' } },
      { id: 9, error: { code: -32603, message: 'boom' } },
    ]);
  });

  it('says a method is not handled when it has no handler for requests', async () => {
    const sent: unknown[] = [];
    const peer = new JsonRpcPeer((line) => sent.push(JSON.parse(line)));
    peer.receive('{"method":"account/chatgptAuthTokens/refresh","id":3,"params":{}}');
    await vi.waitFor(() => {
      expect(sent).toEqual([
        {
          id: 3,
          error: {
            code: -32601,
            message: 'corrallm does not handle account/chatgptAuthTokens/refresh',
          },
        },
      ]);
    });
  });

  it('skips lines that are not JSON-RPC, and fails what waits once it closes', async () => {
    const peer = new JsonRpcPeer(() => undefined);
    const waiting = peer.request('thread/start');
    peer.receive('not json');
    peer.receive('[1,2]');
    peer.close(new Error('It stopped.'));
    await expect(waiting).rejects.toThrow('It stopped.');
    await expect(peer.request('again')).rejects.toThrow('It stopped.');
  });
});

describe('startAppServer', () => {
  it('runs `codex app-server` and says hello: initialize, then initialized', async () => {
    const spawned = vi.fn<SpawnAppServer>((codex, args, options) => {
      expect(codex).toBe('/home/me/.local/bin/codex');
      expect(args).toEqual(['app-server', '-c', 'analytics.enabled=false']);
      expect(options).toMatchObject({ cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
      return spawn(process.execPath, [FAKE, ...args], options);
    });
    const server = await start({ args: ['-c', 'analytics.enabled=false'], spawn: spawned });
    expect(spawned).toHaveBeenCalledTimes(1);
    expect(server.version).toBe('0.160.1');
    expect(server.codexHome).toMatch(/\.codex$/);
    // The fake refuses anything before initialized; this went through.
    expect(await server.request('account/read', { refreshToken: false })).toMatchObject({
      account: { type: 'apiKey' },
    });
  });

  it('hears notifications and answers the server’s requests through its handlers', async () => {
    const notifications: string[] = [];
    const server = await start({
      onNotification: (method) => notifications.push(method),
      onRequest: (method) =>
        method === 'item/commandExecution/requestApproval'
          ? Promise.resolve({ decision: 'accept' })
          : Promise.reject(new RpcFailure(-32601, 'no')),
    });
    const { thread } = (await server.request('thread/start', { cwd: process.cwd() })) as {
      thread: { id: string };
    };
    await server.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'run the tests', text_elements: [] }],
    });
    await vi.waitFor(() => {
      expect(notifications).toContain('turn/completed');
    });
    expect(notifications).toEqual(
      expect.arrayContaining(['turn/started', 'item/started', 'item/completed']),
    );
    expect(notifications).toContain('serverRequest/resolved');
  });

  it('closes: ends its input, and resolves once it has exited', async () => {
    const server = await start();
    await server.close();
    const { code } = await server.exited;
    expect(code).toBe(0);
    await expect(server.request('account/read')).rejects.toThrow(/stopped/);
  });

  it('says why it could not start, with what Codex printed', async () => {
    await expect(start({}, { FAKE_CODEX_FAIL: 'unknown variant `on-failure`' })).rejects.toThrow(
      /Codex's app server stopped.*unknown variant `on-failure`/s,
    );
  });
});
