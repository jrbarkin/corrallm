import { within } from '@testing-library/react';
import type * as WebLinks from '@xterm/addon-web-links';
import type * as Webgl from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createScreen } from './screen';
import type { Screen } from './screen';

/*
 * The terminal itself (xterm.js), where the page has WebGL2 and where it has none. jsdom has no
 * WebGL: the canvas's contexts are faked (`gpu.webgl2`), and where they work the WebGL addon draws
 * nothing (the real one, otherwise: it fails as on a machine without WebGL2).
 */

const gpu = vi.hoisted(() => {
  const gpu = {
    /** Whether a canvas gives the page a WebGL2 context. */
    webgl2: true,
    /** What the WebGL addons loaded hear when the GPU loses their context. */
    lost: [] as (() => void)[],
    terminal: undefined as Terminal | undefined,
  };
  // From the start: xterm.js asks for a 2D context as it loads (none, here).
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((kind: string) =>
    kind === 'webgl2' && gpu.webgl2
      ? { getExtension: () => null }
      : null) as unknown as HTMLCanvasElement['getContext']);
  return gpu;
});

vi.mock('@xterm/addon-webgl', async (importOriginal) => {
  const real = await importOriginal<typeof Webgl>();
  class WebglAddon extends real.WebglAddon {
    override activate(terminal: Terminal): void {
      gpu.terminal = terminal;
      // Where WebGL2 works, a renderer jsdom can run: none (xterm.js keeps its own).
      if (!gpu.webgl2) super.activate(terminal);
    }
    override readonly onContextLoss = (listener: () => void) => {
      gpu.lost.push(listener);
      return {
        dispose: () => {
          gpu.lost = gpu.lost.filter((other) => other !== listener);
        },
      };
    };
  }
  return { WebglAddon };
});

/** What the terminal's URL links addon was given to open a link the user clicks with. */
const webLinks = vi.hoisted(() => ({
  open: undefined as ((event: MouseEvent, uri: string) => void) | undefined,
}));

vi.mock('@xterm/addon-web-links', async (importOriginal) => {
  const real = await importOriginal<typeof WebLinks>();
  class WebLinksAddon extends real.WebLinksAddon {
    constructor(...args: ConstructorParameters<typeof real.WebLinksAddon>) {
      super(...args);
      webLinks.open = args[0];
    }
  }
  return { WebLinksAddon };
});

/** The GPU loses the context: as xterm.js's events do, a listener's error goes no further. */
function loseContext(): void {
  for (const listener of gpu.lost.splice(0)) {
    try {
      listener();
    } catch {
      // xterm.js reports it as an unexpected error, later.
    }
  }
}

const shown: Screen[] = [];

beforeEach(() => {
  gpu.webgl2 = true;
  gpu.lost = [];
  gpu.terminal = undefined;
  // xterm.js follows the device pixel ratio with a media query, which jsdom does not evaluate.
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

afterEach(() => {
  for (const screen of shown.splice(0)) screen.dispose();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** A terminal, made in an element on the page. */
function make(): { element: HTMLElement; screen: Screen } {
  const element = document.createElement('div');
  document.body.append(element);
  const screen = createScreen(element);
  shown.push(screen);
  return { element, screen };
}

const NEEDS_WEBGL2 = /needs WebGL2/;

it('releases a closed view’s WebGL contexts after disposing its terminal, once only', () => {
  const { element, screen } = make();
  const canvas = document.createElement('canvas');
  element.querySelector('.xterm-screen')?.append(canvas);
  const overlay = document.createElement('canvas');
  overlay.className = 'xterm-link-layer';
  const readOverlay = vi.fn(() => {
    throw new Error('A 2D overlay must not be asked for another context kind');
  });
  Object.defineProperty(overlay, 'getContext', { value: readOverlay });
  element.querySelector('.xterm-screen')?.append(overlay);
  const release = vi.fn(() => {
    // A release may report context loss later: xterm must have detached first.
    expect(element.querySelector('.xterm')).toBeNull();
    loseContext();
  });
  const extension = vi.fn((name: string) =>
    name === 'WEBGL_lose_context' ? { loseContext: release } : null,
  );
  Object.defineProperty(canvas, 'getContext', {
    value: () => ({ getExtension: extension }),
  });
  screen.dispose();
  expect(extension).toHaveBeenCalledWith('WEBGL_lose_context');
  expect(release).toHaveBeenCalledOnce();
  expect(readOverlay).not.toHaveBeenCalled();
  expect(gpu.lost).toHaveLength(0);
  screen.dispose();
  expect(release).toHaveBeenCalledOnce();
});

it('ignores a queued context-loss notification after the screen has been disposed', () => {
  const { element, screen } = make();
  screen.dispose();
  loseContext();
  expect(gpu.lost).toHaveLength(0);
  expect(element.querySelector('.xterm')).toBeNull();
  expect(within(element).queryByRole('alert')).toBeNull();
});

it('releases only the closing terminal’s contexts, leaving another view drawn', () => {
  const first = make();
  const second = make();
  const releases = [vi.fn(), vi.fn()];
  for (const [index, { element }] of [first, second].entries()) {
    const canvas = document.createElement('canvas');
    element.querySelector('.xterm-screen')?.append(canvas);
    Object.defineProperty(canvas, 'getContext', {
      value: () => ({ getExtension: () => ({ loseContext: releases[index] }) }),
    });
  }
  first.screen.dispose();
  expect(releases[0]).toHaveBeenCalledOnce();
  expect(releases[1]).not.toHaveBeenCalled();
  expect(second.element.querySelector('.xterm')).not.toBeNull();
  expect(within(second.element).queryByRole('alert')).toBeNull();
});

it('draws the terminal where the page has WebGL2, and again with a new context when the GPU loses its own', () => {
  const { element } = make();
  expect(element.querySelector('.xterm')).not.toBeNull();
  expect(gpu.lost).toHaveLength(1);
  loseContext();
  expect(gpu.lost).toHaveLength(1);
  expect(element.querySelector('.xterm')).not.toBeNull();
  expect(within(element).queryByRole('alert')).toBeNull();
});

it('says the terminal needs WebGL2, and what to try, where the page cannot make a WebGL2 context: no terminal is drawn', () => {
  gpu.webgl2 = false;
  const { element, screen } = make();
  const alert = within(element).getByRole('alert');
  expect(alert.textContent).toMatch(NEEDS_WEBGL2);
  expect(alert.textContent).toMatch(/3D acceleration/);
  // Never xterm.js's DOM renderer, whose inline styles the production CSP blocks.
  expect(element.querySelector('.xterm')).toBeNull();
  // The view goes on with its CLI: a snapshot is done at once, and nothing written is drawn.
  const done = vi.fn();
  screen.reset({ data: 'Claude Code\r\n', cols: 80, rows: 24 }, done);
  expect(done).toHaveBeenCalledOnce();
  screen.write('more');
  screen.fit();
  screen.redraw();
  screen.focus();
  expect(element.querySelector('.xterm')).toBeNull();
});

it.each([
  ['macOS', 'Macintosh; Intel Mac OS X 10_15_7', { metaKey: true }, { ctrlKey: true }],
  ['Linux', 'X11; Linux aarch64', { ctrlKey: true }, { metaKey: true }],
  ['Windows', 'Windows NT 10.0; Win64; x64', { ctrlKey: true }, { metaKey: true }],
])(
  'on %s, opens a link clicked with its modifier, as a terminal there does: not plainly, nor with the other',
  (_os, platform, opens, other) => {
    const agent = vi
      .spyOn(navigator, 'userAgent', 'get')
      .mockReturnValue(
        `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0 Safari/537.36`,
      );
    const { screen } = make();
    const opened: string[] = [];
    screen.onLink((url) => opened.push(url));
    const open = webLinks.open;
    if (!open) throw new Error('no URL links');
    open(new MouseEvent('mouseup'), 'https://docs.example.com/plain');
    open(new MouseEvent('mouseup', other), 'https://docs.example.com/other');
    open(new MouseEvent('mouseup', opens), 'https://docs.example.com/hooks');
    const handler = gpu.terminal?.options.linkHandler;
    if (!handler) throw new Error('no OSC 8 link handler');
    const range = { start: { x: 1, y: 1 }, end: { x: 9, y: 1 } };
    const file = 'file:///project/notes.txt';
    handler.activate(new MouseEvent('mouseup'), file, range);
    handler.activate(new MouseEvent('mouseup', other), file, range);
    handler.activate(new MouseEvent('mouseup', opens), file, range);
    expect(opened).toEqual(['https://docs.example.com/hooks', file]);
    agent.mockRestore();
  },
);

it('says so too when the GPU loses its context and no new WebGL2 context can be made', () => {
  const { element, screen } = make();
  expect(element.querySelector('.xterm')).not.toBeNull();
  gpu.webgl2 = false;
  loseContext();
  expect(within(element).getByRole('alert').textContent).toMatch(NEEDS_WEBGL2);
  expect(element.querySelector('.xterm')).toBeNull();
  const done = vi.fn();
  screen.reset({ data: 'Claude Code\r\n', cols: 80, rows: 24 }, done);
  expect(done).toHaveBeenCalledOnce();
  screen.write('more');
  screen.fit();
  screen.focus();
  expect(element.querySelector('.xterm')).toBeNull();
  // Its view lets it go: the notice goes with it.
  screen.dispose();
  expect(within(element).queryByRole('alert')).toBeNull();
});

/** Presses Shift+Enter in the terminal (a keydown, then a keyup); what it typed meanwhile. */
function shiftEnter(element: HTMLElement, typed: string[]): string[] {
  typed.length = 0;
  const target = element.querySelector('textarea');
  if (!target) throw new Error('no terminal');
  for (const type of ['keydown', 'keyup']) {
    target.dispatchEvent(
      new KeyboardEvent(type, {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  }
  return [...typed];
}

it('types the connection’s Shift+Enter once, on keydown; the terminal’s own Enter where none is declared', () => {
  const { element, screen } = make();
  const typed: string[] = [];
  screen.onInput((data) => typed.push(data));
  // Nothing is declared yet: the terminal does as it does, whatever another CLI binds.
  expect(shiftEnter(element, typed)).toEqual(['\r']);
  screen.setKeys({ shiftEnter: '\x1b[13;2u' });
  expect(shiftEnter(element, typed)).toEqual(['\x1b[13;2u']);
  // A real switch replaces it; null hands the key back to the terminal.
  screen.setKeys({ shiftEnter: '\x1b\r' });
  expect(shiftEnter(element, typed)).toEqual(['\x1b\r']);
  screen.setKeys({ shiftEnter: null });
  expect(shiftEnter(element, typed)).toEqual(['\r']);
});

it('leaves every other Enter to the terminal with keys declared: plain, keyup alone, Ctrl+Shift and Cmd+Shift', () => {
  const press = (
    element: HTMLElement,
    typed: string[],
    types: string[],
    modifiers: KeyboardEventInit,
  ) => {
    typed.length = 0;
    const target = element.querySelector('textarea');
    if (!target) throw new Error('no terminal');
    for (const type of types) {
      target.dispatchEvent(
        new KeyboardEvent(type, {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          bubbles: true,
          cancelable: true,
          ...modifiers,
        }),
      );
    }
    return [...typed];
  };
  const cases: [string, string[], KeyboardEventInit][] = [
    ['plain Enter', ['keydown', 'keyup'], {}],
    ['a Shift+Enter keyup alone', ['keyup'], { shiftKey: true }],
    ['Ctrl+Shift+Enter', ['keydown', 'keyup'], { ctrlKey: true, shiftKey: true }],
    ['Cmd+Shift+Enter', ['keydown', 'keyup'], { metaKey: true, shiftKey: true }],
  ];
  for (const [name, types, modifiers] of cases) {
    const native = make();
    const declared = make();
    const nativeTyped: string[] = [];
    const declaredTyped: string[] = [];
    native.screen.onInput((data) => nativeTyped.push(data));
    declared.screen.onInput((data) => declaredTyped.push(data));
    declared.screen.setKeys({ shiftEnter: '\x1b[13;2u' });
    const expected = press(native.element, nativeTyped, types, modifiers);
    const got = press(declared.element, declaredTyped, types, modifiers);
    // As the terminal does it on its own, and never the declared sequence.
    expect(got, name).toEqual(expected);
    expect(got, name).not.toContain('\x1b[13;2u');
    if (name === 'plain Enter') expect(got).toEqual(['\r']);
  }
});
