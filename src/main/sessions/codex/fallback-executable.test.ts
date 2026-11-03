import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { startAppServer } from './rpc';

it('the executable App Server fake keeps native rule and hard-limit readings for its private reader', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'corrallm-fallback-app-server-'));
  const script = path.join(folder, 'script.json'),
    limits = path.join(folder, 'limits.json');
  await writeFile(
    limits,
    JSON.stringify({
      limitId: 'codex',
      primary: {
        usedPercent: 12,
        windowDurationMins: 300,
        resetsAt: Math.floor(Date.now() / 1000) + 600,
      },
      secondary: null,
    }),
  );
  await writeFile(
    script,
    JSON.stringify({
      turns: {
        'rule-boundary': { usedPercent: 90 },
        'source-limit': { fail: true, usedPercent: 100 },
      },
    }),
  );
  const events: { method: string; params: unknown }[] = [];
  const server = await startAppServer({
    codex: 'fake',
    cwd: folder,
    env: { ...process.env, FAKE_CODEX_FALLBACK: script, FAKE_CODEX_LIMITS: limits },
    clientInfo: { name: 'test', title: 'test', version: '1' },
    spawn: (_file, args, options) =>
      spawn(process.execPath, [path.join(import.meta.dirname, 'fake-codex.mjs'), ...args], options),
    onNotification: (method, params) => {
      events.push({ method, params });
    },
  });
  try {
    const { thread } = (await server.request('thread/start', { cwd: folder })) as {
      thread: { id: string };
    };
    for (const [text, usedPercent, status] of [
      ['rule-boundary', 90, 'completed'],
      ['source-limit', 100, 'failed'],
    ] as const) {
      events.length = 0;
      await server.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text, text_elements: [] }],
      });
      await vi.waitFor(() => {
        expect(events).toContainEqual(expect.objectContaining({ method: 'turn/completed' }));
      });
      expect(events.find((one) => one.method === 'turn/completed')?.params).toMatchObject({
        turn: { status },
      });
      expect(events.findIndex((one) => one.method === 'account/rateLimits/updated')).toBeLessThan(
        events.findIndex((one) => one.method === 'turn/completed'),
      );
      expect(await server.request('account/rateLimits/read', {})).toMatchObject({
        rateLimits: { primary: { usedPercent } },
      });
      expect(JSON.parse(await readFile(limits, 'utf8')) as unknown).toMatchObject({
        primary: { usedPercent },
      });
    }
  } finally {
    await server.close();
    await rm(folder, { recursive: true, force: true });
  }
}, 15_000);
