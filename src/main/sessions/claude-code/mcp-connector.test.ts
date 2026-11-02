import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { TerminalConnector } from './connector';
import { FakeClaude } from './fake-claude';
import type { HostEvent, LiveSession } from '../connector';
import { testMcpServer } from '../test-mcp';

it('its Terminal fake lists and calls the private entry and closing removes its credential file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'corrallm-entry-'));
  const token = 'terminal-credential-canary';
  const endpoint = await testMcpServer(token);
  let session: LiveSession | undefined;
  let fake: FakeClaude | undefined;
  const events: HostEvent[] = [];
  try {
    const connector = new TerminalConnector({
      findClaude: () => Promise.resolve('/not-run'),
      home: dir,
      managed: path.join(dir, 'managed'),
      tmp: dir,
      timing: { kill: 20 },
      spawn: (file, args, options) => {
        fake = new FakeClaude(file, args, options, { exitOnCtrlC: 1 });
        return Promise.resolve(fake);
      },
    });
    session = await connector.start(
      {
        agentId: 'agent-not-a-native-path',
        cwd: dir,
        env: {
          HOME: dir,
          FAKE_MCP_TOOL: 'probe_read',
          CORRALLM_SESSION_TOKEN: 'discarded-inherited-token',
        },
        model: null,
        mode: null,
        resume: null,
        api: {
          kind: 'http',
          server: 'corrallm',
          url: endpoint.url,
          token,
          tools: [{ name: 'probe_read', destructive: false }],
          off: ['corrallm-server', 'corrallm-server-dev'],
        },
      },
      { emit: (event) => events.push(event), remember: () => undefined },
    );
    if (fake === undefined) throw new Error('No fake');
    await fake.apiReady;
    expect(endpoint.methods).toContain('tools/call');
    expect(events.find((one) => one.type === 'started')).toMatchObject({ api: true });
    expect(fake.options.env.CORRALLM_SESSION_TOKEN).toBeUndefined();
    expect(JSON.stringify([fake.args, fake.options.env, events])).not.toContain(token);
    expect(JSON.stringify(fake.args)).not.toContain('agent-not-a-native-path');
    const file = fake.arg('--mcp-config');
    if (file === undefined) throw new Error('No entry file');
    expect(await readFile(file, 'utf8')).toContain(token);
    await session.close();
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await session?.close();
    await endpoint.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('retries a native sideload refusal once with the private entry removed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'corrallm-entry-'));
  const token = 'retry-credential-canary';
  const runs: FakeClaude[] = [];
  const events: HostEvent[] = [];
  let session: LiveSession | undefined;
  try {
    const connector = new TerminalConnector({
      findClaude: () => Promise.resolve('/not-run'),
      home: dir,
      managed: path.join(dir, 'managed'),
      tmp: dir,
      timing: { kill: 20 },
      spawn: async (file, args, options) => {
        const run = new FakeClaude(file, args, options, {
          exitOnCtrlC: 1,
          ...(runs.length === 0
            ? {
                startupRefusal:
                  'You cannot dynamically configure MCP servers when an enterprise MCP config is present',
              }
            : {}),
        });
        runs.push(run);
        return Promise.resolve(run);
      },
    });
    session = await connector.start(
      {
        agentId: 'a',
        cwd: dir,
        env: { HOME: dir },
        model: null,
        mode: null,
        resume: null,
        api: {
          kind: 'http',
          server: 'corrallm',
          url: 'http://127.0.0.1:1/mcp',
          token,
          tools: [],
          off: ['corrallm-server', 'corrallm-server-dev'],
        },
      },
      { emit: (event) => events.push(event), remember: () => undefined },
    );
    await vi.waitFor(() => {
      expect(runs).toHaveLength(2);
    });
    expect(runs[0]?.arg('--mcp-config')).toBeDefined();
    expect(runs[1]?.arg('--mcp-config')).toBeUndefined();
    expect(
      events.filter((one) => one.type === 'notice' && one.text.includes('API is off')),
    ).toHaveLength(1);
    expect(events.filter((one) => one.type === 'started')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(token);
  } finally {
    await session?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
