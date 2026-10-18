import { describe, expect, it } from 'vitest';

import type { Catalog } from '../../shared/adapter';
import type { AgentNode } from '../../shared/model/canvas';
import { catalog } from '../catalog';
import { engineCatalog } from './catalog';
import { RunStore } from './runner';

/** The catalog main declares, read with Claude Code as the agent a node without one runs. */
const engine = engineCatalog(catalog(), 'claude-code');

/** An adapter no build has, declared only here: the run knows it from the catalog alone. */
const MADE_UP: Catalog = {
  adapters: [
    {
      id: 'zed',
      name: 'Zed Agent',
      accent: 0,
      words: { defaults: '' },
      modes: [],
      runtimeModes: false,
      role: 'none',
      resume: false,
      list: false,
      actions: [{ name: 'shell', description: 'Run a command', job: 'shell' }],
      connections: [
        {
          id: 'zed.acp',
          label: 'ACP',
          short: 'ACP',
          description: '',
          view: 'transcript',
          startModes: [],
          live: { effort: false, stopTask: false },
          panels: {},
          images: null,
          usage: 'zed',
        },
        {
          id: 'zed.free',
          label: 'Free',
          short: 'Free',
          description: '',
          view: 'transcript',
          startModes: [],
          live: { effort: false, stopTask: false },
          panels: {},
          images: null,
          usage: null,
        },
      ],
    },
  ],
  usageBackends: [{ id: 'zed', label: 'Zed', source: '', windows: [] }],
};

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
    for (const adapter of catalog().adapters) {
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

  it('runs a queue with whatever adapter the catalog declares, wording steps from it', () => {
    const sent: [string, string][] = [];
    const store = new RunStore(engineCatalog(MADE_UP, 'zed'), {
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
  });
});
