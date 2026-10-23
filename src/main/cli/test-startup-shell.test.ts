import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startupShell } from './test-startup-shell';

const execute = promisify(execFile);
let folder: string;
let shell: string;
let reading: string;
let release: string;

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'corrallm-startup-shell-'));
  shell = path.join(folder, 'shell');
  reading = path.join(folder, 'reading');
  release = path.join(folder, 'release');
  await writeFile(shell, startupShell(reading, release), { mode: 0o755 });
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('the startup-shutdown login shell', () => {
  it('does not gate Linux script’s launcher shell or report its parent as serve', async () => {
    let done = false;
    const launched = execute(shell, ['-c', 'printf launched']).then((result) => {
      done = true;
      return result;
    });
    try {
      // Linux script invokes $SHELL -c before the wrapped Node command exists. The old shell
      // reports script's pid here; gating that launch and signalling it cannot tell serve.
      await vi.waitFor(() => {
        expect(done || existsSync(reading)).toBe(true);
      });
      expect(existsSync(reading)).toBe(false);
      expect((await launched).stdout).toBe('launched');
    } finally {
      await writeFile(release, 'go');
      await launched;
    }
  });

  it('gates only the login environment read and reports its actual Node parent', async () => {
    let done = false;
    const launched = execute(shell, ['-ilc', 'printf environment']).then((result) => {
      done = true;
      return result;
    });
    try {
      await vi.waitFor(() => {
        expect(existsSync(reading)).toBe(true);
      });
      expect(Number(await readFile(reading, 'utf8'))).toBe(process.pid);
      expect(done).toBe(false);
    } finally {
      await writeFile(release, 'go');
      expect((await launched).stdout).toBe('environment');
    }
  });
});
