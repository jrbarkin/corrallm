import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { Terminal } from '@xterm/headless';
import type { IBuffer } from '@xterm/headless';

import { parseProgramStatus, PROBE_REPLY, PROGRAM_STATUS } from './status';
import type { ProgramStatus } from './status';

/*
 * Main's copy of what a Terminal session's screen shows: a headless xterm.js fed everything the
 * CLI prints. A view that opens starts from its snapshot, then follows the CLI's output. It also
 * reads what main needs from the screen: Program Status reports (status.ts, as Claude Code makes
 * them), whose probe it answers; the window title (as Codex reports its state there); and the
 * draft in Claude Code's prompt. While no view is open it answers the one query a terminal must
 * (Device Attributes): Windows' ConPTY holds output until it is answered. Otherwise the view's
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
/** Claude Code's prompt mark, and the rules above and below its prompt box. */
const PROMPT = '❯';
const RULE = '─'.repeat(8);

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
}

export class Screen {
  readonly #terminal: Terminal;
  readonly #serialize = new SerializeAddon();
  /** Whether the cursor shows (DECTCEM): a CLI shows it where it takes typing. */
  #cursorShown = true;

  constructor({ cols, rows, reply, status, title, answersQueries }: ScreenOptions) {
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

  /** Whether the CLI asked for pastes to be bracketed (as Claude Code does, to tell them from typing). */
  get bracketedPaste(): boolean {
    return this.#terminal.modes.bracketedPasteMode;
  }

  /** Something the CLI printed. */
  write(data: string): void {
    this.#terminal.write(data);
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

  /**
   * What the user has typed in Claude Code's prompt and not sent: '' when it is empty (or shows
   * its dim placeholder), undefined when no prompt is on screen (a dialog, or still starting).
   * The prompt is the line that starts with ❯ right under a rule; the box ends at the next rule.
   */
  draft(): string | undefined {
    const buffer = this.#terminal.buffer.active;
    const top = buffer.viewportY;
    const bottom = top + this.#terminal.rows;
    const lineText = (y: number) => buffer.getLine(y)?.translateToString(true) ?? '';
    for (let y = bottom - 1; y > top; y -= 1) {
      if (!lineText(y).startsWith(PROMPT) || !lineText(y - 1).startsWith(RULE)) continue;
      const typed: string[] = [];
      const cell = buffer.getNullCell();
      for (let row = y; row < bottom && (row === y || !lineText(row).startsWith(RULE)); row += 1) {
        const line = buffer.getLine(row);
        let text = '';
        // Past the prompt mark and its space (or the indent of a line after the first).
        for (let x = 2; line && x < line.length; x += 1) {
          const at = line.getCell(x, cell);
          if (!at || at.getWidth() === 0) continue;
          text += at.isDim() ? ' ' : at.getChars() || ' ';
        }
        typed.push(text.trimEnd());
      }
      return typed.join('\n').trim();
    }
    return undefined;
  }

  dispose(): void {
    this.#terminal.dispose();
  }
}
