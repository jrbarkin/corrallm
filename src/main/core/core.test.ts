import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PARTIES } from '../../shared/api/surface';
import { newCanvasId } from '../../shared/canvas';
import type { RunContext } from '../../shared/run';
import { EXAMPLES } from '../../shared/examples';
import { isIf, isRepeat } from '../../shared/model/queue';
import type { QueueItem } from '../../shared/model/queue';
import type { Job } from '../../shared/adapter';
import { ADAPTERS, CATALOG, DEFAULT_ADAPTER } from '../sessions/adapters';
import { FakeConnector } from '../sessions/fake';
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

  it('reads the default adapter and the app consents the profile remembers', async () => {
    const consents = { codex: { plan: true }, 'old-adapter': { allowed: true } };
    await writeFile(
      path.join(profile, 'settings.json'),
      JSON.stringify({ version: 2, consents, api: { port: 12345 } }),
    );
    const started = await start();
    expect(await started.call('settings.get', {}, CALLERS['outside-read'])).toEqual({
      ok: true,
      value: { defaultAdapter: DEFAULT_ADAPTER, consents },
    });
  });

  it('starts with no app consents in a new profile', async () => {
    const started = await start();
    expect(await started.call('settings.get', undefined, CALLERS.you)).toEqual({
      ok: true,
      value: { defaultAdapter: DEFAULT_ADAPTER, consents: {} },
    });
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
  const CHECKPOINT = {
    version: 2,
    state: '{"paused":true}',
    messages: '{"version":1,"agents":[]}',
    updatedAt: 1,
  } as const;

  it('opens the profile’s database, and closes it last, after all it journaled', async () => {
    const started = await start({ connectors: {}, environment: () => Promise.resolve({}) });
    // A window's canvas, a draft, its run journaled.
    const run = (await started.channels.call(7, 'run:get', [])) as RunContext;
    await started.channels.call(7, 'run:save', [run.token, CHECKPOINT]);
    expect(journaledRun(profile, run.id)).toEqual(CHECKPOINT);
    await started.close();
    core = undefined;
    // Closed: its log checkpointed into it and gone, and a snapshot taken of what it kept.
    expect(existsSync(path.join(profile, `${STORE_FILE}-wal`))).toBe(false);
    const [snapshot] = await snapshots(profile);
    if (snapshot === undefined) throw new Error('No snapshot was taken as it closed.');
    const copy = connect(snapshot, { readOnly: true });
    try {
      expect(copy.prepare('SELECT canvas_id FROM run').all()).toEqual([{ canvas_id: run.id }]);
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
    await expect(started.channels.call(7, 'run:get', [])).rejects.toThrow(why);
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
