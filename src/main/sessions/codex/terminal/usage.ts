import type { TerminalUsage } from '../../terminal/cli';
import { property } from '../../transcript';
import { codexLimits, codexUsedUp, usageWindows } from '../limits';
import { askAppServer, startAppServer } from '../rpc';
import type { AppServer, AppServerOptions } from '../rpc';

/*
 * Codex's usage limits for its Terminal connection. Its TUI shows them (/status) but tells corrallm
 * nothing of them, and corrallm never types into it to ask. So a private `codex app-server` (the
 * user's own `codex`, as for its hooks' trust: trust.ts) is started only to answer
 * account/rateLimits/read, then closed: no thread, no model, no prompt, so reading them spends no
 * usage, and needs no consent on a ChatGPT plan. A session reads them as it starts and after each
 * turn (sessions/terminal/session.ts, through tui.ts), and, for a turn Codex ended without its Stop
 * hook (it runs none for a turn that errs), before it ends it: a plan used up then failed it, until
 * the reset (`usedUp`). Every Codex Terminal session shares one reader, which reads once at a time.
 */

/** How long Codex may take to say its limits before the reading is given up. */
const READ_MS = 15_000;

/** What a `codex` is, and where it runs, for asking it. */
export interface UsageContext {
  codex: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
}

export interface UsageReaderOptions {
  /** Starts Codex's app server (rpc.ts; a fake in tests). */
  start?: (options: AppServerOptions) => Promise<AppServer>;
  /** What the server is told runs it. */
  clientInfo?: AppServerOptions['clientInfo'];
  readMs?: number;
  /** The time, in milliseconds (Date.now). */
  now?: () => number;
}

export class UsageReader {
  readonly #start: (options: AppServerOptions) => Promise<AppServer>;
  readonly #clientInfo: AppServerOptions['clientInfo'];
  readonly #readMs: number;
  readonly #now: () => number;
  /** The reading going on, if any. */
  #reading: Promise<TerminalUsage | undefined> | undefined;
  /** The one after it, for what was asked meanwhile. */
  #next: Promise<TerminalUsage | undefined> | undefined;

  constructor({
    start = startAppServer,
    clientInfo = { name: 'corrallm', title: 'corrallm', version: '0.0.0' },
    readMs = READ_MS,
    now = Date.now,
  }: UsageReaderOptions = {}) {
    this.#start = start;
    this.#clientInfo = clientInfo;
    this.#readMs = readMs;
    this.#now = now;
  }

  /**
   * Codex's usage limits now, as usage windows, and until when its plan is used up, if it is
   * (codexUsedUp): undefined if it cannot say (a login without plan limits, as an API key; no app
   * server; too slow). One read at a time: one asked while another goes on waits for it, then
   * reads again (once, for all asked meanwhile), so a turn that ended meanwhile is counted.
   */
  read(context: UsageContext): Promise<TerminalUsage | undefined> {
    if (!this.#reading) {
      const reading = this.#readNow(context).finally(() => {
        this.#reading = undefined;
      });
      this.#reading = reading;
      return reading;
    }
    this.#next ??= this.#reading.then(() => {
      this.#next = undefined;
      return this.read(context);
    });
    return this.#next;
  }

  async #readNow(context: UsageContext): Promise<TerminalUsage | undefined> {
    try {
      const result = await askAppServer(
        { ...context, clientInfo: this.#clientInfo },
        (server) => server.request('account/rateLimits/read', {}),
        { start: this.#start, ms: this.#readMs, slow: 'Codex took too long to say its usage.' },
      );
      const snapshot = property(result, 'rateLimits');
      const now = this.#now();
      const limits = codexLimits(snapshot);
      const windows = limits && usageWindows(limits, now);
      if (windows === undefined) return undefined;
      const usedUp = codexUsedUp(snapshot, now);
      return { windows, ...(usedUp === undefined ? {} : { usedUp }) };
    } catch {
      return undefined;
    }
  }
}
