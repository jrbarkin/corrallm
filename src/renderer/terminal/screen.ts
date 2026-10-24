import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { linkAction } from '../open-link';

/*
 * The terminal an agent's view shows (xterm.js), behind a small interface so that the view's logic
 * (link.ts) can be tested without one.
 *
 * Under the production CSP (no inline styles), xterm.js draws only with its WebGL renderer: its DOM
 * renderer styles its cells with inline styles, which the CSP blocks. The WebGL addon is loaded
 * before the terminal opens, so that no DOM renderer is ever made (and again if the GPU loses
 * the context). Where the page has no WebGL2 (a virtual machine without 3D acceleration, remote
 * desktop, a blocklisted GPU), as the terminal opens or once a lost context cannot be replaced,
 * it is not drawn at all: in its place the view says that it needs WebGL2, and what to try.
 */

/** The screen as main took it: written to a terminal of its size, it shows the same. */
export interface Snapshot {
  data: string;
  cols: number;
  rows: number;
}

export interface Screen {
  /** Shows a snapshot from scratch, at its size; `done` once it is on screen. */
  reset(snapshot: Snapshot, done: () => void): void;
  /** Writes what the CLI printed. */
  write(data: string): void;
  /** Fits the terminal to its element; `onResize` hears if that changed its size. */
  fit(): void;
  /**
   * Draws the whole screen afresh, fitted again once the view has laid it out: after a reset, the
   * renderer may still draw at the size and place it had before (a new CLI's screen came at
   * main's size, then the view's).
   */
  redraw(): void;
  /**
   * Whether Option works as Meta (macOS): for Claude Code's Option shortcuts, or not, to type the
   * characters it types on the user's layout (keyboard.ts).
   */
  setOptionIsMeta(on: boolean): void;
  focus(): void;
  /** What the user types (and what the terminal answers the CLI's queries with). */
  onInput(listener: (data: string) => void): void;
  /**
   * Links the user opens: an http(s) link (OSC 8, or a URL in the text) or a file:// link (OSC 8)
   * Cmd-clicked.
   */
  onLink(listener: (url: string) => void): void;
  onResize(listener: (cols: number, rows: number) => void): void;
  dispose(): void;
}

export type ScreenFactory = (element: HTMLElement) => Screen;

/**
 * A dark terminal, whatever the app's theme: Claude Code's own colours are made for one (its
 * default theme is dark). The scrollbar's colours are set too, so the style xterm.js writes for
 * them is always the same (its hash is allowed by the CSP: src/main/csp.ts).
 */
export const THEME = {
  background: '#1c1c1f',
  foreground: '#e4e4e7',
  cursor: '#e4e4e7',
  cursorAccent: '#1c1c1f',
  selectionBackground: '#3f3f46',
  scrollbarSliderBackground: '#ffffff33',
  scrollbarSliderHoverBackground: '#ffffff59',
  scrollbarSliderActiveBackground: '#ffffff80',
};

/** Shift+Enter: a new line in Claude Code's prompt, as its /terminal-setup binds it. */
const NEW_LINE = '\x1b\r';

/** Whether a click opens a link, as in a terminal: with Cmd (Ctrl on Windows and Linux). */
const opensLink = (event: MouseEvent) =>
  navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey;

/** Whether the page can make the WebGL2 context xterm.js's WebGL renderer draws with (as it asks). */
function hasWebGL2(): boolean {
  const gl = document.createElement('canvas').getContext('webgl2', {
    antialias: false,
    depth: false,
  });
  // Only a check: its context goes at once (a page has only so many).
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  return gl !== null;
}

/** What the view shows in the terminal's place where it cannot be drawn: why, and what to try. */
function needsWebGL2(): HTMLElement {
  const notice = document.createElement('div');
  notice.className = 'agent-terminal-unavailable';
  notice.setAttribute('role', 'alert');
  const why = document.createElement('p');
  why.textContent = 'This terminal needs WebGL2, which isn’t available here.';
  const tips = document.createElement('p');
  tips.textContent =
    'corrallm draws terminals with the GPU. In a virtual machine, turn on 3D acceleration; over ' +
    'remote desktop, try the computer’s own display; or update its graphics driver. Then close ' +
    'this view and open it again, or restart corrallm. The CLI keeps running meanwhile.';
  notice.append(why, tips);
  return notice;
}

export const createScreen: ScreenFactory = (element) => {
  const links = new Set<(url: string) => void>();
  const open = (event: MouseEvent, url: string) => {
    // Only links that go anywhere: http(s), and file:// (shown in the file manager).
    if (!opensLink(event) || linkAction(url) === undefined) return;
    for (const listener of links) listener(url);
  };
  const terminal = new Terminal({
    // Unicode 11 widths, as main's copy of the screen measures them.
    allowProposedApi: true,
    cursorBlink: true,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
    fontSize: 13,
    scrollback: 5000,
    // Option types characters until the view says otherwise (setOptionIsMeta).
    macOptionIsMeta: false,
    theme: THEME,
    // Links (OSC 8) open as the app's other links do (main asks first); a file:// link (as Claude
    // Code prints the files it names) shows its file in the file manager, if in the project folder.
    linkHandler: { activate: open, allowNonHttpProtocols: true },
  });
  const inputs = new Set<(data: string) => void>();
  const type = (data: string) => {
    for (const listener of inputs) listener(data);
  };
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(new WebLinksAddon(open));
  /** Whether the terminal is drawn: not once disposed of, nor without WebGL2 to draw it with. */
  let drawn = true;
  /** What says, in its place, that it needs WebGL2. */
  let notice: HTMLElement | undefined;
  /** Never xterm.js's DOM renderer: the terminal goes, and the view says why. */
  const undraw = () => {
    drawn = false;
    terminal.dispose();
    notice = needsWebGL2();
    element.append(notice);
  };
  const webgl = (): WebglAddon => {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      addon.dispose();
      try {
        terminal.loadAddon(webgl());
      } catch {
        // No new context: the GPU went, or was blocklisted after it crashed.
        undraw();
      }
    });
    return addon;
  };
  terminal.loadAddon(webgl());
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.metaKey) {
      if (event.type === 'keydown') {
        event.preventDefault();
        type(NEW_LINE);
      }
      return false;
    }
    return true;
  });
  terminal.onData(type);
  if (hasWebGL2()) terminal.open(element);
  else undraw();

  // Undrawn, the view goes on with its CLI: a snapshot is done at once, and nothing is drawn.
  return {
    reset: ({ data, cols, rows }, done) => {
      if (!drawn) {
        done();
        return;
      }
      terminal.reset();
      if (terminal.cols !== cols || terminal.rows !== rows) terminal.resize(cols, rows);
      terminal.write(data, done);
    },
    write: (data) => {
      if (drawn) terminal.write(data);
    },
    fit: () => {
      if (drawn) fit.fit();
    },
    redraw: () => {
      requestAnimationFrame(() => {
        if (!drawn) return;
        fit.fit();
        terminal.clearTextureAtlas();
        terminal.refresh(0, terminal.rows - 1);
      });
    },
    setOptionIsMeta: (on) => {
      if (drawn) terminal.options.macOptionIsMeta = on;
    },
    focus: () => {
      if (drawn) terminal.focus();
    },
    onInput: (listener) => {
      inputs.add(listener);
    },
    onLink: (listener) => {
      links.add(listener);
    },
    onResize: (listener) => {
      if (!drawn) return;
      terminal.onResize(({ cols, rows }) => {
        listener(cols, rows);
      });
    },
    dispose: () => {
      inputs.clear();
      links.clear();
      notice?.remove();
      if (!drawn) return;
      drawn = false;
      terminal.dispose();
    },
  };
};
