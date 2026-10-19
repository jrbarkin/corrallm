import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type * as os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { directory, execFileSync } = vi.hoisted(() => ({
  directory: { root: '' },
  execFileSync: vi.fn<(command: string, args: string[]) => void>(),
}));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof os>()),
  tmpdir: () => directory.root,
}));
vi.mock('node:child_process', () => ({ execFileSync }));

const { version } = createRequire(import.meta.url)('electron/package.json') as { version: string };
const REQUIRED = [
  'Contents/MacOS/Electron',
  'Contents/Info.plist',
  'Contents/PkgInfo',
  'Contents/Resources/default_app.asar',
  'Contents/_CodeSignature/CodeResources',
];
let bundle: string;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal('process', { ...process, platform: 'darwin' });
  const actual = await vi.importActual<typeof os>('node:os');
  directory.root = await mkdtemp(path.join(actual.tmpdir(), 'corrallm-agent-cache-'));
  bundle = path.join(directory.root, `corrallm-e2e-electron-${version}`, 'Electron.app');
  const source = path.join(directory.root, 'source.app');
  for (const file of REQUIRED) {
    const target = path.join(source, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, 'stand-in');
  }
  cpSync(source, bundle, { recursive: true });
  // Copy/sign are OS tools; the test drives their file effects without launching an app.
  execFileSync.mockImplementation((command, args) => {
    if (command === 'cp') cpSync(source, args[2] ?? '', { recursive: true });
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory.root, { recursive: true, force: true });
});

it.each(REQUIRED)(
  'refuses an Electron cache missing %s and rebuilds it before launch',
  async (missing) => {
    await rm(path.join(bundle, missing));
    const { agentElectronExecutable, makeAgentElectron } = await import('../../e2e/agent-electron');
    expect(agentElectronExecutable()).toBeUndefined();
    makeAgentElectron();
    expect(agentElectronExecutable()).toBe(path.join(bundle, 'Contents/MacOS/Electron'));
  },
);

it('reuses a complete signed Electron cache', async () => {
  const { agentElectronExecutable, makeAgentElectron } = await import('../../e2e/agent-electron');
  expect(agentElectronExecutable()).toBe(path.join(bundle, 'Contents/MacOS/Electron'));
  makeAgentElectron();
  expect(execFileSync).not.toHaveBeenCalled();
});
