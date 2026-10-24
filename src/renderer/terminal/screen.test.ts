import { within } from '@testing-library/react';
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
