import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { testMcpServer } from './test-mcp';
import { prepareApi } from './codex/mcp';
import { startAppServer } from './codex/rpc';

it.each(['claude', 'codex'])(
  'the %s Terminal executable fake lists and calls its own session MCP entry without logging the bearer',
  async (kind) => {
    const folder = await mkdtemp(path.join(tmpdir(), 'corrallm-native-api-'));
    const token = `${kind}-executable-credential-canary`;
    const endpoint = await testMcpServer(token);
    const api = {
      kind: 'http' as const,
      server: 'corrallm' as const,
      url: endpoint.url,
      token,
      tools: [{ name: 'probe_read', destructive: false }],
      off: ['corrallm-server', 'corrallm-server-dev'],
    };
    const mcp = path.join(folder, 'mcp.json'),
      settings = path.join(folder, 'settings.json');
    await writeFile(
      mcp,
      JSON.stringify({
        mcpServers: {
          corrallm: {
            type: 'http',
            url: endpoint.url,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(settings, '{}', { mode: 0o600 });
    const file = path.resolve(
      import.meta.dirname,
      '../../../e2e',
      kind === 'claude' ? 'fake-claude.mjs' : 'fake-codex-tui.mjs',
    );
    const prepared =
      kind === 'codex'
        ? await prepareApi(
            { codex: file, cwd: folder, env: { PATH: process.env.PATH ?? '' } },
            api,
            {
              start: (options) =>
                startAppServer({
                  ...options,
                  spawn: (_file, args, spawnOptions) =>
                    spawn(process.execPath, [file, ...args], spawnOptions),
                }),
            },
          )
        : undefined;
    const args =
      kind === 'claude' ? [`--mcp-config=${mcp}`, '--settings', settings] : (prepared?.args ?? []);
    const bootstrap =
      'process.stdin.setRawMode=()=>process.stdin;process.argv=[process.execPath,process.env.FAKE_TOOL,...JSON.parse(process.env.FAKE_ARGS)];await import(process.env.FAKE_TOOL);';
    const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
      cwd: folder,
      env: {
        PATH: process.env.PATH ?? '',
        FAKE_TOOL: pathToFileURL(file).href,
        FAKE_ARGS: JSON.stringify(args),
        FAKE_MCP_TOOL: 'probe_read',
        ...(prepared?.env ?? {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output: string[] = [];
    child.stdout.on('data', (data: Buffer) => output.push(data.toString()));
    child.stderr.on('data', (data: Buffer) => output.push(data.toString()));
    const ended = new Promise<void>((resolve) =>
      child.once('close', () => {
        resolve();
      }),
    );
    try {
      if (prepared !== undefined) expect(prepared.available).toBe(true);
      await vi.waitFor(() => {
        expect(endpoint.methods, output.join('')).toContain('tools/call');
      });
      const log = await vi.waitFor(() =>
        readFile(path.join(folder, `.fake-${kind}`, 'log.jsonl'), 'utf8'),
      );
      expect(log).not.toContain(token);
      expect(output.join('')).not.toContain(token);
      expect(JSON.stringify(child.spawnargs)).not.toContain(token);
    } finally {
      child.kill('SIGTERM');
      await ended;
      await endpoint.close();
      await rm(folder, { recursive: true, force: true });
    }
  },
);
