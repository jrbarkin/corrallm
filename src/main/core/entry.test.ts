import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoreGuiSide, GuiSide } from '../../shared/gui-link';
import { CoreLink } from '../../shared/link';
import type * as CoreModule from './core';
import { TestChildren } from '../cli/test-children';
import type { CoreSide, HostSide } from './protocol';
import { newCanvasId } from '../../shared/canvas';
import { keepCanvases, openedLast } from './store/test-store';
import { NO_DESKTOP } from './test-registry';
import { askTokenOwner } from './token-socket';

let profile: string;
let main: CoreLink<HostSide, CoreSide>;
let initialized = false;
const closing: MessagePort[] = [];
const originalParent = Object.getOwnPropertyDescriptor(process, 'parentPort');

// The core and its MCP server, transformed once before the first test's clock starts: under a
// loaded machine, that alone can take most of a test's five seconds.
beforeAll(async () => {
  await Promise.all([import('./core'), import('./endpoint')]);
}, 60_000);

/** The process's exit listeners before each test: each entry loaded adds its own. */
let exits: NodeJS.ExitListener[] = [];
/** And its signal listeners: the core process handles its own (B14 C4). */
const SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT'] as const;
let signals = new Map<NodeJS.Signals, NodeJS.SignalsListener[]>();

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173');
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-core-entry-'));
  initialized = false;
  exits = process.listeners('exit');
  signals = new Map(SIGNALS.map((signal) => [signal, process.listeners(signal)]));
});
afterEach(async () => {
  if (initialized) await main.request('commitShutdown');
  for (const listener of process.listeners('exit')) {
    if (!exits.includes(listener)) process.removeListener('exit', listener);
  }
  for (const signal of SIGNALS) {
    for (const listener of process.listeners(signal)) {
      if (!signals.get(signal)?.includes(listener)) process.removeListener(signal, listener);
    }
  }
  for (const port of closing.splice(0)) port.close();
  if (originalParent) Object.defineProperty(process, 'parentPort', originalParent);
  else Reflect.deleteProperty(process, 'parentPort');
  vi.unstubAllGlobals();
  await rm(profile, { recursive: true, force: true });
});

/** A tools/list POST to `url` with `headers` (JSON, its own Host): its status. */
function mcp(url: string, headers: Record<string, string> = {}): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const sent = request(
      url,
      {
        method: 'POST',
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...headers,
        },
      },
      (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0 });
      },
    );
    sent.on('error', reject);
    sent.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  });
}

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
    window: (id: number, flush: () => unknown = () => null) => {
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
        {
          'drafts.flush': async () => {
            await flush();
            return null;
          },
        },
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

  it('composes once, running every canvas open as it starts, with or without a window', async () => {
    // A canvas open as the app last ran, which no window shows yet.
    const kept = newCanvasId();
    await openedLast(profile, kept);
    const entry = await start();
    expect(await entry.init()).toEqual({ ok: true, value: null });
    const window = entry.window(7);
    // Run by the core as it came up (B11 Design §2, §8): its run reads, restored paused.
    await vi.waitFor(async () => {
      expect(await window.request('call', 'run.get', { canvas: kept })).toMatchObject({
        ok: true,
        value: { ok: true, value: { running: false } },
      });
    });
    const { canvas } = (
      (await window.request('call', 'canvas.create', {})) as {
        value: { value: { canvas: string } };
      }
    ).value.value;
    expect(await entry.init()).toEqual({
      ok: false,
      error: { message: 'corrallm’s core is up already.' },
    });
    // A window closing only views what it showed: the canvas runs on, nothing at work in it.
    main.emit('windowGone', 7, true);
    const other = entry.window(8);
    expect(await other.request('call', 'run.get', { canvas })).toMatchObject({
      ok: true,
      value: { ok: true, value: { running: false } },
    });
    // Nothing at work: an idle quit holds the barrier at once (B14 C2), refusing writes.
    expect(await main.request('prepareShutdown', 'quit', { ifIdle: true })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(await other.request('call', 'canvas.create', {})).toMatchObject({
      ok: true,
      value: { ok: false, error: { code: 'unavailable' } },
    });
  });

  it('tells main its presence, whole, before init answers', async () => {
    const heard: unknown[] = [];
    const entry = await start();
    main.on('presence', (snapshot) => {
      heard.push(snapshot);
    });
    expect(await entry.init()).toEqual({ ok: true, value: null });
    expect(heard).toEqual([
      { revision: 0, working: 0, runs: 0, jobs: 0, needs: 0, busy: false, awake: false },
    ]);
  });
});

describe('the core process told to stop by a signal (B14 C4)', () => {
  it.each(SIGNALS)(
    'on %s tells main it is exiting, lands the drafts, then closes in order and exits 0',
    async (signal) => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const heard: unknown[] = [];
      const entry = await start();
      main.on('exiting', (why) => {
        heard.push(why);
      });
      expect(await entry.init()).toEqual({ ok: true, value: null });
      const apiJson = path.join(profile, 'api.json');
      await vi.waitFor(() => {
        expect(existsSync(apiJson)).toBe(true);
      });
      // What the window composes lands as a write while it is asked: before the barrier.
      let landed: unknown;
      const window = entry.window(7, async () => {
        landed = await window.request('call', 'canvas.create', {});
      });
      await window.request('call', 'app.info', {});
      process.emit(signal, signal);
      // Again while it closes: nothing more (a second signal never kills it before it is done).
      process.emit(signal, signal);
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
      expect(heard).toEqual(['signal']);
      expect(landed).toMatchObject({ ok: true, value: { ok: true } });
      // Closed in order: the endpoint gone, then the core, the profile let go.
      expect(existsSync(apiJson)).toBe(false);
      expect(existsSync(path.join(profile, 'core.lock'))).toBe(false);
      expect(exit).toHaveBeenCalledOnce();
      // Main's own commit, if it asks too, is the same close.
      expect(await main.request('commitShutdown')).toEqual({ ok: true, value: null });
      initialized = false;
    },
    20_000,
  );

  it('gives drafts at most a second in all, then closes all the same', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const entry = await start();
    expect(await entry.init()).toEqual({ ok: true, value: null });
    const window = entry.window(7, () => new Promise(() => undefined));
    await window.request('call', 'app.info', {});
    const told = Date.now();
    process.emit('SIGTERM', 'SIGTERM');
    await vi.waitFor(
      () => {
        expect(exit).toHaveBeenCalledWith(0);
      },
      { timeout: 10_000 },
    );
    expect(Date.now() - told).toBeGreaterThanOrEqual(1000);
    expect(existsSync(path.join(profile, 'core.lock'))).toBe(false);
    initialized = false;
  }, 20_000);

  it('exits at once, saying so, when it holds no profile yet', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const heard: unknown[] = [];
    await start();
    main.on('exiting', (why) => {
      heard.push(why);
    });
    process.emit('SIGTERM', 'SIGTERM');
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
    expect(heard).toEqual(['signal']);
  });
});

describe('Pause all, asked by main’s native menus (B14 C3)', () => {
  it('pauses as you at main’s own UI, answering what it paused', async () => {
    const entry = await start();
    expect(await entry.init()).toEqual({ ok: true, value: null });
    expect(await main.request('pauseAll')).toEqual({
      ok: true,
      value: { agents: 0, canvases: 0, unsaved: [] },
    });
    // Under the barrier, its refusal's sentence.
    expect(await main.request('prepareShutdown', 'quit')).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(await main.request('pauseAll')).toEqual({
      ok: true,
      value: { sentence: 'corrallm is quitting: try again once it is open again.' },
    });
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

    expect(await main.request('commitShutdown')).toEqual({ ok: true, value: null });
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
 * The app's outside endpoint (B11 Design §9, §16.6): the core process always serves MCP once
 * composed, beside its dispatcher, on the port the profile keeps, with every check serve makes,
 * and publishes api.json naming itself; a port taken is a status, and the app runs on.
 */
describe('the app’s outside endpoint', () => {
  async function listening(): Promise<{ url: string; port: number; pid: number }> {
    return JSON.parse(await readFile(path.join(profile, 'api.json'), 'utf8')) as {
      url: string;
      port: number;
      pid: number;
    };
  }

  it('is served once composed, on 127.0.0.1 at a port kept, api.json 0600 naming the core’s process, gone once the core closes', async () => {
    const entry = await start();
    expect(await entry.init()).toEqual({ ok: true, value: null });
    const api = await listening();
    expect(api).toMatchObject({
      pid: process.pid,
      url: `http://127.0.0.1:${String(api.port)}/mcp`,
    });
    expect((await stat(path.join(profile, 'api.json'))).mode & 0o777).toBe(0o600);
    const settings = JSON.parse(await readFile(path.join(profile, 'settings.json'), 'utf8')) as {
      api?: { port?: number };
    };
    expect(settings.api?.port).toBe(api.port);
    // Every check of serve's: no token (none is made), a foreign Host, any Origin.
    expect(await mcp(api.url)).toEqual({ status: 401 });
    expect(await mcp(api.url, { Authorization: 'Bearer made-up' })).toEqual({ status: 401 });
    expect(await mcp(api.url, { Host: `evil.example:${String(api.port)}` })).toEqual({
      status: 403,
    });
    expect(await mcp(api.url, { Origin: 'https://evil.example' })).toEqual({ status: 403 });
    // A window reads where it listens, quietly.
    const window = entry.window(7);
    expect(await window.request('call', 'settings.get', {})).toMatchObject({
      ok: true,
      value: { ok: true, value: { api: { state: 'listening', port: api.port, url: api.url } } },
    });

    expect(await main.request('commitShutdown')).toEqual({ ok: true, value: null });
    initialized = false;
    expect(existsSync(path.join(profile, 'api.json'))).toBe(false);
    await expect(mcp(api.url)).rejects.toThrow();
  });

  it('says a kept port that is taken as a status, never a dialog or another port, and runs on', async () => {
    const squatter = createServer();
    await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
    const { port } = squatter.address() as AddressInfo;
    try {
      await writeFile(
        path.join(profile, 'settings.json'),
        JSON.stringify({ version: 2, consents: {}, api: { port } }),
      );
      const said = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const entry = await start();
      expect(await entry.init()).toEqual({ ok: true, value: null });
      expect(existsSync(path.join(profile, 'api.json'))).toBe(false);
      const sentence = `Port ${String(port)} is taken by another program, so corrallm’s MCP server isn’t listening: stop that program, then quit corrallm and open it again.`;
      expect(said).toHaveBeenCalledWith(`corrallm: ${sentence}`);
      const window = entry.window(7);
      expect(await window.request('call', 'settings.get', {})).toMatchObject({
        ok: true,
        value: { ok: true, value: { api: { state: 'unavailable', port, sentence } } },
      });
      // Local work goes on.
      expect(await window.request('call', 'canvas.create', {})).toMatchObject({
        ok: true,
        value: { ok: true },
      });
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });

  it('keeps the endpoint through a cancelled quit, and closes it once the quit is committed', async () => {
    const entry = await start();
    expect(await entry.init()).toEqual({ ok: true, value: null });
    const api = await listening();
    const window = entry.window(7);
    expect(await main.request('prepareShutdown', 'quit')).toEqual({
      ok: true,
      value: { ok: true },
    });
    // Prepared, a write is refused, saying why; a read is answered.
    expect(await window.request('call', 'canvas.create', {})).toMatchObject({
      ok: true,
      value: {
        ok: false,
        error: {
          code: 'unavailable',
          sentence: 'corrallm is quitting: try again once it is open again.',
        },
      },
    });
    expect(await window.request('call', 'app.info', {})).toMatchObject({
      ok: true,
      value: { ok: true },
    });
    // Keep corrallm open: the endpoint and api.json stay, and writes are admitted again.
    expect(await main.request('cancelShutdown')).toEqual({ ok: true, value: null });
    expect(await listening()).toEqual(api);
    expect(await mcp(api.url)).toEqual({ status: 401 });
    expect(await window.request('call', 'canvas.create', {})).toMatchObject({
      ok: true,
      value: { ok: true },
    });

    expect(await main.request('prepareShutdown', 'quit')).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(await main.request('commitShutdown')).toEqual({ ok: true, value: null });
    initialized = false;
    expect(existsSync(path.join(profile, 'api.json'))).toBe(false);
    expect(existsSync(path.join(profile, 'core.lock'))).toBe(false);
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
    // It names where the app's MCP server listens, and the token works there at once.
    const { url } = JSON.parse(await readFile(path.join(profile, 'api.json'), 'utf8')) as {
      url: string;
    };
    expect(answer).toMatchObject({
      ok: true,
      owner: 'app',
      op: 'new',
      url,
      canvases: [{ id: CANVAS, file }],
    });
    const token = answer?.ok === true && answer.op !== 'revoke' ? answer.token : '';
    expect(await mcp(url, { Authorization: `Bearer ${token}` })).toMatchObject({ status: 200 });
    const kept = await readFile(path.join(profile, 'tokens.json'), 'utf8');
    expect(kept).toContain(createHash('sha256').update(token).digest('hex'));
    expect(kept).not.toContain(token);
    expect(JSON.stringify(said)).not.toContain(token);
    vi.restoreAllMocks();

    expect(await main.request('commitShutdown')).toEqual({ ok: true, value: null });
    initialized = false;
    expect(existsSync(at)).toBe(false);
  });

  it('says why no URL is named while the app’s MCP server can’t listen', async () => {
    const squatter = createServer();
    await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
    const { port } = squatter.address() as AddressInfo;
    try {
      await writeFile(
        path.join(profile, 'settings.json'),
        JSON.stringify({ version: 2, consents: {}, api: { port } }),
      );
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const entry = await start();
      expect(await entry.init()).toEqual({ ok: true, value: null });
      const answer = await askTokenOwner(profile, {
        version: 1,
        op: 'new',
        name: 'bot',
        hours: 1,
        access: 'read',
        canvases: [file],
      });
      expect(answer).toMatchObject({
        ok: true,
        owner: 'app',
        url: null,
        unserved: `Port ${String(port)} is taken by another program, so corrallm’s MCP server isn’t listening: stop that program, then quit corrallm and open it again.`,
      });
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
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
