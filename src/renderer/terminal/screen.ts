import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

/*
 * The terminal an agent's view shows (xterm.js), behind a small interface so that the view's logic
 * (link.ts) can be tested without one.
 *
 * Under the production CSP (no inline styles), xterm.js draws only with its WebGL renderer: its DOM
 * renderer styles its cells with inline styles, which the CSP blocks. The WebGL addon is loaded
 * before the terminal opens, so that no DOM renderer is ever made (and again if the GPU loses
 * the context).
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
  /** Links the user opens: an http(s) link (OSC 8, or a URL in the text) Cmd-clicked. */
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

export const createScreen: ScreenFactory = (element) => {
  const links = new Set<(url: string) => void>();
  const open = (event: MouseEvent, url: string) => {
    if (!opensLink(event)) return;
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
    // Links (OSC 8, http and https only) open as the app's other links do: main asks first.
    linkHandler: { activate: open },
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
  const webgl = (): WebglAddon => {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      addon.dispose();
      terminal.loadAddon(webgl());
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
  terminal.open(element);
  let disposed = false;

  return {
    reset: ({ data, cols, rows }, done) => {
      terminal.reset();
      if (terminal.cols !== cols || terminal.rows !== rows) terminal.resize(cols, rows);
      terminal.write(data, done);
    },
    write: (data) => {
      terminal.write(data);
    },
    fit: () => {
      fit.fit();
    },
    redraw: () => {
      requestAnimationFrame(() => {
        if (disposed) return;
        fit.fit();
        terminal.clearTextureAtlas();
        terminal.refresh(0, terminal.rows - 1);
      });
    },
    setOptionIsMeta: (on) => {
      terminal.options.macOptionIsMeta = on;
    },
    focus: () => {
      terminal.focus();
    },
    onInput: (listener) => {
      inputs.add(listener);
    },
    onLink: (listener) => {
      links.add(listener);
    },
    onResize: (listener) => {
      terminal.onResize(({ cols, rows }) => {
        listener(cols, rows);
      });
    },
    dispose: () => {
      disposed = true;
      inputs.clear();
      links.clear();
      terminal.dispose();
    },
  };
};
