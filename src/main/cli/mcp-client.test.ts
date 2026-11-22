import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpClient } from './mcp-client';

const token = 't'.repeat(43);
let folder: string;
let server: Server | undefined;
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'shell-client-'));
});
afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server)
      server.close(() => {
        resolve();
      });
    else resolve();
  });
  server = undefined;
  await rm(folder, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('the shell MCP client', () => {
  it('reports a failed profile-address read as an unavailable server', async () => {
    const file = path.join(folder, 'token');
    await writeFile(file, token, { mode: 0o600 });
    const discover = vi.fn().mockRejectedValue(new Error('Address unavailable'));
    await expect(
      mcpClient({ env: {}, tokenFile: file, discover }).call('agents', {}),
    ).rejects.toMatchObject({ exitCode: 3 });
  });
  it.each(['null', '{"error":{}}'])('refuses a malformed RPC envelope (%s)', async (body) => {
    const file = path.join(folder, 'token');
    await writeFile(file, token, { mode: 0o600 });
    const post = vi.fn().mockResolvedValue({ status: 200, type: 'application/json', body });
    await expect(
      mcpClient({ env: { CORRALLM_URL: 'http://127.0.0.1:9/mcp' }, tokenFile: file, post }).call(
        'agents',
        {},
      ),
    ).rejects.toMatchObject({ exitCode: 3 });
  });
  it('reports a partial response as a dropped connection', async () => {
    const file = path.join(folder, 'token');
    await writeFile(file, token, { mode: 0o600 });
    server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"jsonrpc":"2.0","id":1,"result":', () => res.destroy());
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${String((server.address() as { port: number }).port)}/mcp`;
    await expect(
      mcpClient({ env: { CORRALLM_URL: url }, tokenFile: file }).call('agents', {}, 1000),
    ).rejects.toMatchObject({ exitCode: 3 });
  });
  it('discovers the same profile address as wait when no URL is set', async () => {
    const file = path.join(folder, 'token');
    await writeFile(file, token, { mode: 0o600 });
    const discover = vi.fn().mockResolvedValue('http://127.0.0.1:9/mcp');
    const post = vi.fn().mockResolvedValue({
      status: 200,
      type: 'application/json',
      body: JSON.stringify({ result: { structuredContent: { agents: [] } } }),
    });
    expect(
      await mcpClient({ env: { CORRALLM_OUTSIDE_TOKEN_FILE: file }, discover, post }).call(
        'agents',
        {},
      ),
    ).toEqual({ agents: [] });
    expect(discover).toHaveBeenCalledOnce();
  });
  it('uses no outside credential inside a corrallm agent', async () => {
    const post = vi.fn();
    await expect(
      mcpClient({
        env: { CORRALLM_AGENT_SESSION: '1', CORRALLM_OUTSIDE_TOKEN_FILE: '/not-read' },
        post,
      }).call('agents', {}),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(post).not.toHaveBeenCalled();
  });
  it('reads the private file on every call, sends it only as a header, and preserves proposals', async () => {
    const file = path.join(folder, 'token');
    await writeFile(file, token, { mode: 0o600 });
    const heard: { auth: string | undefined; body: string }[] = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (data: Buffer) => {
        body += data.toString();
      });
      req.on('end', () => {
        heard.push({ auth: req.headers.authorization, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { structuredContent: { proposed: 'proposal/one' } },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${String((server.address() as { port: number }).port)}/mcp`;
    const client = mcpClient({
      env: { CORRALLM_URL: url, CORRALLM_OUTSIDE_TOKEN: 'ignored' },
      tokenFile: file,
    });
    expect(
      await client.call('agent.setConnection', { canvas: 'x', agent: 'a', connection: 'zed.acp' }),
    ).toEqual({ proposed: 'proposal/one' });
    await writeFile(file, 'u'.repeat(43));
    await client.call('agents', { canvas: 'x' });
    expect(heard.map(({ auth }) => auth)).toEqual([`Bearer ${token}`, `Bearer ${'u'.repeat(43)}`]);
    expect(heard[0]?.body).not.toContain(token);
    expect(JSON.parse(heard[0]?.body ?? '')).toMatchObject({
      method: 'tools/call',
      params: { name: 'agent_setConnection' },
    });
  });
  it('refuses missing, unreadable, public and non-file credentials without a request', async () => {
    const post = vi.fn();
    const file = path.join(folder, 'token');
    await mkdir(path.join(folder, 'directory'));
    for (const at of [
      undefined,
      path.join(folder, 'missing'),
      path.join(folder, 'directory'),
      file,
    ]) {
      await writeFile(file, token, { mode: 0o644 });
      await chmod(file, 0o644);
      await expect(
        mcpClient({
          env: { CORRALLM_URL: 'http://127.0.0.1:9/mcp', CORRALLM_OUTSIDE_TOKEN: token },
          ...(at === undefined ? {} : { tokenFile: at }),
          post,
        }).call('agents', {}),
      ).rejects.toMatchObject({ exitCode: 2 });
    }
    expect(post).not.toHaveBeenCalled();
  });
  it('refuses non-loopback destinations before sending a credential', async () => {
    const file = path.join(folder, 'token');
    await writeFile(file, token, { mode: 0o600 });
    const post = vi.fn();
    await expect(
      mcpClient({ env: { CORRALLM_URL: 'https://example.com/mcp' }, tokenFile: file, post }).call(
        'agents',
        {},
      ),
    ).rejects.toMatchObject({ exitCode: 3 });
    expect(post).not.toHaveBeenCalled();
  });
});
