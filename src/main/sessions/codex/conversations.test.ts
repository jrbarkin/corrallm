import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

import { codexConversations } from './conversations';
import type { AppServer } from './rpc';
import { startAppServer } from './rpc';

it('refuses an unsafe id from the project’s thread list', async () => {
  const request = vi
    .fn<AppServer['request']>()
    .mockResolvedValue({ data: [{ id: '--resume', cwd: '/work/project', updatedAt: 1 }] });
  const close = vi.fn<AppServer['close']>().mockResolvedValue();
  const start = vi.fn().mockResolvedValue({ request, close });
  await expect(
    codexConversations({ codex: '/fake/codex', cwd: '/work/project', env: {} }, { start }),
  ).rejects.toThrow(/conversation id/);
  expect(close).toHaveBeenCalledOnce();
});

it('reads the fake Codex’s kept threads through its real App Server transport', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'corrallm-codex-conversations-'));
  try {
    const cwd = await realpath(dir);
    const id = '01a1344c-68e9-7bf2-a777-b062d871bb26';
    const state = path.join(dir, 'threads.json');
    await writeFile(state, JSON.stringify({ [id]: { cwd, model: 'gpt-6.1-sol', turns: [] } }));
    const fake = path.join(import.meta.dirname, 'fake-codex.mjs');
    const listed = await codexConversations(
      {
        codex: path.join(import.meta.dirname, 'fake-codex.mjs'),
        cwd,
        env: { PATH: path.dirname(process.execPath), FAKE_CODEX_STATE: state },
      },
      {
        start: (options) =>
          startAppServer({
            ...options,
            spawn: (_codex, args, options) => spawn(process.execPath, [fake, ...args], options),
          }),
      },
    );
    expect(listed).toEqual([{ id, title: 'Untitled conversation', modified: 1000 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('lists only the project’s Codex threads, without starting or reading a conversation', async () => {
  const id = '01a1344c-68e9-7bf2-a777-b062d871bb26';
  const request = vi.fn<AppServer['request']>().mockResolvedValue({
    data: [
      {
        id,
        cwd: '/work/project',
        preview: 'First prompt',
        name: ' My thread\nname ',
        updatedAt: 123,
        gitInfo: { branch: 'topic' },
      },
      { id: 'another', cwd: '/elsewhere', preview: 'Elsewhere', updatedAt: 456 },
    ],
  });
  const close = vi.fn<AppServer['close']>().mockResolvedValue();
  const start = vi.fn().mockResolvedValue({ request, close });
  await expect(
    codexConversations({ codex: '/fake/codex', cwd: '/work/project', env: {} }, { start }),
  ).resolves.toEqual([{ id, title: 'My thread name', modified: 123000, branch: 'topic' }]);
  expect(request).toHaveBeenCalledExactlyOnceWith(
    'thread/list',
    expect.objectContaining({
      cwd: '/work/project',
      limit: 50,
      sortKey: 'updated_at',
      archived: false,
    }),
  );
  expect(close).toHaveBeenCalledOnce();
});

it('reports a failed thread list and closes the private server', async () => {
  const close = vi.fn<AppServer['close']>().mockResolvedValue();
  const start = vi
    .fn()
    .mockResolvedValue({ request: () => Promise.reject(new Error('unavailable')), close });
  await expect(
    codexConversations({ codex: '/fake/codex', cwd: '/work/project', env: {} }, { start }),
  ).rejects.toThrow('unavailable');
  expect(close).toHaveBeenCalledOnce();
});
