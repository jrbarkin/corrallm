import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Adapter } from './adapter';
import { ADAPTERS } from './adapters';
import { locate, parseAgentPaths } from './locate';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-locate-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

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
  'finds normally when the override is %s, once per adapter and environment',
  async (value) => {
    const source = ADAPTERS[0];
    if (!source) throw new Error('No adapters');
    const find = vi.fn<NonNullable<Adapter['find']>>().mockResolvedValue('/found');
    const adapter = { ...source, find };
    const env = { PATH: '/bin' };
    vi.stubEnv('CORRALLM_AGENT_PATHS', value);
    await expect(locate(adapter, env)).resolves.toBe('/found');
    await expect(locate(adapter, env)).resolves.toBe('/found');
    expect(find).toHaveBeenCalledExactlyOnceWith(env);
  },
);

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
