import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Core } from '../../../core/core';
import { createCore } from '../../../core/core';
import { keepCanvases } from '../../../core/store/test-store';
import { CALLERS, CANVAS, NO_DESKTOP } from '../../../core/test-registry';
import { AppServerConnector } from './connector';

const FAKE = fileURLToPath(new URL('../fake-codex.mjs', import.meta.url));
let profile: string;
let core: Core | undefined;
let log: string;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-command-kill-'));
  log = path.join(profile, 'processes.jsonl');
  const project = path.join(profile, 'project');
  await mkdir(project);
  const file = path.join(profile, 'canvas.corral');
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: CANVAS,
      nodes: [
        {
          id: 'a',
          kind: 'agent',
          label: 'Builder',
          position: { x: 0, y: 0 },
          adapter: 'codex',
          connection: 'codex.app-server',
          settings: { codex: { mode: 'auto' } },
        },
      ],
      links: [],
    }),
  );
  await keepCanvases(profile, { [CANVAS]: { file, project } });
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: 'test' },
      check: true,
      distribution: 'local',
      sessions: {
        environment: () => Promise.resolve({}),
        connectors: {
          'codex.app-server': new AppServerConnector({
            clientApp: 'corrallm/test',
            findCodex: () => Promise.resolve('/fake/codex'),
            spawn: (_exe, args, options) =>
              spawn(process.execPath, [FAKE, ...args], {
                ...options,
                env: { ...options.env, FAKE_CODEX_PROCESS_LOG: log },
              }),
          }),
        },
      },
    },
    NO_DESKTOP,
  );
  await core.engines.open(CANVAS);
});

afterEach(async () => {
  await core?.close();
  core = undefined;
  await rm(profile, { recursive: true, force: true });
});

interface ProcessRecord {
  type: string;
  processId: string;
  pid: number;
  live: string[];
}
async function records(): Promise<ProcessRecord[]> {
  return (await readFile(log, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProcessRecord);
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function command() {
  let found: ProcessRecord | undefined;
  await vi.waitFor(async () => {
    found = (await records()).findLast((record) => record.type === 'process');
    expect(found).toBeDefined();
  });
  if (!found) throw new Error('The fake reported no command');
  expect(alive(found.pid)).toBe(true);
  return found;
}
function running(): Core {
  if (!core) throw new Error('The test core has not started');
  return core;
}
async function send(text: string) {
  const result = await running().call(
    'message',
    { canvas: CANVAS, to: 'a', body: text },
    CALLERS.you,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value.id;
}
function idle() {
  return vi.waitFor(() => {
    expect(running().engines.canvas(CANVAS)?.engine.sessions.of('a').status).toBe('idle');
  });
}

it.each(['Kill', 'withdrawal'] as const)(
  '%s stops the turn’s real child before another message is delivered',
  async (action) => {
    const id = await send('slow');
    const child = await command();
    const result =
      action === 'Kill'
        ? await running().call('run.kill', { canvas: CANVAS, target: { agent: 'a' } }, CALLERS.you)
        : await running().call('withdraw', { id }, CALLERS.you);
    expect(result.ok).toBe(true);
    await idle();
    await send('next'); // Yours still go while Kill holds automated sends.
    await vi.waitFor(async () => {
      expect((await records()).filter((r) => r.type === 'turn')).toHaveLength(2);
    });
    expect((await records()).findLast((r) => r.type === 'turn')?.live).toEqual([]);
    expect(alive(child.pid)).toBe(false);
  },
);

it.each(['run.kill', 'session.interrupt'] as const)(
  '%s leaves an earlier turn’s background command alone',
  async (op) => {
    await send('background');
    const earlier = await command();
    await idle();
    await send('slow interact');
    await vi.waitFor(async () => {
      expect((await records()).filter((r) => r.type === 'process')).toHaveLength(2);
    });
    const current = await command();
    expect(
      (op === 'run.kill'
        ? await running().call('run.kill', { canvas: CANVAS, target: { agent: 'a' } }, CALLERS.you)
        : await running().call(
            'session.interrupt',
            { canvas: CANVAS, agent: 'a' },
            CALLERS['outside-write'],
          )
      ).ok,
    ).toBe(true);
    await idle();
    expect(alive(current.pid)).toBe(false);
    expect(alive(earlier.pid)).toBe(true);
  },
);

it('a plain token session interrupt stops the turn’s command', async () => {
  await send('slow');
  const child = await command();
  expect(
    (
      await running().call(
        'session.interrupt',
        { canvas: CANVAS, agent: 'a' },
        CALLERS['outside-write'],
      )
    ).ok,
  ).toBe(true);
  await idle();
  expect(alive(child.pid)).toBe(false);
  expect((await records()).filter((r) => r.type === 'terminated')).toHaveLength(1);
});
