import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_DROPPED_FILES,
  MAX_DROPPED_PATH,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_INPUT,
  MAX_TERMINAL_ROWS,
} from '../../shared/terminal';
import type { TerminalEvent } from '../../shared/terminal';
import type { Connector, TerminalScreen } from '../sessions/connector';
import { quotePath } from '../sessions/terminal/drop';
import { createCore } from './core';
import type { Core } from './core';
import { keepCanvases, openedLast } from './store/test-store';
import { newCanvasId } from '../../shared/canvas';
import { WindowPorts } from './gui';
import { mintTrustedPath } from './host';
import { CALLERS, NO_DESKTOP } from './test-registry';
import { openWindow } from './test-window';

const YOU = { ...CALLERS.you, window: 7 };
const EIGHT = { ...CALLERS.you, window: 8 };
let profile: string;
const agent = 'a';
let core: Core;
let screen: ReturnType<typeof terminal>;
const closing: (() => void)[] = [];

/** A terminal with no CLI: records the calls, and emits only the screen and bytes given here. */
function terminal() {
  const views = new Set<(event: TerminalEvent) => void>();
  const input = vi.fn<TerminalScreen['input']>();
  const resize = vi.fn<TerminalScreen['resize']>();
  const paste = vi.fn<TerminalScreen['paste']>();
  const connector: Connector = {
    start: () =>
      Promise.resolve({
        send: () => Promise.resolve(),
        answer: () => Promise.resolve(),
        interrupt: () => Promise.resolve(),
        setMode: () => Promise.resolve(),
        setModel: () => Promise.resolve(),
        close: () => Promise.resolve(),
        terminal: {
          input,
          resize,
          paste,
          show: (view) => {
            views.add(view);
            view({ type: 'screen', data: 'hello', cols: 80, rows: 24 });
            return () => {
              views.delete(view);
            };
          },
        },
      }),
  };
  return {
    input,
    resize,
    paste,
    connector,
    emit: (event: TerminalEvent) => {
      for (const view of views) view(event);
    },
  };
}

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-terminal-'));
  const folder = path.join(profile, 'project');
  await mkdir(folder);
  const canvas = newCanvasId();
  const file = path.join(profile, 'terminal.corral');
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: canvas,
      nodes: [
        {
          id: agent,
          kind: 'agent',
          label: 'Terminal',
          adapter: 'codex',
          connection: 'codex.terminal',
          position: { x: 0, y: 0 },
        },
      ],
      links: [],
    }),
  );
  await keepCanvases(profile, { [canvas]: { file, project: folder } });
  await openedLast(profile, canvas);
  screen = terminal();
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '1.0.0' },
      check: true,
      distribution: 'local',
      sessions: {
        connectors: { 'codex.terminal': screen.connector },
        environment: () => Promise.resolve({}),
      },
    },
    { ...NO_DESKTOP, pickFolder: () => Promise.resolve(mintTrustedPath(folder)) },
  );
  const shown = await core.call('window.get', {}, YOU);
  if (!shown.ok) throw new Error(shown.error.sentence);
  await core.call('project.choose', { canvas: shown.value.canvas }, YOU);
});

afterEach(async () => {
  for (const close of closing.splice(0)) close();
  await core.close();
  await rm(profile, { recursive: true, force: true });
});

const start = async () => {
  const shown = await core.call('window.get', {}, YOU);
  if (!shown.ok) throw new Error(shown.error.sentence);
  const canvas = shown.value.canvas;
  const answer = await core.call('session.open', { canvas, agent }, YOU);
  if (!answer.ok) throw new Error(answer.error.sentence);
};
const ok = { ok: true, value: { revs: {} } };

describe('terminal operations', () => {
  it('passes keystrokes, including control characters, and sizes to the calling window’s terminal', async () => {
    await start();
    expect(await core.call('terminal.input', { agent, data: '\x1b[Z\x03' }, YOU)).toEqual(ok);
    expect(await core.call('terminal.resize', { agent, cols: 120, rows: 40 }, YOU)).toEqual(ok);
    expect(screen.input).toHaveBeenCalledExactlyOnceWith('\x1b[Z\x03');
    expect(screen.resize).toHaveBeenCalledExactlyOnceWith(120, 40);
    await core.call('canvas.create', {}, EIGHT);
    expect(await core.call('terminal.input', { agent, data: 'other' }, EIGHT)).toEqual(ok);
    expect(screen.input).toHaveBeenCalledOnce();
  });

  it('streams the screen, bytes and exit over the window’s port, until detached', async () => {
    await core.call('canvas.create', {}, EIGHT);
    const served = new WindowPorts(core);
    const seven = openWindow(served, 7);
    const eight = openWindow(served, 8);
    closing.push(seven.close, eight.close);
    const heard = vi.fn();
    const other = vi.fn();
    seven.link.on('event', heard);
    eight.link.on('event', other);
    expect(await core.call('terminal.attach', { agent }, YOU)).toEqual(ok);
    await start();
    await vi.waitFor(() => {
      expect(heard).toHaveBeenCalledWith('terminal', [
        'a',
        { type: 'screen', data: 'hello', cols: 80, rows: 24 },
      ]);
    });
    screen.emit({ type: 'output', data: '\x1b[31mred' });
    screen.emit({ type: 'exit', code: 0 });
    await vi.waitFor(() => {
      expect(heard).toHaveBeenCalledTimes(3);
    });
    expect(heard.mock.calls).toEqual([
      ['terminal', ['a', { type: 'screen', data: 'hello', cols: 80, rows: 24 }]],
      ['terminal', ['a', { type: 'output', data: '\x1b[31mred' }]],
      ['terminal', ['a', { type: 'exit', code: 0 }]],
    ]);
    expect(other).not.toHaveBeenCalled();
    expect(await core.call('terminal.detach', { agent }, YOU)).toEqual(ok);
    screen.emit({ type: 'output', data: 'after detach' });
    await seven.link.request('call', 'app.info', {});
    expect(heard).toHaveBeenCalledTimes(3);
  });

  it('pastes only existing dropped files, quoted, and ignores a terminal that is not running', async () => {
    await start();
    const file = path.join(profile, "Screen Shot's.png");
    await writeFile(file, 'png');
    const missing = path.join(profile, 'missing.png');
    expect(await core.call('terminal.drop', { agent, paths: [file, missing] }, YOU)).toEqual(ok);
    expect(screen.paste).toHaveBeenCalledExactlyOnceWith(`${quotePath(file)} `);
    expect(await core.call('terminal.drop', { agent, paths: [missing] }, YOU)).toEqual(ok);
    expect(await core.call('terminal.drop', { agent: 'b', paths: [file] }, YOU)).toEqual(ok);
    expect(screen.paste).toHaveBeenCalledOnce();
  });

  it.each([
    ['terminal.attach', {}],
    ['terminal.attach', { agent: {} }],
    ['terminal.detach', { agent, extra: true }],
    ['terminal.input', { agent, data: '' }],
    ['terminal.input', { agent, data: [13] }],
    ['terminal.input', { agent, data: 'x'.repeat(MAX_TERMINAL_INPUT + 1) }],
    ['terminal.resize', { agent }],
    ['terminal.resize', { agent, cols: 80.5, rows: 24 }],
    ['terminal.resize', { agent, cols: 80, rows: 0 }],
    ['terminal.resize', { agent, cols: MAX_TERMINAL_COLS + 1, rows: 24 }],
    ['terminal.resize', { agent, cols: 80, rows: MAX_TERMINAL_ROWS + 1 }],
    ['terminal.resize', { agent, cols: '80', rows: 24 }],
    ['terminal.drop', { agent, paths: [] }],
    ['terminal.drop', { agent, paths: '/Users/me/a.png' }],
    [
      'terminal.drop',
      {
        agent,
        paths: Array.from({ length: MAX_DROPPED_FILES + 1 }, (_, i) => `/f${String(i)}`),
      },
    ],
    ['terminal.drop', { agent, paths: ['shot.png'] }],
    ['terminal.drop', { agent, paths: ['/a\n/b.png'] }],
    ['terminal.drop', { agent, paths: ['/a\x00/b.png'] }],
    ['terminal.drop', { agent, paths: ['/a\x7f/b.png'] }],
    ['terminal.drop', { agent, paths: [42] }],
    ['terminal.drop', { agent, paths: [`/${'x'.repeat(MAX_DROPPED_PATH)}`] }],
    ['terminal.input', { agent, data: 'keys', window: 8 }],
    ['terminal.attach', { agent, canvas: crypto.randomUUID() }],
  ])('refuses invalid %s arguments before affecting a terminal', async (op, args) => {
    await start();
    expect(await core.call(op as never, args, YOU)).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    });
    expect(screen.input).not.toHaveBeenCalled();
    expect(screen.resize).not.toHaveBeenCalled();
    expect(screen.paste).not.toHaveBeenCalled();
  });
});
