import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

import type { Connector } from './connector';
import { createCore } from '../core/core';
import { keepCanvases } from '../core/store/test-store';
import { CALLERS, CANVAS, NO_DESKTOP } from '../core/test-registry';
import { legacyDirectories } from '../core/workspaces/test-directories';

/** An actual command with a delayed termination; its exit, not its interrupt receipt, is proof. */
export class Command {
  readonly child: ChildProcess;
  readonly exited: Promise<void>;
  readonly ready: Promise<void>;
  constructor() {
    this.child = spawn(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),100)); console.log('ready'); setInterval(()=>{},1000)",
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    this.exited = new Promise((resolve, reject) => {
      this.child.once('exit', () => {
        resolve();
      });
      this.child.once('error', reject);
    });
    this.ready = new Promise((resolve) =>
      this.child.stdout?.once('data', () => {
        resolve();
      }),
    );
  }
  get alive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }
  async stop(): Promise<void> {
    this.child.kill();
    await this.exited;
  }
}

/** Same real-core Kill and delivered-withdrawal audit, each adapter supplying its own native fake. */
export function auditKill(
  adapter: string,
  connection: string,
  connect: (folder: string, log: string) => Connector,
) {
  it.each(['Kill', 'withdrawal'] as const)(
    '%s ends the turn’s real command before the next delivery, preserving earlier background work',
    async (action) => {
      const folder = await mkdtemp(path.join(tmpdir(), 'corrallm-kill-audit-'));
      const log = path.join(folder, 'commands.jsonl');
      const project = path.join(folder, 'project');
      await mkdir(project);
      const file = path.join(folder, 'canvas.corral');
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
              adapter,
              connection,
            },
          ],
          links: [],
        }),
      );
      await keepCanvases(folder, { [CANVAS]: { file, project } });
      const core = await createCore(
        {
          profile: folder,
          app: { name: 'corrallm', version: 'test' },
          check: true,
          distribution: 'local',
          directoryResolver: legacyDirectories,
          // This audit exercises native interruption, not OS identity/recovery (children.test.ts).
          children: {
            platform: process.platform,
            inspect: (pid) => ({ started: 1, group: pid }),
            alive: () => false,
            signal: () => undefined,
            wait: () => Promise.resolve(),
            pause: () => undefined,
            now: Date.now,
          },
          watchFolder: () => ({ close: () => undefined }),
          sessions: {
            environment: () => Promise.resolve({}),
            connectors: { [connection]: connect(folder, log) },
          },
        },
        NO_DESKTOP,
      );
      try {
        await core.engines.open(CANVAS);
        const records = async () =>
          (await readFile(log, 'utf8').catch(() => ''))
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { type: string; pid?: number; live?: number[] });
        const send = async (body: string) => {
          const result = await core.call('message', { canvas: CANVAS, to: 'a', body }, CALLERS.you);
          if (!result.ok) throw new Error(JSON.stringify(result.error));
          return result.value.id;
        };
        const idle = () =>
          vi.waitFor(() => {
            expect(core.engines.canvas(CANVAS)?.engine.sessions.of('a').status).toBe('idle');
          });
        await send('background command');
        await vi.waitFor(
          async () => {
            expect((await records()).filter((r) => r.type === 'turn')).toHaveLength(1);
          },
          { timeout: 10000 },
        );
        await idle();
        const id = await send('slow command');
        await vi.waitFor(
          async () => {
            expect((await records()).filter((r) => r.type === 'process')).toHaveLength(2);
          },
          { timeout: 10000 },
        );
        const processes = (await records()).filter((r) => r.type === 'process');
        const earlier = processes[0]?.pid;
        const current = processes[1]?.pid;
        expect(earlier).toBeTypeOf('number');
        expect(current).toBeTypeOf('number');
        const result =
          action === 'Kill'
            ? await core.call('run.kill', { canvas: CANVAS, target: { agent: 'a' } }, CALLERS.you)
            : await core.call('withdraw', { id }, CALLERS.you);
        expect(result.ok).toBe(true);
        // Queue immediately: a turn end must not release delivery ahead of the command's exit.
        await send('next');
        await vi.waitFor(async () => {
          expect((await records()).filter((r) => r.type === 'turn')).toHaveLength(3);
        });
        expect((await records()).findLast((r) => r.type === 'turn')?.live).toEqual([earlier]);
        expect(() => process.kill(current ?? 0, 0)).toThrow();
        expect(() => process.kill(earlier ?? 0, 0)).not.toThrow();
        await idle();
      } finally {
        await core.close();
        await rm(folder, { recursive: true, force: true });
      }
    },
    30000,
  );
}
