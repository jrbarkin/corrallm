import { legacyDirectories } from './workspaces/test-directories';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toolName } from '../../shared/api/registry';
import { PARTIES } from '../../shared/api/surface';
import { newCanvasId } from '../../shared/canvas';
import { EXAMPLES } from '../../shared/examples';
import { isIf, isRepeat } from '../../shared/model/queue';
import type { QueueItem } from '../../shared/model/queue';
import type { Job } from '../../shared/adapter';
import { listTools } from '../api/mcp';
import { ADAPTERS, CATALOG } from '../sessions/adapters';
import { FakeConnector } from '../sessions/fake';
import { Settings } from '../settings';
import { createCore } from './core';
import type { Core, CoreConfig } from './core';
import { STORE_FILE } from './store/open';
import { snapshots } from './store/snapshots';
import { connect } from './store/sqlite';
import {
  journaledRun,
  keepCanvases,
  openTestStore,
  readOnDisk,
  writeOnDisk,
} from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';
import { asHuman, WindowPorts } from './gui';
import { openWindow } from './test-window';

const READING = {
  backend: 'codex',
  windows: { fiveHour: { usedPercent: 42, resetsAt: null } },
  at: 1000,
};
const RULE = { window: 'weekly', percent: 80, action: 'ask' };

let profile: string;
let core: Core | undefined;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-core-'));
});

afterEach(async () => {
  await core?.close();
  core = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(profile, { recursive: true, force: true });
});

async function start(sessions?: CoreConfig['sessions']): Promise<Core> {
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
      ...(sessions === undefined ? {} : { sessions }),
    },
    NO_DESKTOP,
  );
  return core;
}

describe('createCore', () => {
  it('checks saved conversation ids with the registry’s stricter adapter shape', async () => {
    const nativeId = 'session:one';
    const adapter = ADAPTERS.find((adapter) => !adapter.isConversationId(nativeId));
    if (adapter === undefined) throw new Error('No adapter with a stricter id shape');
    const canvas = newCanvasId();
    const file = path.join(profile, 'strict-ids.corral');
    await writeFile(
      file,
      JSON.stringify({ format: 'corrallm', version: 2, id: canvas, nodes: [], links: [] }),
    );
    await keepCanvases(profile, {
      [canvas]: {
        file,
        project: profile,
        conversations: { [adapter.descriptor.id]: { a: { id: nativeId } } },
      },
    });
    const said = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const started = await start({ connectors: {}, environment: () => Promise.resolve({}) });
    await expect(started.keptCanvas(file)).resolves.toBe(canvas);
    expect(said.mock.calls.flat().join(' ')).toContain(
      'conversation id is invalid; it will not be resumed',
    );
  });
  it('refuses a malformed executable map before opening the profile', async () => {
    vi.stubEnv('CORRALLM_AGENT_PATHS', 'not JSON');
    await expect(start()).rejects.toThrow(/CORRALLM_AGENT_PATHS/);
    expect(existsSync(path.join(profile, STORE_FILE))).toBe(false);
  });
  it('lists each shipped template’s fields and agent roles with the jobs of all their steps', async () => {
    const started = await start({ connectors: {}, environment: () => Promise.resolve({}) });
    const jobs = (queue: QueueItem[]): Job[] => [
      ...new Set(
        queue.flatMap((item): Job[] => {
          if (isIf(item)) return jobs(item.then);
          if (isRepeat(item)) return jobs(item.repeat);
          if (!('action' in item)) return [];
          const job = CATALOG.adapters
            .flatMap((adapter) => adapter.actions)
            .find((action) => action.name === item.action)?.job;
          return job === undefined ? [] : [job];
        }),
      ),
    ];
    const expected = EXAMPLES.map((example) => {
      const blanks = [
        ...new Set([...example.text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1])),
      ].sort();
      expect((example.fields ?? []).map((field) => field.key).sort()).toEqual(blanks);
      const file = JSON.parse(example.text) as {
        id: string;
        nodes: { id: string; kind: string; label: string; adapter?: string; queue?: QueueItem[] }[];
      };
      return {
        id: file.id,
        name: example.name,
        description: example.description,
        fields: example.fields ?? [],
        agents: file.nodes
          .filter((node) => node.kind === 'agent')
          .map((node) => ({
            id: node.id,
            name: node.label,
            ...(node.adapter === undefined ? {} : { adapter: node.adapter }),
            jobs: jobs(node.queue ?? []),
          })),
      };
    });
    expect(await started.call('templates.list', {}, CALLERS['outside-read'])).toEqual({
      ok: true,
      value: { items: expected },
    });
    expect(expected.flatMap((item) => item.agents).some((agent) => !('adapter' in agent))).toBe(
      true,
    );
    expect(expected.flatMap((item) => item.fields).length).toBeGreaterThan(0);
  });

  it('serves both catalog operations on a window’s port', async () => {
    vi.stubEnv(
      'CORRALLM_AGENT_PATHS',
      JSON.stringify({
        codex: path.join(profile, 'no-codex'),
        'claude-code': path.join(profile, 'no-claude'),
      }),
    );
    const started = await start({ connectors: {}, environment: () => Promise.resolve({}) });
    const window = openWindow(new WindowPorts(started), 1);
    try {
      for (const name of ['catalog.get', 'catalog.installed'] as const) {
        const result = await started.call(name, {}, CALLERS.you);
        expect(result.ok).toBe(true);
        expect(await window.link.request('call', name, {})).toEqual({ ok: true, value: result });
      }
    } finally {
      window.close();
    }
  });

  it('says which app it is, to every party', async () => {
    const started = await start();
    for (const party of PARTIES) {
      expect(await started.call('app.info', {}, CALLERS[party])).toEqual({
        ok: true,
        value: { name: 'corrallm', version: '9.8.7' },
      });
    }
  });

  it('reports every catalog adapter as installed or missing in the agents’ environment', async () => {
    const codex = path.join(profile, 'codex.mjs');
    await copyFile(path.join(import.meta.dirname, '../sessions/codex/fake-codex.mjs'), codex);
    await chmod(codex, 0o755);
    vi.stubEnv(
      'CORRALLM_AGENT_PATHS',
      JSON.stringify({ codex: codex, 'claude-code': path.join(profile, 'no-claude') }),
    );
    const started = await start({
      connectors: {},
      environment: () => Promise.resolve({ PATH: path.dirname(process.execPath) }),
    });
    const result = await started.call('catalog.installed', {}, CALLERS.you);
    expect(result).toEqual({ ok: true, value: { 'claude-code': false, codex: true } });
    if (!result.ok) throw new Error(result.error.sentence);
    expect(Object.keys(result.value).sort()).toEqual(
      CATALOG.adapters.map((adapter) => adapter.id).sort(),
    );
  });

  it('reads the default agent and the app consents the profile remembers', async () => {
    const consents = { codex: { plan: true }, 'old-adapter': { allowed: true } };
    await writeFile(
      path.join(profile, 'settings.json'),
      JSON.stringify({ version: 2, consents, api: { port: 12345 }, defaultAdapter: 'codex' }),
    );
    const started = await start();
    expect(await started.call('settings.get', {}, CALLERS['outside-read'])).toEqual({
      ok: true,
      value: {
        defaultAdapter: 'codex',
        consents,
        api: { state: 'stopped', port: 12345 },
      },
    });
  });

  it('serves a saved default agent this build lacks as it is: the window treats it as none', async () => {
    await writeFile(
      path.join(profile, 'settings.json'),
      JSON.stringify({ version: 2, consents: {}, defaultAdapter: 'zed' }),
    );
    const started = await start();
    expect(await started.call('settings.get', {}, CALLERS.you)).toMatchObject({
      ok: true,
      value: { defaultAdapter: 'zed' },
    });
  });

  it('starts with no app consents and no default agent in a new profile', async () => {
    const started = await start();
    expect(await started.call('settings.get', undefined, CALLERS.you)).toEqual({
      ok: true,
      value: {
        defaultAdapter: null,
        consents: {},
        api: { state: 'stopped', port: null },
      },
    });
  });

  it('says whether the MCP server listens, as its owner says, a change of the settings topic', async () => {
    const started = await start();
    const window = openWindow(new WindowPorts(started), 7);
    const heard: unknown[] = [];
    window.link.on('topic', (batch) => {
      for (const change of batch)
        if (change.topic === 'settings' && 'replace' in change) heard.push(change.replace);
    });
    try {
      await window.link.request('call', 'topics.subscribe', { topic: 'settings' });
      const listening = {
        state: 'listening',
        port: 4242,
        url: 'http://127.0.0.1:4242/mcp',
      } as const;
      started.served(listening);
      expect(await started.call('settings.get', {}, CALLERS.you)).toMatchObject({
        ok: true,
        value: { api: listening },
      });
      await vi.waitFor(() => {
        expect(heard).toEqual([expect.objectContaining({ api: listening })]);
      });
      const taken = { state: 'unavailable', port: 4242, sentence: 'Port 4242 is taken.' } as const;
      started.served(taken);
      await vi.waitFor(() => {
        expect(heard.at(-1)).toEqual(expect.objectContaining({ api: taken }));
      });
    } finally {
      window.close();
    }
  });

  it('reads the usage readings and rules the profile remembers', async () => {
    await writeFile(
      path.join(profile, 'usage.json'),
      JSON.stringify({ version: 2, readings: [READING], rules: { codex: RULE } }),
    );
    const started = await start();
    for (const party of PARTIES) {
      expect(await started.call('usage.get', {}, CALLERS[party])).toEqual({
        ok: true,
        value: { readings: [READING], rules: { codex: RULE } },
      });
    }
  });

  it('sets and removes a usage rule through usage.setRule, reflected by usage.get', async () => {
    const started = await start();
    expect(
      await started.call('usage.setRule', { backend: 'codex', rule: RULE }, CALLERS.you),
    ).toEqual({
      ok: true,
      value: { revs: {} },
    });
    expect(await started.call('usage.get', {}, CALLERS.you)).toEqual({
      ok: true,
      value: { readings: [], rules: { codex: RULE } },
    });
    expect(
      await started.call('usage.setRule', { backend: 'codex', rule: null }, CALLERS.you),
    ).toEqual({
      ok: true,
      value: { revs: {} },
    });
    expect(await started.call('usage.get', {}, CALLERS.you)).toEqual({
      ok: true,
      value: { readings: [], rules: {} },
    });
  });

  it('sets and forgets a simulated reading through usage.simulate, reflected by usage.get', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const windows = {
      fiveHour: { usedPercent: 95, resetsAt: now + 60 * 60 * 1000 },
      weekly: { usedPercent: 50, resetsAt: null },
    };
    const started = await start();
    expect(
      await started.call('usage.simulate', { backend: 'codex', windows }, CALLERS.you),
    ).toEqual({
      ok: true,
      value: { revs: {} },
    });
    expect(await started.call('usage.get', {}, CALLERS.you)).toEqual({
      ok: true,
      value: { readings: [{ backend: 'codex', windows, at: now, simulated: true }], rules: {} },
    });
    expect(
      await started.call('usage.simulate', { backend: 'codex', windows: null }, CALLERS.you),
    ).toEqual({
      ok: true,
      value: { revs: {} },
    });
    expect(await started.call('usage.get', {}, CALLERS.you)).toEqual({
      ok: true,
      value: { readings: [], rules: {} },
    });
  });

  it.each([
    ['usage.setRule', { backend: 'missing', rule: RULE }],
    ['usage.setRule', { backend: 'codex', rule: { ...RULE, percent: 100 } }],
    ['usage.simulate', { backend: 'missing', windows: READING.windows }],
    [
      'usage.simulate',
      { backend: 'codex', windows: { fiveHour: { usedPercent: 101, resetsAt: null } } },
    ],
    [
      'usage.simulate',
      { backend: 'codex', windows: { fiveHour: { usedPercent: 50, resetsAt: -1 } } },
    ],
    [
      'usage.simulate',
      {
        backend: 'codex',
        windows: { fiveHour: { usedPercent: 50, resetsAt: Date.now() + 30 * 86_400_000 } },
      },
    ],
  ] as const)(
    '%s refuses an invalid usage write without changing the state: %j',
    async (name, args) => {
      const started = await start();
      expect(await started.call(name, args, CALLERS.you)).toMatchObject({
        ok: false,
        error: { code: 'invalid' },
      });
      expect(await started.call('usage.get', {}, CALLERS.you)).toEqual({
        ok: true,
        value: { readings: [], rules: {} },
      });
    },
  );

  it('starts with no readings in a new profile, and refuses arguments neither op takes', async () => {
    const started = await start();
    expect(await started.call('usage.get', undefined, CALLERS.worker)).toEqual({
      ok: true,
      value: { readings: [], rules: {} },
    });
    expect(await started.call('app.info', { verbose: true }, CALLERS.you)).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    });
  });

  it('writes nothing it didn’t change when it closes', async () => {
    const started = await start();
    await started.close();
    core = undefined;
    await expect(readFile(path.join(profile, 'usage.json'), 'utf8')).rejects.toThrow(/ENOENT/);
  });
});

describe('the core’s database', () => {
  it('opens the profile’s database, and closes it last, after all it journaled', async () => {
    const started = await start({ connectors: {}, environment: () => Promise.resolve({}) });
    // A window's canvas, a draft, its run journaled.
    const shown = await started.call('window.get', {}, asHuman(7));
    if (!shown.ok) throw new Error(shown.error.sentence);
    const canvas = shown.value.canvas;
    await started.flush();
    expect(journaledRun(profile, canvas)).toBeDefined();
    await started.close();
    core = undefined;
    // Closed: its log checkpointed into it and gone, and a snapshot taken of what it kept.
    expect(existsSync(path.join(profile, `${STORE_FILE}-wal`))).toBe(false);
    const [snapshot] = await snapshots(profile);
    if (snapshot === undefined) throw new Error('No snapshot was taken as it closed.');
    const copy = connect(snapshot, { readOnly: true });
    try {
      expect(copy.prepare('SELECT canvas_id FROM run').all()).toEqual([{ canvas_id: canvas }]);
    } finally {
      copy.close();
    }
  });

  it('runs on a database it can’t open, journaling nothing and starting nothing, saying why', async () => {
    // A database a newer corrallm made, which this one can't read.
    await (await openTestStore(profile)).close();
    writeOnDisk(profile, 'UPDATE meta SET min_reader = 999');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const codex = new FakeConnector({ adapter: 'codex' });
    const started = await start({
      connectors: { 'codex.app-server': codex },
      environment: () => Promise.resolve({}),
    });
    const why = /made by a newer corrallm, which this one can’t read/;
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(why));
    expect(await started.call('app.info', {}, CALLERS.you)).toMatchObject({ ok: true });
    expect(await started.call('window.get', {}, asHuman(7))).toMatchObject({
      ok: false,
      error: { sentence: expect.stringMatching(why) as unknown },
    });
    expect(await started.call('canvas.create', {}, asHuman(7))).toMatchObject({
      ok: false,
      error: { sentence: expect.stringMatching(why) as unknown },
    });
    await expect(started.engines.open(newCanvasId())).rejects.toThrow(why);
    expect(codex.started).toEqual([]);
    await started.close();
    core = undefined;
    // Left as it was.
    expect(
      readOnDisk(profile, (disk) => disk.prepare('SELECT min_reader FROM meta').get()),
    ).toEqual({ min_reader: 999 });
  });
});

/** Whether a file's permissions can keep its owner from reading it: not on Windows, nor as root. */
const CAN_DENY = process.platform !== 'win32' && process.getuid?.() !== 0;

describe('settings.set: the default agent, yours alone (B12 C2)', () => {
  const file = () => path.join(profile, 'settings.json');
  /** A window subscribed to the settings topic: each state it is told. */
  async function watching(started: Core, id: number) {
    const window = openWindow(new WindowPorts(started), id);
    const heard: unknown[] = [];
    window.link.on('topic', (batch) => {
      for (const change of batch)
        if (change.topic === 'settings' && 'replace' in change) heard.push(change.replace);
    });
    await window.link.request('call', 'topics.subscribe', { topic: 'settings' });
    return { ...window, heard };
  }

  it('is listed for you alone, and refused to every token as human-only, changing nothing', async () => {
    const started = await start();
    for (const party of PARTIES.filter((one) => one !== 'you')) {
      const listed = listTools(started, CALLERS[party]).map((tool) => tool.name);
      expect(listed, party).not.toContain(toolName('settings.set'));
      for (const defaultAdapter of ['codex', null]) {
        expect(
          await started.call('settings.set', { defaultAdapter }, CALLERS[party]),
          party,
        ).toMatchObject({ ok: false, error: { code: 'human-only' } });
      }
    }
    expect(existsSync(file())).toBe(false);
    expect(await started.call('settings.get', {}, CALLERS.you)).toMatchObject({
      ok: true,
      value: { defaultAdapter: null },
    });
  });

  it('writes, then shows every window; refuses an id this build lacks; null removes it; the same writes nothing', async () => {
    const started = await start();
    const seven = await watching(started, 7);
    const eight = await watching(started, 8);
    try {
      expect(await seven.link.request('call', 'settings.set', { defaultAdapter: 'codex' })).toEqual(
        {
          ok: true,
          value: { ok: true, value: { defaultAdapter: 'codex', revs: { settings: 1 } } },
        },
      );
      for (const window of [seven, eight]) {
        await vi.waitFor(() => {
          expect(window.heard).toEqual([expect.objectContaining({ defaultAdapter: 'codex' })]);
        });
      }
      expect(await new Settings(file()).defaultAdapter()).toBe('codex');
      expect(await started.call('settings.get', {}, CALLERS['outside-read'])).toMatchObject({
        ok: true,
        value: { defaultAdapter: 'codex' },
      });

      // An id this build lacks: refused, and nothing changes.
      expect(await started.call('settings.set', { defaultAdapter: 'zed' }, CALLERS.you)).toEqual({
        ok: false,
        error: { code: 'invalid', sentence: 'There is no adapter zed in this build.' },
      });
      expect(await new Settings(file()).defaultAdapter()).toBe('codex');

      // The value it already has: no revision, nothing written (the file keeps its layout).
      const compact = JSON.stringify({ version: 2, consents: {}, defaultAdapter: 'codex' });
      await writeFile(file(), compact);
      expect(await started.call('settings.set', { defaultAdapter: 'codex' }, CALLERS.you)).toEqual({
        ok: true,
        value: { defaultAdapter: 'codex', revs: {} },
      });
      expect(await readFile(file(), 'utf8')).toBe(compact);

      // None: the field goes, and every window is told.
      expect(await started.call('settings.set', { defaultAdapter: null }, CALLERS.you)).toEqual({
        ok: true,
        value: { defaultAdapter: null, revs: { settings: 2 } },
      });
      expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({ version: 2, consents: {} });
      for (const window of [seven, eight]) {
        await vi.waitFor(() => {
          expect(window.heard.at(-1)).toEqual(expect.objectContaining({ defaultAdapter: null }));
        });
        expect(window.heard).toHaveLength(2);
      }
    } finally {
      seven.close();
      eight.close();
    }
  });

  it('refuses a failed write as unavailable, leaving the read and the topic as they were; the next write succeeds', async () => {
    const started = await start();
    const window = await watching(started, 7);
    try {
      // Its file a folder: written beside it, the move over it fails.
      await mkdir(file());
      await writeFile(path.join(file(), 'in-the-way'), '');
      expect(await started.call('settings.set', { defaultAdapter: 'codex' }, CALLERS.you)).toEqual({
        ok: false,
        error: {
          code: 'unavailable',
          sentence: 'corrallm couldn’t save your default agent; it is unchanged.',
        },
      });
      expect(await started.call('settings.get', {}, CALLERS.you)).toMatchObject({
        ok: true,
        value: { defaultAdapter: null },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(window.heard).toEqual([]);

      await rm(file(), { recursive: true });
      expect(await started.call('settings.set', { defaultAdapter: 'codex' }, CALLERS.you)).toEqual({
        ok: true,
        value: { defaultAdapter: 'codex', revs: { settings: 1 } },
      });
      expect(await new Settings(file()).defaultAdapter()).toBe('codex');
      await vi.waitFor(() => {
        expect(window.heard).toEqual([expect.objectContaining({ defaultAdapter: 'codex' })]);
      });
    } finally {
      window.close();
    }
  });

  it.skipIf(!CAN_DENY)(
    'refuses as unavailable when the settings can’t be read, never writing over them',
    async () => {
      const kept = `${JSON.stringify({ version: 2, consents: {}, defaultAdapter: 'codex' })}\n`;
      await writeFile(file(), kept);
      await chmod(file(), 0);
      const started = await start();
      try {
        expect(await started.call('settings.set', { defaultAdapter: null }, CALLERS.you)).toEqual({
          ok: false,
          error: {
            code: 'unavailable',
            sentence: 'corrallm couldn’t read your settings, so your default agent is unchanged.',
          },
        });
      } finally {
        await chmod(file(), 0o600);
      }
      expect(await readFile(file(), 'utf8')).toBe(kept);
    },
  );
});
