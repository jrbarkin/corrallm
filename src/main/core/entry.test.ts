import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoreGuiSide, GuiSide } from '../../shared/gui-link';
import { CoreLink } from '../../shared/link';
import type * as CoreModule from './core';
import { TestChildren } from '../cli/test-children';
import type { CoreSide, HostSide } from './protocol';
import { keepCanvases } from './store/test-store';
import { NO_DESKTOP } from './test-registry';
import { askTokenOwner } from './token-socket';

let profile: string;
let main: CoreLink<HostSide, CoreSide>;
let initialized = false;
const closing: MessagePort[] = [];
const originalParent = Object.getOwnPropertyDescriptor(process, 'parentPort');

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173');
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-core-entry-'));
  initialized = false;
});
afterEach(async () => {
  if (initialized) await main.request('close');
  for (const port of closing.splice(0)) port.close();
  if (originalParent) Object.defineProperty(process, 'parentPort', originalParent);
  else Reflect.deleteProperty(process, 'parentPort');
  vi.unstubAllGlobals();
  await rm(profile, { recursive: true, force: true });
});

/** Electron's port shape over a real MessageChannel; no Electron process is needed here. */
class MainPort extends EventEmitter {
  readonly port: MessagePort;
  constructor(port: MessagePort) {
    super();
    this.port = port;
    port.once('close', () => {
      this.emit('close');
    });
  }
  postMessage(data: unknown) {
    this.port.postMessage(data);
  }
  start() {
    this.port.on('message', (data: unknown) => {
      this.emit('message', { data });
    });
    this.port.start();
  }
  close() {
    this.port.close();
  }
}

async function start() {
  const parent = new EventEmitter();
  let receive: (data: unknown) => void = () => undefined;
  Object.assign(parent, {
    postMessage: (data: unknown) => {
      receive(data);
    },
  });
  main = new CoreLink<HostSide, CoreSide>(
    {
      post: (data) => {
        parent.emit('message', { data, ports: [] });
      },
      start: (listener) => {
        receive = listener;
      },
    },
    NO_DESKTOP,
  );
  Object.defineProperty(process, 'parentPort', { configurable: true, value: parent });
  await import('./entry');
  return {
    init: async () => {
      const answer = await main.request('init', {
        profile,
        app: { name: 'corrallm', version: '1.2.3' },
        distribution: 'local',
        locale: 'en-US',
        fakeSessions: true,
      });
      if (answer.ok) initialized = true;
      return answer;
    },
    window: (id: number) => {
      const { port1, port2 } = new MessageChannel();
      closing.push(port1, port2);
      parent.emit('message', {
        data: { kind: 'window', window: id },
        ports: [new MainPort(port1)],
      });
      return new CoreLink<GuiSide, CoreGuiSide>(
        {
          post: (data) => {
            port2.postMessage(data);
          },
          start: (listener) => {
            port2.on('message', listener);
          },
        },
        {},
      );
    },
  };
}

describe('the core process’s init', () => {
  it('composes the given profile before serving a window handed over early', async () => {
    const rule = { window: 'weekly', percent: 80, action: 'ask' };
    await writeFile(
      path.join(profile, 'usage.json'),
      JSON.stringify({ version: 2, readings: [], rules: { codex: rule } }),
    );
    const entry = await start();
    const window = entry.window(7);
    const pending = window.request('call', 'app.info', {});
    expect(await entry.init()).toEqual({ ok: true, value: null });
    expect(await pending).toEqual({
      ok: true,
      value: { ok: true, value: { name: 'corrallm', version: '1.2.3' } },
    });
    expect(await window.request('call', 'usage.get', {})).toEqual({
      ok: true,
      value: { ok: true, value: { readings: [], rules: { codex: rule } } },
    });
    expect(await window.request('call', 'app.info', {})).toEqual({
      ok: true,
      value: { ok: true, value: { name: 'corrallm', version: '1.2.3' } },
    });
  });

  it('composes once, reports windows with canvases and flushes on main’s request', async () => {
    const entry = await start();
    expect(await entry.init()).toEqual({ ok: true, value: null });
    const window = entry.window(7);
    await window.request('call', 'canvas.create', {});
    expect(await main.request('shown', [7, 8])).toEqual({ ok: true, value: [7] });
    expect(await main.request('flush')).toEqual({ ok: true, value: null });
    expect(await entry.init()).toEqual({
      ok: false,
      error: { message: 'corrallm’s core is up already.' },
    });
    main.emit('windowGone', 7, true);
    expect(await main.request('shown', [7])).toEqual({ ok: true, value: [] });
  });
});

describe('a window gaining focus', () => {
  it('has the core check the file of the canvas it shows', async () => {
    const focused: number[] = [];
    vi.doMock('./core', async (original) => {
      const real = await original<typeof CoreModule>();
      return {
        ...real,
        createCore: async (...args: Parameters<typeof real.createCore>) => {
          const core = await real.createCore(...args);
          const check = core.focused.bind(core);
          core.focused = (window) => {
            focused.push(window);
            return check(window);
          };
          return core;
        },
      };
    });
    try {
      const entry = await start();
      expect(await entry.init()).toEqual({ ok: true, value: null });
      main.emit('windowFocused', 7);
      await vi.waitFor(() => {
        expect(focused).toEqual([7]);
      });
    } finally {
      vi.doUnmock('./core');
    }
  });
});

describe('the profile’s lock, held by the core process', () => {
  it('init takes core.lock as the app’s, before composing, and close lets it go', async () => {
    const entry = await start();
    expect(await entry.init()).toEqual({ ok: true, value: null });
    expect(JSON.parse(await readFile(path.join(profile, 'core.lock'), 'utf8'))).toMatchObject({
      owner: 'app',
      pid: process.pid,
    });

    expect(await main.request('close')).toEqual({ ok: true, value: null });
    initialized = false;
    expect(existsSync(path.join(profile, 'core.lock'))).toBe(false);
  });

  it('answers who holds the profile while corrallm serve does, composing nothing', async () => {
    // Held by a live process: this one, standing in for `corrallm serve`.
    const holder = {
      owner: 'serve',
      pid: process.pid,
      started: Math.round(Date.now() - process.uptime() * 1000),
    };
    const held = JSON.stringify(holder);
    await writeFile(path.join(profile, 'core.lock'), held);
    const entry = await start();

    expect(await entry.init()).toEqual({ ok: true, value: { profileLocked: { holder } } });
    // Nothing of the profile was read or written, and the lock is left as it was.
    expect(await readdir(profile)).toEqual(['core.lock']);
    expect(await readFile(path.join(profile, 'core.lock'), 'utf8')).toBe(held);

    // Once serve lets the profile go, the app's core may come up after all.
    await rm(path.join(profile, 'core.lock'));
    expect(await entry.init()).toEqual({ ok: true, value: null });
  });
});

/*
 * `corrallm token new|renew|revoke` against the app (Build Plan B30): the core process serves the
 * profile's token socket once it holds the profile and is composed, as `corrallm serve` does, so a
 * token is made while the app runs, at once, with no restart.
 */
describe.skipIf(process.platform === 'win32')('the token socket the core process serves', () => {
  const CANVAS = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01';
  const BUNDLE = path.resolve('dist-cli/corrallm.cjs');
  let outside: string;
  let file: string;
  let children: TestChildren;

  beforeEach(async () => {
    children = new TestChildren();
    outside = await mkdtemp(path.join(tmpdir(), 'corrallm-entry-canvas-'));
    const project = path.join(outside, 'project');
    await mkdir(project);
    file = path.join(outside, 'm1.corral');
    await writeFile(
      file,
      JSON.stringify({ format: 'corrallm', version: 2, id: CANVAS, nodes: [], links: [] }),
    );
    await keepCanvases(profile, { [CANVAS]: { file, project } });
  });
  afterEach(async () => {
    await children.close();
    await rm(outside, { recursive: true, force: true });
  });

  it('serves corrallm token once composed: a token made at once and logged nowhere, on a socket only you can open, gone as the core closes', async () => {
    const said: unknown[] = [];
    for (const stream of ['log', 'error', 'warn', 'info'] as const) {
      vi.spyOn(console, stream).mockImplementation((...args: unknown[]) => {
        said.push(...args);
      });
    }
    const entry = await start();
    expect(await entry.init()).toEqual({ ok: true, value: null });
    const at = path.join(profile, 'token.sock');
    const socket = await lstat(at);
    expect(socket.isSocket()).toBe(true);
    expect(socket.mode & 0o777).toBe(0o600);

    const answer = await askTokenOwner(profile, {
      version: 1,
      op: 'new',
      name: 'bot',
      hours: 1,
      access: 'write',
      canvases: [file],
    });
    // The app serves no MCP yet (B11): it names no URL.
    expect(answer).toMatchObject({
      ok: true,
      owner: 'app',
      op: 'new',
      url: null,
      canvases: [{ id: CANVAS, file }],
    });
    const token = answer?.ok === true && answer.op !== 'revoke' ? answer.token : '';
    const kept = await readFile(path.join(profile, 'tokens.json'), 'utf8');
    expect(kept).toContain(createHash('sha256').update(token).digest('hex'));
    expect(kept).not.toContain(token);
    expect(JSON.stringify(said)).not.toContain(token);
    vi.restoreAllMocks();

    expect(await main.request('close')).toEqual({ ok: true, value: null });
    initialized = false;
    expect(existsSync(at)).toBe(false);
  });

  it('answers the shipped command on a terminal: corrallm token new against the app’s core', async () => {
    const entry = await start();
    expect(await entry.init()).toEqual({ ok: true, value: null });
    const { printed, exited } = children.terminal(
      [
        process.execPath,
        BUNDLE,
        'token',
        'new',
        '--profile',
        profile,
        '--canvas',
        file,
        '--name',
        'bot',
      ],
      { ...process.env, CORRALLM_AGENT_PATHS: '{}' },
    );
    expect(await exited, printed()).toBe(0);
    const token = /^ {2}([A-Za-z0-9_-]{43})$/m.exec(printed())?.[1] ?? '';
    expect(printed().split(token)).toHaveLength(2);
    expect(printed()).toContain('the corrallm app');
    const kept = JSON.parse(await readFile(path.join(profile, 'tokens.json'), 'utf8')) as {
      tokens: Record<string, { name: string; canvases: string[] }>;
    };
    expect(kept.tokens[createHash('sha256').update(token).digest('hex')]).toMatchObject({
      name: 'bot',
      canvases: [CANVAS],
    });
  }, 30_000);
});
