import { afterEach, describe, expect, it } from 'vitest';

import type { AgentNode } from '../model/canvas';
import type { UsageState } from '../usage';
import { MADE_UP } from '../test-made-up';
import { heldAsks } from './run/asks';
import { engineCatalog } from './catalog';
import { expectRestorable, liveRun } from './run/test-restore';
import type { RunIO } from './run/runner';
import { TEST_CATALOG } from './test-engine';

afterEach(expectRestorable);

/** The catalog main declares, read with Claude Code as the agent a node without one runs. */
const engine = engineCatalog(TEST_CATALOG, 'claude-code');

describe('engineCatalog', () => {
  it('runs an agent as its connection, else its adapter’s first, its adapter the default if none', () => {
    expect(engine.connectionOf({})).toBe('claude-code.terminal');
    expect(engine.connectionOf({ connection: 'claude-code.sdk' })).toBe('claude-code.sdk');
    expect(engine.connectionOf({ adapter: 'codex' })).toBe('codex.terminal');
    expect(engine.connectionOf({ adapter: 'codex', connection: 'codex.app-server' })).toBe(
      'codex.app-server',
    );
  });

  it.each([
    [{ adapter: 'codex', connection: 'claude-code.sdk' }],
    [{ connection: 'codex.terminal' }],
    [{ adapter: 'codex', connection: 'unavailable' }],
    [{ adapter: 'qwen' }],
    [{ adapter: 'toString' }],
    [{ adapter: 'constructor', connection: 'constructor' }],
  ])('runs %o as Not connected: its adapter lacks that connection, or the catalog it', (agent) => {
    expect(engine.connectionOf(agent)).toBe('unavailable');
  });

  it('says which adapter runs a connection, unavailable for one the catalog lacks', () => {
    expect(engine.adapterOf('claude-code.sdk')).toBe('claude-code');
    expect(engine.adapterOf('codex.app-server')).toBe('codex');
    expect(engine.adapterOf('unavailable')).toBe('unavailable');
    expect(engine.adapterOf('qwen.acp')).toBe('unavailable');
    expect(engine.adapterOf('toString')).toBe('unavailable');
  });

  it('gives an agent its adapter’s actions, as the catalog declares them; none for one it lacks', () => {
    for (const adapter of TEST_CATALOG.adapters) {
      expect(engine.actionsOf({ adapter: adapter.id })).toEqual(adapter.actions);
    }
    expect(engine.actionsOf({})).toEqual(engine.actionsOf({ adapter: 'claude-code' }));
    expect(engine.actionsOf({ adapter: 'qwen' })).toEqual([]);
    expect(engine.actionsOf({ adapter: 'hasOwnProperty' })).toEqual([]);
  });

  it('spends the usage backend its connection declares', () => {
    expect(engine.usageBackendOf({})).toBe('claude-code');
    expect(
      engine.usageBackendOf({ adapter: 'claude-code', connection: 'claude-code.terminal' }),
    ).toBe('claude-code');
    expect(engine.usageBackendOf({ adapter: 'codex' })).toBe('codex');
    expect(engine.usageBackendOf({ adapter: 'codex', connection: 'codex.app-server' })).toBe(
      'codex',
    );
    expect(engine.usageBackendOf({ adapter: 'gemini' })).toBeUndefined();
  });

  it('spends none for an Agent SDK agent: an API key has no usage windows', () => {
    expect(
      engine.usageBackendOf({ adapter: 'claude-code', connection: 'claude-code.sdk' }),
    ).toBeUndefined();
  });

  it('names a connection as the catalog does; nothing for one it lacks', () => {
    expect(engine.connectionLabel('claude-code.terminal')).toBe('Terminal');
    expect(engine.connectionLabel('claude-code.sdk')).toBe('Agent SDK');
    expect(engine.connectionLabel('codex.app-server')).toBe('App Server');
    expect(engine.connectionLabel('unavailable')).toBeUndefined();
    expect(engine.connectionLabel('qwen.acp')).toBeUndefined();
  });

  it('names a connection in full, with its adapter, as a refusal says it', () => {
    expect(engine.connectionName('codex.terminal')).toBe('Codex · Terminal');
    expect(engine.connectionName('claude-code.sdk')).toBe('Claude Code · Agent SDK');
    expect(engine.connectionName('unavailable')).toBeUndefined();
    expect(engine.isTerminal('codex.terminal')).toBe(true);
    expect(engine.isTerminal('claude-code.terminal')).toBe(true);
    expect(engine.isTerminal('codex.app-server')).toBe(false);
    expect(engine.isTerminal('unavailable')).toBe(false);
  });

  it('gives the text each connection runs as a shell command when a message starts with it', () => {
    expect(engine.shellPrefix('claude-code.terminal')).toBe('!');
    expect(engine.shellPrefix('codex.terminal')).toBe('!');
    // The Agent SDK and the App Server run no shell command from a message's text.
    expect(engine.shellPrefix('claude-code.sdk')).toBeUndefined();
    expect(engine.shellPrefix('codex.app-server')).toBeUndefined();
    expect(engine.shellPrefix('unavailable')).toBeUndefined();
  });

  it('names a usage backend as the catalog does; by its id, for one it lacks', () => {
    expect(engine.backendName('claude-code')).toBe('Claude');
    expect(engine.backendName('codex')).toBe('Codex');
    expect(engine.backendName('gemini')).toBe('gemini');
  });

  it('starts a connection in a mode only where it lists it, and the mode asks', () => {
    expect(engine.isStartMode('claude-code.terminal', 'plan')).toBe(true);
    expect(engine.isStartMode('claude-code.sdk', 'manual')).toBe(true);
    expect(engine.isStartMode('codex.app-server', 'plan')).toBe(true);
    // Codex's Terminal starts only in Read only; Plan is chosen in its terminal.
    expect(engine.isStartMode('codex.terminal', 'read-only')).toBe(true);
    expect(engine.isStartMode('codex.terminal', 'plan')).toBe(false);
    // Never one that never asks, nor another adapter's.
    expect(engine.isStartMode('claude-code.terminal', 'bypassPermissions')).toBe(false);
    expect(engine.isStartMode('codex.app-server', 'full-access')).toBe(false);
    expect(engine.isStartMode('codex.app-server', 'acceptEdits')).toBe(false);
    expect(engine.isStartMode('unavailable', 'plan')).toBe(false);
    expect(engine.isStartMode('qwen.acp', 'plan')).toBe(false);
  });

  it('says a session acts without asking only in a mode its adapter lists that never asks', () => {
    expect(engine.neverAsks('claude-code.sdk', 'bypassPermissions')).toBe(true);
    expect(engine.neverAsks('claude-code.terminal', 'bypassPermissions')).toBe(true);
    expect(engine.neverAsks('codex.app-server', 'full-access')).toBe(true);
    expect(engine.neverAsks('claude-code.sdk', 'acceptEdits')).toBe(false);
    expect(engine.neverAsks('codex.app-server', 'auto')).toBe(false);
    // Nor another adapter's, nor one on a connection the catalog lacks.
    expect(engine.neverAsks('codex.app-server', 'bypassPermissions')).toBe(false);
    expect(engine.neverAsks('unavailable', 'full-access')).toBe(false);
    expect(engine.neverAsks('qwen.acp', 'yolo')).toBe(false);
  });

  it('runs a queue with whatever adapter the catalog declares, wording steps from it', () => {
    const sent: [string, string][] = [];
    const store = liveRun(engineCatalog(MADE_UP, 'zed'), {
      send: (to, text) => {
        sent.push([to.id, text]);
        return () => undefined;
      },
      tell: () => undefined,
      connect: () => undefined,
      later: () => () => undefined,
      now: () => 0,
    });
    const agent = (id: string, adapter?: string): AgentNode => ({
      id,
      type: 'agent',
      position: { x: 0, y: 0 },
      data: {
        label: id,
        ...(adapter === undefined ? {} : { adapter }),
        queue: [{ id: 'run', action: 'shell' }],
      },
    });
    store.update([agent('zed'), agent('claude', 'claude-code')]);
    store.start();
    expect(sent).toEqual([
      ['zed', expect.stringMatching(/^Use the shell tool .*\(run a command\)/)],
    ]);
    // An adapter the catalog lacks is Not connected, whatever the renderer's own tables say.
    expect(store.snapshot().agents.claude).toMatchObject({
      status: 'asking',
      refused: { agent: 'claude', connection: 'unavailable' },
    });
  });

  it('reads whatever adapter the catalog declares, and only that', () => {
    const zed = engineCatalog(MADE_UP, 'zed');
    expect(zed.connectionOf({})).toBe('zed.acp');
    expect(zed.connectionOf({ connection: 'zed.free' })).toBe('zed.free');
    expect(zed.connectionOf({ adapter: 'claude-code' })).toBe('unavailable');
    expect(zed.adapterOf('zed.free')).toBe('zed');
    expect(zed.actionsOf({})).toEqual([
      { name: 'shell', description: 'Run a command', job: 'shell' },
    ]);
    expect(zed.usageBackendOf({})).toBe('zed');
    expect(zed.usageBackendOf({ connection: 'zed.free' })).toBeUndefined();
    expect(zed.connectionLabel('zed.acp')).toBe('ACP');
    expect(zed.connectionLabel('claude-code.terminal')).toBeUndefined();
    expect(zed.backendName('zed')).toBe('Zed');
    expect(zed.backendName('claude-code')).toBe('claude-code');
    expect(zed.isStartMode('zed.acp', 'plan')).toBe(true);
    expect(zed.isStartMode('zed.acp', 'auto')).toBe(false);
    expect(zed.isStartMode('zed.free', 'plan')).toBe(false);
    expect(zed.isStartMode('claude-code.terminal', 'plan')).toBe(false);
    expect(zed.neverAsks('zed.acp', 'auto')).toBe(true);
    expect(zed.neverAsks('zed.acp', 'plan')).toBe(false);
    expect(zed.neverAsks('claude-code.terminal', 'bypassPermissions')).toBe(false);
  });

  it('words a usage rule’s warning and hold with the backend the catalog it is given names', () => {
    const zed = engineCatalog(MADE_UP, 'zed');
    const told: string[] = [];
    const timers: (() => void)[] = [];
    let usage: UsageState = {
      readings: [
        { backend: 'zed', at: 0, windows: { fiveHour: { usedPercent: 85, resetsAt: null } } },
      ],
      rules: { zed: { window: 'fiveHour', percent: 80, action: 'warn' } },
    };
    const io: RunIO = {
      send: () => () => undefined,
      tell: (_, text) => {
        told.push(text);
      },
      connect: () => undefined,
      later: (run) => {
        timers.push(run);
        return () => undefined;
      },
      now: () => 0,
      usage: () => usage,
    };
    const nodes: AgentNode[] = [
      {
        id: 'zed',
        type: 'agent',
        position: { x: 0, y: 0 },
        data: { label: 'Zed', queue: [{ id: 'run', action: 'shell' }] },
      },
    ];
    const warned = liveRun(zed, io);
    warned.update(nodes);
    warned.start();
    for (const run of timers.splice(0)) run();
    expect(told).toEqual(['Zed has used 85% of its 5-hour window (over 80%).']);

    usage = { ...usage, rules: { zed: { window: 'fiveHour', percent: 80, action: 'ask' } } };
    const asking = liveRun(zed, io);
    asking.update(nodes);
    asking.start();
    const [ask] = heldAsks(nodes, asking.snapshot(), zed);
    expect(ask?.text).toBe('Zed has used 85% of its 5-hour window (over 80%). Go on?');
    expect(ask?.choices[0]?.title).toBe('Every Zed agent carries on until the window resets');
  });
});
