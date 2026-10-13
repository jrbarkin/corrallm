import type { TerminalEvent } from '../../shared/terminal';

/** What an agent's terminal view asks of the main process: window.api's terminal functions. */
export interface TerminalBackend {
  /** Starts showing the agent's terminal: its events follow (see TerminalEvent). */
  attach(agentId: string): Promise<null>;
  detach(agentId: string): Promise<null>;
  /** Keystrokes for the agent's CLI. */
  write(agentId: string, data: string): Promise<null>;
  resize(agentId: string, cols: number, rows: number): Promise<null>;
  /** Listens for what terminals show; returns a function that stops listening. */
  onEvent(listener: (agentId: string, event: TerminalEvent) => void): () => void;
}

/** Where there is no main process to run terminals (the editor alone, as in tests). */
export const NO_TERMINAL: TerminalBackend = {
  attach: () => Promise.resolve(null),
  detach: () => Promise.resolve(null),
  write: () => Promise.resolve(null),
  resize: () => Promise.resolve(null),
  onEvent: () => () => undefined,
};
