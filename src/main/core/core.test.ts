import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PARTIES } from '../../shared/api/surface';
import { CATALOG, DEFAULT_ADAPTER } from '../sessions/adapters';
import { createCore } from './core';
import type { Core, CoreConfig } from './core';
import { CALLERS, NO_DESKTOP } from './test-registry';

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
    vi.stubEnv('CORRALLM_CODEX_PATH', codex);
    vi.stubEnv('CORRALLM_CLAUDE_PATH', path.join(profile, 'no-claude'));
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
      value: {},
    });
    expect(await started.call('usage.get', {}, CALLERS.you)).toEqual({
      ok: true,
      value: { readings: [], rules: { codex: RULE } },
    });
    expect(
      await started.call('usage.setRule', { backend: 'codex', rule: null }, CALLERS.you),
    ).toEqual({
      ok: true,
      value: {},
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
      value: {},
    });
    expect(await started.call('usage.get', {}, CALLERS.you)).toEqual({
      ok: true,
      value: { readings: [{ backend: 'codex', windows, at: now, simulated: true }], rules: {} },
    });
    expect(
      await started.call('usage.simulate', { backend: 'codex', windows: null }, CALLERS.you),
    ).toEqual({
      ok: true,
      value: {},
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
