import { vi } from 'vitest';

import type { TerminalEvent } from '../../shared/terminal';
import type { TerminalBackend } from './backend';
import type { Screen, Snapshot } from './screen';

/*
 * For tests: a terminal (screen.ts) without xterm.js, which jsdom cannot draw, and main's
 * terminals faked (backend.ts). Mock the screen module with `createScreen: fakeScreens.create`.
 * And keyboard layouts, as the Keyboard API gives them (keyboard.ts).
 */

/** A terminal that records what it shows. */
export class FakeScreen implements Screen {
  readonly element: HTMLElement;
  /** Everything written to it since its last reset, the snapshot first. */
  shown = '';
  size = { cols: 80, rows: 24 };
  /** The size fitting its element would give it. */
  fits = { cols: 80, rows: 24 };
  focused = false;
  disposed = false;
  /** How often it was drawn afresh (see Screen.redraw). */
  redraws = 0;
  /** Whether Option works as Meta in it (see Screen.setOptionIsMeta). */
  optionIsMeta = false;
  /** Snapshots written and not yet done (see `finish`). */
  readonly #pending: (() => void)[] = [];
  readonly #inputs: ((data: string) => void)[] = [];
  readonly #resizes: ((cols: number, rows: number) => void)[] = [];

  constructor(element: HTMLElement) {
    this.element = element;
  }

  reset({ data, cols, rows }: Snapshot, done: () => void): void {
    this.shown = data;
    this.#resize(cols, rows);
    this.#pending.push(done);
  }

  /** The snapshots written are on screen. */
  finish(): void {
    for (const done of this.#pending.splice(0)) done();
  }

  write(data: string): void {
    this.shown += data;
  }

  fit(): void {
    this.#resize(this.fits.cols, this.fits.rows);
  }

  redraw(): void {
    this.redraws += 1;
  }

  setOptionIsMeta(on: boolean): void {
    this.optionIsMeta = on;
  }

  focus(): void {
    this.focused = true;
  }

  onInput(listener: (data: string) => void): void {
    this.#inputs.push(listener);
  }

  onResize(listener: (cols: number, rows: number) => void): void {
    this.#resizes.push(listener);
  }

  /** The user types `data` in it (or it answers a query). */
  type(data: string): void {
    for (const listener of this.#inputs) listener(data);
  }

  dispose(): void {
    this.disposed = true;
  }

  #resize(cols: number, rows: number): void {
    if (cols === this.size.cols && rows === this.size.rows) return;
    this.size = { cols, rows };
    for (const listener of this.#resizes) listener(cols, rows);
  }
}

/** Every fake terminal made, the latest last. */
export const fakeScreens = {
  made: [] as FakeScreen[],
  create: (element: HTMLElement): Screen => {
    const screen = new FakeScreen(element);
    fakeScreens.made.push(screen);
    return screen;
  },
  latest(): FakeScreen {
    const screen = fakeScreens.made.at(-1);
    if (!screen) throw new Error('no terminal was made');
    return screen;
  },
};

/** Main's terminals, faked: records what the renderer asks; `emit` plays events back. */
export function fakeTerminals() {
  let listener: ((agentId: string, event: TerminalEvent) => void) | undefined;
  const backend = {
    attach: vi.fn<TerminalBackend['attach']>().mockResolvedValue(null),
    detach: vi.fn<TerminalBackend['detach']>().mockResolvedValue(null),
    write: vi.fn<TerminalBackend['write']>().mockResolvedValue(null),
    resize: vi.fn<TerminalBackend['resize']>().mockResolvedValue(null),
    drop: vi.fn<TerminalBackend['drop']>().mockResolvedValue(null),
    onEvent: vi.fn<TerminalBackend['onEvent']>((given) => {
      listener = given;
      return () => {
        listener = undefined;
      };
    }),
  };
  return {
    backend,
    emit: (agentId: string, ...events: TerminalEvent[]) => {
      for (const event of events) listener?.(agentId, event);
    },
    listening: () => listener !== undefined,
  };
}

/** A keyboard layout map: the US one, with `changes` (key code → what that key types instead). */
export function keyboardLayout(changes: Record<string, string> = {}): Map<string, string> {
  const keys = new Map<string, string>();
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') keys.set(`Key${letter.toUpperCase()}`, letter);
  for (const digit of '0123456789') keys.set(`Digit${digit}`, digit);
  for (const [code, key] of Object.entries({
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`',
    IntlBackslash: '§',
  })) {
    keys.set(code, key);
  }
  for (const [code, key] of Object.entries(changes)) keys.set(code, key);
  return keys;
}

/** Gives the page a Mac's keyboard with `layout` (the Keyboard API); returns a function that undoes it. */
export function macKeyboard(layout: Map<string, string>): () => void {
  const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  Object.defineProperty(navigator, 'keyboard', {
    configurable: true,
    value: { getLayoutMap: () => Promise.resolve(layout) },
  });
  return () => {
    platform.mockRestore();
    Reflect.deleteProperty(navigator, 'keyboard');
  };
}
