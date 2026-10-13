/*
 * A Terminal connection's screen: the real `claude` CLI runs in a pseudo-terminal in the main
 * process (src/main/sessions/terminal/), and its agent view shows that terminal
 * (src/renderer/terminal/). Main keeps a copy of what the terminal shows, so a view that opens
 * (again) starts from the screen as it is, then follows what the CLI prints. What the user types
 * in the view goes back to the CLI as keystrokes.
 *
 * Keep this module free of Node, Electron and DOM imports: it is compiled into every process.
 */

/** What main tells an agent's terminal view, once the view has asked to see the terminal. */
export type TerminalEvent =
  /**
   * The screen as it is (to start the view from, replacing what it showed), and its size. Sent when
   * the view attaches, and again whenever the CLI starts afresh (a new process).
   */
  | { type: 'screen'; data: string; cols: number; rows: number }
  /** What the CLI printed since: escape sequences and all, to write to the terminal as it is. */
  | { type: 'output'; data: string }
  /** The CLI exited (with its exit code, if it has one): the view shows its last screen. */
  | { type: 'exit'; code: number | null };

/** The most the renderer may send in one write of keystrokes, in characters. */
export const MAX_TERMINAL_INPUT = 65_536;
/** The largest terminal the renderer may ask for, in columns and rows. */
export const MAX_TERMINAL_COLS = 1000;
export const MAX_TERMINAL_ROWS = 500;
