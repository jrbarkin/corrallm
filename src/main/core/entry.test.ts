import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoreGuiSide, GuiSide } from '../../shared/gui-link';
import { CoreLink } from '../../shared/link';
import type { CoreSide, HostSide } from './protocol';
import { NO_DESKTOP } from './test-registry';

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
    expect(await window.request('channel', 'usage:get', [])).toEqual({
      ok: true,
      value: { readings: [], rules: { codex: rule } },
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
    await window.request('channel', 'canvas:forget', []);
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
