import { MAX_TERMINAL_INPUT } from '../../shared/terminal';
import type { TerminalEvent } from '../../shared/terminal';
import type { TerminalBackend } from './backend';
import type { Screen } from './screen';

/*
 * Links an agent's terminal view to its terminal in the main process: the view starts from the
 * screen main sends (a snapshot), then writes what the CLI prints; what the user types goes back
 * as keystrokes, and the view's size to the terminal. While the snapshot is written, what the view
 * would answer the queries in it is dropped: the CLI asked those of an earlier view, long ago.
 */

/** Whether the view shows a running CLI: not yet (or none runs), yes, or one that exited. */
export type LinkState =
  { kind: 'waiting' } | { kind: 'live' } | { kind: 'exited'; code: number | null };

export class TerminalLink {
  readonly #agentId: string;
  readonly #backend: TerminalBackend;
  readonly #screen: Screen;
  readonly #onState: (state: LinkState) => void;
  /** Whether keystrokes and sizes go to the CLI: it runs, and its screen is shown. */
  #live = false;
  /** Which screen main sent is shown: one sent while another is written replaces it. */
  #shown = 0;
  #unsubscribe: (() => void) | undefined;

  constructor(
    agentId: string,
    backend: TerminalBackend,
    screen: Screen,
    onState: (state: LinkState) => void,
  ) {
    this.#agentId = agentId;
    this.#backend = backend;
    this.#screen = screen;
    this.#onState = onState;
  }

  /** Starts showing the agent's terminal. */
  start(): void {
    this.#unsubscribe = this.#backend.onEvent((agentId, event) => {
      if (agentId === this.#agentId) this.#receive(event);
    });
    this.#screen.onInput((data) => {
      this.#input(data);
    });
    this.#screen.onResize((cols, rows) => {
      if (this.#live) this.#backend.resize(this.#agentId, cols, rows).catch(ignore);
    });
    this.#backend.attach(this.#agentId).catch(ignore);
  }

  stop(): void {
    this.#live = false;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#backend.detach(this.#agentId).catch(ignore);
  }

  #receive(event: TerminalEvent): void {
    switch (event.type) {
      case 'screen': {
        this.#live = false;
        const shown = ++this.#shown;
        this.#screen.reset(event, () => {
          if (shown !== this.#shown) return;
          this.#live = true;
          this.#onState({ kind: 'live' });
          // The CLI takes the view's size, and the screen is drawn afresh at it.
          this.#screen.fit();
          this.#screen.redraw();
        });
        return;
      }
      case 'output':
        this.#screen.write(event.data);
        return;
      case 'exit':
        this.#live = false;
        this.#onState({ kind: 'exited', code: event.code });
        return;
    }
  }

  /** Files dropped on the view: their paths go to the CLI, pasted (while it runs). */
  drop(files: readonly File[]): void {
    if (!this.#live || files.length === 0) return;
    this.#backend.drop(this.#agentId, files).catch(ignore);
    this.#screen.focus();
  }

  #input(data: string): void {
    if (!this.#live) return;
    for (let at = 0; at < data.length; at += MAX_TERMINAL_INPUT) {
      this.#backend.write(this.#agentId, data.slice(at, at + MAX_TERMINAL_INPUT)).catch(ignore);
    }
  }
}

/** A terminal request that failed: its session went meanwhile, which the view hears anyway. */
function ignore(): void {
  // Nothing to do.
}
