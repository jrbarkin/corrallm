import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { Terminal } from '@xterm/headless';
import type { IBuffer } from '@xterm/headless';

import { parseProgramStatus, PROBE_REPLY, PROGRAM_STATUS } from './status';
import type { ProgramStatus } from './status';

/*
 * Main's copy of what a Terminal session's screen shows: a headless xterm.js fed everything the
 * CLI prints. A view that opens starts from its snapshot, then follows the CLI's output. It also
 * reads what main needs from the screen: Program Status reports (status.ts), whose probe it
 * answers; the window title; and the buffer each CLI reads its prompt from. While no view is open
 * it answers the one query a terminal must (Device Attributes): Windows' ConPTY holds output until it is answered. Otherwise the view's
 * terminal answers queries; this one never does.
 */

/** The screen as it is: what to write to an empty terminal of its size to show the same. */
export interface Snapshot {
  data: string;
  cols: number;
  rows: number;
}

/** Lines of scrollback main keeps, and a view starts with. */
const SCROLLBACK = 2000;
/** Device Attributes (DA1): what xterm.js answers, a VT100 with advanced video. */
const DEVICE_ATTRIBUTES = '\x1b[?1;2c';
/**
 * Characters written and not yet on the screen above which its CLI is paused, and below which it
 * goes on: xterm.js throws writes away (throwing) once 5e7 are pending.
 */
const HIGH_WATER = 1_000_000;
const LOW_WATER = 100_000;

export interface ScreenOptions {
  cols: number;
  rows: number;
  /** Writes an answer back to the CLI, as the terminal's keyboard would. */
  reply: (data: string) => void;
  /** A Program Status report the CLI made. */
  status: (report: ProgramStatus) => void;
  /** The CLI set the window's title (OSC 0 or 2). */
  title?: (title: string) => void;
  /** Whether this screen answers terminal queries itself (no view's terminal does). */
  answersQueries: () => boolean;
  /** Its CLI should stop printing (true) until the screen has caught up with it (false). */
  flow?: (paused: boolean) => void;
}

export class Screen {
  readonly #terminal: Terminal;
  readonly #serialize = new SerializeAddon();
  /** Whether the cursor shows (DECTCEM): a CLI shows it where it takes typing. */
  #cursorShown = true;
  readonly #flow: ((paused: boolean) => void) | undefined;
  /** Characters written and not yet on the screen, and whether its CLI was paused for them. */
  #pending = 0;
  #paused = false;

  constructor({ cols, rows, reply, status, title, answersQueries, flow }: ScreenOptions) {
    this.#flow = flow;
    this.#terminal = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    // The addons are written for the browser's Terminal; the headless one has the same API.
    this.#terminal.loadAddon(new Unicode11Addon());
    this.#terminal.unicode.activeVersion = '11';
    this.#terminal.loadAddon(this.#serialize);
    this.#terminal.parser.registerOscHandler(PROGRAM_STATUS, (data) => {
      if (data.startsWith('?')) reply(PROBE_REPLY);
      else {
        const report = parseProgramStatus(data);
        if (report) status(report);
      }
      return true;
    });
    if (title) this.#terminal.onTitleChange(title);
    this.#terminal.parser.registerCsiHandler({ final: 'c' }, (params) => {
      if ((params[0] ?? 0) === 0 && answersQueries()) reply(DEVICE_ATTRIBUTES);
      return true;
    });
    // Noted, then left to the terminal (false: its own handler runs too).
    for (const [final, shown] of [
      ['h', true],
      ['l', false],
    ] as const) {
      this.#terminal.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
        if (params.includes(25)) this.#cursorShown = shown;
        return false;
      });
    }
  }

  get cols(): number {
    return this.#terminal.cols;
  }

  get rows(): number {
    return this.#terminal.rows;
  }

  /** Whether the CLI asked for pastes to be bracketed, to tell them from typing. */
  get bracketedPaste(): boolean {
    return this.#terminal.modes.bracketedPasteMode;
  }

  /** Something the CLI printed. While too much is still to be parsed, the CLI is paused. */
  write(data: string): void {
    this.#pending += data.length;
    this.#terminal.write(data, () => {
      this.#pending -= data.length;
      if (this.#paused && this.#pending < LOW_WATER) {
        this.#paused = false;
        this.#flow?.(false);
      }
    });
    if (!this.#paused && this.#pending > HIGH_WATER) {
      this.#paused = true;
      this.#flow?.(true);
    }
  }

  resize(cols: number, rows: number): void {
    this.#terminal.resize(cols, rows);
  }

  /** Resolves once everything written so far is on the screen. */
  settled(): Promise<void> {
    return new Promise((resolve) => {
      this.#terminal.write('', resolve);
    });
  }

  /**
   * The screen once everything written so far is on it, and nothing written since: it is taken as
   * soon as the writes before are parsed, before any later one is.
   */
  snapshot(): Promise<Snapshot> {
    return new Promise((resolve) => {
      this.#terminal.write('', () => {
        resolve({
          data: this.#serialize.serialize({ scrollback: SCROLLBACK }),
          cols: this.#terminal.cols,
          rows: this.#terminal.rows,
        });
      });
    });
  }

  /** The text on screen (the rows in view), trimmed. */
  text(): string {
    const buffer = this.#terminal.buffer.active;
    const lines: string[] = [];
    for (let y = buffer.viewportY; y < buffer.viewportY + this.#terminal.rows; y += 1) {
      lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
    }
    return lines.join('\n').trim();
  }

  /**
   * The rows in view, for a CLI's reading: the active buffer, where its view starts and ends, and
   * whether its cursor shows.
   */
  view(): { buffer: IBuffer; top: number; bottom: number; cursorShown: boolean } {
    const buffer = this.#terminal.buffer.active;
    return {
      buffer,
      top: buffer.viewportY,
      bottom: buffer.viewportY + this.#terminal.rows,
      cursorShown: this.#cursorShown,
    };
  }

  dispose(): void {
    this.#terminal.dispose();
  }
}
