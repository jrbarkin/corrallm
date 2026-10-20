import { HOOK_TOKEN } from '../../terminal/hooks';
import type { Pty, PtyOptions } from '../../terminal/pty';
import { recordedTerminal } from './recorded';
import type { TerminalFixture, TerminalRecord } from './recorded';
import { PASTE_END, PASTE_START } from './tui';

/** How much faster than recorded a recording plays. */
const SPEED = 50;

/**
 * A pseudo-terminal that plays a recording of Codex's TUI, but for what `without` leaves out (as a
 * hook Codex runs for no turn that errs).
 */
export class Replay implements Pty {
  readonly pid = 4242;
  readonly written: string[] = [];
  readonly args: readonly string[];
  readonly options: PtyOptions;
  readonly #records: TerminalRecord[];
  readonly #data = new Set<(data: string) => void>();
  readonly #exit = new Set<(exit: { exitCode: number }) => void>();
  /** Writes not yet matched against the keys the recording waits for. */
  #unread: string[] = [];
  #wake: (() => void) | undefined;
  exited = false;
  exitOnCtrlC = false;

  constructor(
    name: TerminalFixture,
    args: readonly string[],
    options: PtyOptions,
    without: (record: TerminalRecord) => boolean = () => false,
  ) {
    this.#records = recordedTerminal(name).filter((record) => !without(record));
    this.args = args;
    this.options = options;
    void this.#play();
  }

  onData(listener: (data: string) => void): void {
    this.#data.add(listener);
  }

  onExit(listener: (exit: { exitCode: number }) => void): void {
    this.#exit.add(listener);
  }

  write(data: string): void {
    this.written.push(data);
    if (data === '\x03' && this.exitOnCtrlC) {
      this.#end(0);
      return;
    }
    this.#unread.push(data);
    this.#wake?.();
  }

  resize(): void {
    // A recording does not redraw.
  }

  pause(): void {
    // A recording never prints enough to fill the screen's buffer.
  }

  resume(): void {
    // Likewise.
  }

  kill(): void {
    this.#end(0);
  }

  #end(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.#wake?.();
    for (const listener of this.#exit) listener({ exitCode: code });
  }

  /** The hooks' server, as its command line says (the URL in its hooks' command). */
  #url(): string {
    return /http:\/\/127\.0\.0\.1:\d+\/hook/.exec(this.args.join(' '))?.[0] ?? '';
  }

  /**
   * Plays the recording on a clock: each record comes when it is due, even where the system's
   * timers are coarse (Windows' tick is about 15 ms; waiting out each gap in turn would add a tick
   * to each of a recording's thousand records). What follows keys sent or a hook comes after them.
   */
  async #play(): Promise<void> {
    let due = performance.now();
    let previous = 0;
    for (const record of this.#records) {
      if (this.exited) return;
      due += (record.t - previous) / SPEED;
      previous = record.t;
      const wait = due - performance.now();
      await new Promise((resolve) =>
        wait >= 1 ? setTimeout(resolve, wait) : setImmediate(resolve),
      );
      switch (record.kind) {
        case 'out':
          for (const listener of this.#data) listener(record.data);
          break;
        case 'in':
          await this.#keys(record.data === '\\r' ? '\r' : record.data);
          due = Math.max(due, performance.now());
          break;
        case 'hook':
          // Codex waits for its hooks before it goes on.
          await fetch(this.#url(), {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.options.env[HOOK_TOKEN] ?? ''}` },
            body: JSON.stringify(record.data.ev),
          });
          due = Math.max(due, performance.now());
          break;
        case 'exit':
          this.#end(record.data.exitCode);
          return;
        default:
          break;
      }
    }
  }

  /** Waits until the session sends `keys` (text is pasted). */
  async #keys(keys: string): Promise<void> {
    for (;;) {
      const at = this.#unread.findIndex(
        (data) => data === keys || data === `${PASTE_START}${keys}${PASTE_END}`,
      );
      if (at !== -1) {
        this.#unread = this.#unread.slice(at + 1);
        return;
      }
      if (this.exited) return;
      await new Promise<void>((resolve) => (this.#wake = resolve));
      this.#wake = undefined;
    }
  }
}
