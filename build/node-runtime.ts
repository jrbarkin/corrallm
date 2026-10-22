import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import releases from './node-releases.json' with { type: 'json' };

export const NODE_VERSION = releases.version;
export const NODE_RELEASES = releases.targets;
export interface NodeRelease {
  file: string;
  sha256: string;
}
const run = promisify(execFile);

export function nodeRelease(platform: string, arch: string): NodeRelease {
  const target = `${platform === 'mas' ? 'darwin' : platform}-${arch}`;
  const found = Object.entries(NODE_RELEASES).find(([key]) => key === target)?.[1];
  if (!found) throw new Error(`The shipped command is not supported on ${target}.`);
  return found;
}

/** A checked-in digest is the authority, for cached downloads just as for new ones. */
export async function stageNode(
  destination: string,
  release: NodeRelease,
  { cache, fetch: download = fetch }: { cache: string; fetch?: typeof fetch },
): Promise<void> {
  const archive = path.join(cache, release.file);
  await mkdir(cache, { recursive: true });
  let bytes: Buffer | undefined;
  let fresh = false;
  try {
    bytes = await readFile(archive);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  if (!bytes) {
    const response = await download(`https://nodejs.org/dist/v${NODE_VERSION}/${release.file}`, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok)
      throw new Error(`Could not download ${release.file}: HTTP ${String(response.status)}.`);
    bytes = Buffer.from(await response.arrayBuffer());
    fresh = true;
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== release.sha256) {
    throw new Error(
      `SHA-256 mismatch for ${release.file}: expected ${release.sha256}, got ${digest}.`,
    );
  }
  if (fresh) {
    const pending = `${archive}.${randomUUID()}.tmp`;
    try {
      await writeFile(pending, bytes);
      await rename(pending, archive);
    } finally {
      await rm(pending, { force: true });
    }
  }
  // Never reuse an extracted executable: macOS signing changes only the shipped copy, and
  // every build begins from authenticated archive bytes, not a mutable extracted cache.
  const unpacked = await mkdtemp(path.join(cache, 'extract-'));
  const base = release.file.replace(/\.tar\.gz$/, '');
  try {
    await run('tar', ['-xzf', archive, '-C', unpacked, `${base}/bin/node`, `${base}/LICENSE`]);
    await mkdir(destination, { recursive: true });
    await copyFile(path.join(unpacked, base, 'bin/node'), path.join(destination, 'node'));
    await chmod(path.join(destination, 'node'), 0o755);
    await copyFile(path.join(unpacked, base, 'LICENSE'), path.join(destination, 'NODE-LICENSE'));
  } finally {
    await rm(unpacked, { recursive: true, force: true });
  }
}
