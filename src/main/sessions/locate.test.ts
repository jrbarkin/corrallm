import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Adapter } from './adapter';
import { ADAPTERS } from './adapters';
import { findExecutable } from './executables';
import { locate, parseAgentPaths } from './locate';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-locate-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

/** An executable named `name` at `folder`. */
async function install(folder: string, name = 'fake'): Promise<string> {
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, name);
  await writeFile(file, '#!/bin/sh\n');
  await chmod(file, 0o755);
  return file;
}

/** The first adapter, searching only the agents' PATH (never the user's own installs). */
function searching() {
  const source = ADAPTERS[0];
  if (!source) throw new Error('No adapters');
  const find = vi.fn<NonNullable<Adapter['find']>>((env) => findExecutable('fake', env));
  return { adapter: { ...source, find }, find };
}

it('uses only the JSON override, including when its executable is missing or its adapter is absent', async () => {
  const file = path.join(dir, 'fake');
  await writeFile(file, '#!/bin/sh\n');
  await chmod(file, 0o755);
  const source = ADAPTERS[0];
  if (!source) throw new Error('No adapters');
  const find = vi.fn<NonNullable<Adapter['find']>>().mockResolvedValue('/must-not-find');
  const adapter = { ...source, find };
  const env = { PATH: '/must-not-search' };
  vi.stubEnv('CORRALLM_AGENT_PATHS', JSON.stringify({ [source.descriptor.id]: file }));
  await expect(locate(adapter, env)).resolves.toBe(file);
  vi.stubEnv(
    'CORRALLM_AGENT_PATHS',
    JSON.stringify({ [source.descriptor.id]: path.join(dir, 'missing') }),
  );
  await expect(locate(adapter, env)).resolves.toBeUndefined();
  vi.stubEnv('CORRALLM_AGENT_PATHS', '{}');
  await expect(locate(adapter, env)).resolves.toBeUndefined();
  expect(find).not.toHaveBeenCalled();
});

it.each([undefined, ''])(
  'finds normally when the override is %s, once per adapter and environment while it can run',
  async (value) => {
    const file = await install(dir);
    const source = ADAPTERS[0];
    if (!source) throw new Error('No adapters');
    const find = vi.fn<NonNullable<Adapter['find']>>().mockResolvedValue(file);
    const adapter = { ...source, find };
    const env = { PATH: '/bin' };
    vi.stubEnv('CORRALLM_AGENT_PATHS', value);
    await expect(Promise.all([locate(adapter, env), locate(adapter, env)])).resolves.toEqual([
      file,
      file,
    ]);
    await expect(locate(adapter, env)).resolves.toBe(file);
    expect(find).toHaveBeenCalledExactlyOnceWith(env);
  },
);

it('searches again after a miss, so a CLI installed after it was missing is found', async () => {
  const { adapter, find } = searching();
  const env = { PATH: path.join(dir, 'bin') };
  vi.stubEnv('CORRALLM_AGENT_PATHS', undefined);
  await expect(locate(adapter, env)).resolves.toBeUndefined();
  const file = await install(path.join(dir, 'bin'));
  await expect(locate(adapter, env)).resolves.toBe(file);
  expect(find).toHaveBeenCalledTimes(2);
});

it('searches again after a lookup that failed', async () => {
  const { adapter, find } = searching();
  const env = { PATH: path.join(dir, 'bin') };
  const file = await install(path.join(dir, 'bin'));
  vi.stubEnv('CORRALLM_AGENT_PATHS', undefined);
  find.mockRejectedValueOnce(new Error('lookup failed'));
  await expect(locate(adapter, env)).rejects.toThrow('lookup failed');
  await expect(locate(adapter, env)).resolves.toBe(file);
  expect(find).toHaveBeenCalledTimes(2);
});

it('searches again once the executable it found is gone, so a moved install is followed', async () => {
  const { adapter, find } = searching();
  const env = { PATH: [path.join(dir, 'old'), path.join(dir, 'new')].join(path.delimiter) };
  const old = await install(path.join(dir, 'old'));
  vi.stubEnv('CORRALLM_AGENT_PATHS', undefined);
  await expect(locate(adapter, env)).resolves.toBe(old);
  await rm(old);
  const moved = await install(path.join(dir, 'new'));
  await expect(locate(adapter, env)).resolves.toBe(moved);
  expect(find).toHaveBeenCalledTimes(2);
  await rm(moved);
  await expect(locate(adapter, env)).resolves.toBeUndefined();
});

it('checks an overridden executable again after it was missing', async () => {
  const { adapter, find } = searching();
  const env = { PATH: '/must-not-search' };
  const file = path.join(dir, 'pinned', 'fake');
  vi.stubEnv('CORRALLM_AGENT_PATHS', JSON.stringify({ [adapter.descriptor.id]: file }));
  await expect(locate(adapter, env)).resolves.toBeUndefined();
  await install(path.join(dir, 'pinned'));
  await expect(locate(adapter, env)).resolves.toBe(file);
  expect(find).not.toHaveBeenCalled();
});

it.each([
  'not-json',
  'null',
  '[]',
  '{"codex":42}',
  '{"codex":"relative"}',
  '{"-bad":"/bin/x"}',
  '{"codex":"/bin/x\\u0000"}',
])('refuses malformed executable overrides instead of falling back: %s', (value) => {
  expect(() => parseAgentPaths(value)).toThrow(/CORRALLM_AGENT_PATHS/);
});
