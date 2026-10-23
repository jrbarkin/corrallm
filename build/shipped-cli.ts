import { chmod, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { copyNativeModule, NATIVE_MODULES } from './native-modules';
import { NODE_VERSION, nodeRelease, stageNode } from './node-runtime';
import type { NodeRelease } from './node-runtime';

export const LINUX_CLI_BIN = 'resources/bin/corrallm';

/** afterCopy's buildPath is Resources/app, before ASAR packing. Its sibling files stay plain. */
export async function shipCli(
  buildPath: string,
  platform: string,
  arch: string,
  {
    project = path.resolve(import.meta.dirname, '..'),
    stageRuntime,
  }: {
    project?: string;
    stageRuntime?: (destination: string, release: NodeRelease) => Promise<void>;
  } = {},
): Promise<void> {
  if (platform === 'win32') return; // Windows distribution is held; no runtime is pinned for it.
  const release = nodeRelease(platform, arch);
  const resources = path.dirname(buildPath);
  const cli = path.join(resources, 'cli');
  await (
    stageRuntime ??
    ((destination, selected) =>
      stageNode(destination, selected, {
        cache: path.join(project, 'node_modules/.cache/corrallm-node', `v${NODE_VERSION}`),
      }))
  )(cli, release);
  await copyFile(path.join(project, 'dist-cli/corrallm.cjs'), path.join(cli, 'corrallm.cjs'));
  for (const [name, module] of Object.entries(NATIVE_MODULES))
    await copyNativeModule(name, module, cli, platform, arch, project);
  const bin = path.join(resources, 'bin');
  await mkdir(bin, { recursive: true });
  await copyFile(path.join(project, 'build/corrallm'), path.join(bin, 'corrallm'));
  await chmod(path.join(bin, 'corrallm'), 0o755);
}
