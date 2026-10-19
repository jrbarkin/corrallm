import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PARTIES } from '../../shared/api/surface';
import { CATALOG } from '../sessions/adapters';
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
