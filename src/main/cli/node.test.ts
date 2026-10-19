import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NEEDED_NODE, nodeRefusal } from './node';

/*
 * The CLI refuses a Node older than the one package.json's engines names, in one sentence, before
 * anything else of it loads: as nodeRefusal decides, and as the CLI bundle (dist-cli/corrallm.cjs,
 * which the vitest `main` project's global setup builds) does when run as an older Node, its
 * version faked and node:sqlite missing, as on Node 20.
 */

const BUNDLE = path.resolve('dist-cli/corrallm.cjs');
/** Makes the Node it is preloaded into an older one: 22.18.0, without node:sqlite. */
const OLDER_NODE = `
Object.defineProperty(process.versions, 'node', { value: '22.18.0' });
const Module = require('node:module');
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'node:sqlite' || request === 'sqlite') {
    throw Object.assign(new Error('No such built-in module: ' + request), {
      code: 'ERR_UNKNOWN_BUILTIN_MODULE',
    });
  }
  return load.call(this, request, ...rest);
};
`;
const REFUSAL = `corrallm needs Node ${NEEDED_NODE} or later, and this is Node 22.18.0.`;

const execFileAsync = promisify(execFile);

describe('nodeRefusal', () => {
  it('refuses a Node older than the one corrallm needs, naming both', () => {
    for (const found of ['22.18.0', '24.20.9', '24.9.0', '23.99.99', '20.0.0', 'unknown']) {
      expect(nodeRefusal(found)).toBe(
        `corrallm needs Node ${NEEDED_NODE} or later, and this is Node ${found}.`,
      );
    }
  });

  it('runs on the Node it needs, or a later one', () => {
    for (const found of [NEEDED_NODE, '24.21.1', '24.22.0', '25.0.0', '26.1.0-nightly20261019']) {
      expect(nodeRefusal(found)).toBeUndefined();
    }
  });

  it('needs the Node package.json’s engines names', async () => {
    const { engines } = JSON.parse(await readFile('package.json', 'utf8')) as {
      engines: { node: string };
    };
    expect(engines.node).toBe(`^${NEEDED_NODE}`);
  });
});

describe('the CLI, run by an older Node', () => {
  let dir: string;
  let preload: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'corrallm-node-'));
    preload = path.join(dir, 'older-node.cjs');
    await writeFile(preload, OLDER_NODE);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Runs the CLI bundle with `args` as the older Node: how it exits, and what it printed. */
  async function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const env = { ...process.env };
    delete env.CORRALLM_NATIVE_SELFTEST;
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ['--require', preload, BUNDLE, ...args],
        { env, cwd: dir },
      );
      return { code: 0, stdout, stderr };
    } catch (error) {
      const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
      return { code, stdout, stderr };
    }
  }

  it('says so in one sentence and exits 64, before anything else of it loads', async () => {
    for (const args of [['serve', '--canvas', 'm1.corral'], [], ['nonsense']]) {
      expect(await run(...args)).toEqual({ code: 64, stdout: '', stderr: `${REFUSAL}\n` });
    }
  });

  it('gives `wait`’s one JSON line too, for an orchestrator that reads it', async () => {
    expect(await run('wait', '--timeout', '1')).toEqual({
      code: 64,
      stdout: `${JSON.stringify({ error: { code: 'invalid', sentence: REFUSAL } })}\n`,
      stderr: `${REFUSAL}\n`,
    });
  });
});
