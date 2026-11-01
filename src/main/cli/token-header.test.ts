import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tokenCommand } from './token';

const token = 't'.repeat(43);
let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'corrallm-header-'));
  await writeFile(path.join(folder, 'token'), `${token}\n`, { mode: 0o600 });
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('the outside token header helper', () => {
  it.each(['token', 'not-a-file'])(
    'prints no header in a corrallm agent session, with %s',
    async (from) => {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn(), isTTY: false };
      expect(
        await tokenCommand(
          { command: 'token', action: 'header', from },
          {
            cwd: folder,
            env: { CORRALLM_AGENT_SESSION: '1' },
            stdout,
            stderr,
          },
        ),
      ).toBe(1);
      expect(stdout.write).not.toHaveBeenCalled();
      expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining('agent session'));
    },
  );

  it.skipIf(process.platform === 'win32')(
    'prints the header for an outside orchestrator without the agent marker',
    async () => {
      const stdout = { write: vi.fn() };
      expect(
        await tokenCommand(
          { command: 'token', action: 'header', from: 'token' },
          {
            cwd: folder,
            env: {},
            stdout,
            stderr: { write: vi.fn(), isTTY: false },
          },
        ),
      ).toBe(0);
      expect(stdout.write).toHaveBeenCalledExactlyOnceWith(
        `${JSON.stringify({ Authorization: `Bearer ${token}` })}\n`,
      );
    },
  );
});
