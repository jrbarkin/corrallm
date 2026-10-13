import { vi } from 'vitest';

import type { TerminalEvent } from '../../shared/terminal';
import type { TerminalBackend } from './backend';
import type { Screen, Snapshot } from './screen';

/*
 * For tests: a terminal (screen.ts) without xterm.js, which jsdom cannot draw, and main's
 * terminals faked (backend.ts). Mock the screen module with `createScreen: fakeScreens.create`.
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
  /** Snapshots written and not yet done (see `finish`). */
  readonly #pending: (() => void)[] = [];
  readonly #inputs: ((data: string) => void)[] = [];
  readonly #links: ((url: string) => void)[] = [];
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

  focus(): void {
    this.focused = true;
  }

  onInput(listener: (data: string) => void): void {
    this.#inputs.push(listener);
  }

  onResize(listener: (cols: number, rows: number) => void): void {
    this.#resizes.push(listener);
  }

  onLink(listener: (url: string) => void): void {
    this.#links.push(listener);
  }

  /** The user opens a link shown in it (Cmd-clicks it). */
  openLink(url: string): void {
    for (const listener of this.#links) listener(url);
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
