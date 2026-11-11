import { readFileSync } from 'node:fs';
import path from 'node:path';

import { HOOK_HEADER } from '../terminal/hooks';
import type { Pty, PtyOptions } from '../terminal/pty';

/*
 * For tests: what the real Claude Code (2.1.321, Haiku 5.5 through a local stub of the model API,
 * B13 C13) did in its interactive terminal of 100×30, kept in fixtures/terminal-*.jsonl: everything
 * it printed (its Program Status reports among it), the hooks corrallm's settings gave it and what
 * they posted, and the keys sent to it, with their times (ms). It ran in a throwaway home with the
 * stub's scripted tool calls; the project folder reads /work/smoke/p2 and the home /home/user. Its
 * terminal answered its probes for Program Status, cursor position and colour.
 *
 * - permission: a Bash command that asks (`touch made.txt`), held 14 seconds before it is allowed
 *   with 1: its PermissionRequest hook, then `blocked` (kind permission), and its Notification
 *   hook (permission_prompt) a few seconds after the `blocked` report.
 * - question: AskUserQuestion with one question and two options; its first option picked with Enter.
 * - exit-plan: in plan mode, a plan file written, then ExitPlanMode: a PreToolUse and a
 *   PermissionRequest hook carrying the plan; Esc keeps planning.
 * - two-permissions: two Bash commands in one reply, each asking in turn (1 each).
 * - elicitation: an MCP server's tool allowed (1), which then asks for a form; Esc declines it.
 *   Claude Code raised no hook for the form until it was answered.
 * - trust-yes, trust-no: a folder not yet trusted: the folder trust dialog, answered Yes (Down,
 *   Enter) or its default, No, exit (Enter, exit code 1).
 */

export type TerminalFixture =
  | 'permission'
  | 'question'
  | 'exit-plan'
  | 'two-permissions'
  | 'elicitation'
  | 'trust-yes'
  | 'trust-no';

/** One thing that happened, at `t` ms after the first thing it printed. */
export type TerminalRecord = { t: number } & (
  | { kind: 'argv'; data: string[] }
  /** What it printed. */
  | { kind: 'out'; data: string }
  /** Keys sent to it: text typed, or a key ("\\r" is Enter). */
  | { kind: 'in'; data: string }
  /** A hook it ran, and the event it posted. */
  | { kind: 'hook'; data: { ok: boolean; ev: Record<string, unknown> } }
  /** The recorder's own note. */
  | { kind: 'note'; data: string }
  | { kind: 'exit'; data: { exitCode: number } }
);

const FOLDER = path.join(import.meta.dirname, 'fixtures');

export function recordedTerminal(name: TerminalFixture): TerminalRecord[] {
  return readFileSync(path.join(FOLDER, `terminal-${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as TerminalRecord);
}

/** How much faster than recorded a recording plays. */
const SPEED = 50;

/** The keys a record of `in` stands for ("\\r" is Enter, "\\x1b" Escape). */
export function keysOf(data: string): string {
  return data.replace(/\\r/g, '\r').replace(/\\x1b/g, '\x1b');
}

/**
 * A pseudo-terminal that plays a recording of Claude Code's terminal back to a Terminal session:
 * what it printed and the hooks it ran, in order and in time (sped up), waiting wherever keys were
 * sent until the session sends the same keys.
 */
export class Replay implements Pty {
  readonly pid = 4242;
  apiReady: Promise<void> = Promise.resolve();
  readonly written: string[] = [];
  /** The hooks it has posted, by event name and tool or notification type. */
  readonly posted: string[] = [];
  readonly args: readonly string[];
  readonly options: PtyOptions;
  readonly #records: TerminalRecord[];
  readonly #data = new Set<(data: string) => void>();
  readonly #exit = new Set<(exit: { exitCode: number }) => void>();
  /** Writes not yet matched against the keys the recording waits for. */
  #unread = '';
  #wake: (() => void) | undefined;
  exited = false;

  constructor(name: TerminalFixture, args: readonly string[], options: PtyOptions) {
    this.#records = recordedTerminal(name);
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
    this.#unread += data;
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

  /** Where its hooks post and with what, as its --settings file says. */
  #hook(): { url: string; authorization: string } {
    const file = this.args[this.args.indexOf('--settings') + 1] ?? '';
    const settings = JSON.parse(readFileSync(file, 'utf8')) as {
      hooks: Record<string, { hooks: { url?: string; headers?: { Authorization: string } }[] }[]>;
    };
    const hook = settings.hooks.Stop?.[0]?.hooks[0];
    return {
      url: hook?.url ?? '',
      authorization:
        hook?.headers?.Authorization ??
        readFileSync(this.options.env[HOOK_HEADER] ?? '', 'utf8')
          .trim()
          .slice('Authorization: '.length),
    };
  }

  /** Plays the recording on a clock: each record when it is due. */
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
          await this.#keys(keysOf(record.data));
          due = Math.max(due, performance.now());
          break;
        case 'hook': {
          const { url, authorization } = this.#hook();
          // Claude Code waits for its hooks before it goes on, except a PermissionRequest hook
          // (recorded, B23): it draws its dialog at once, beside the request, so a held one
          // does not stop the recording; the request is let go of when the dialog is answered.
          const request = fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: authorization },
            body: JSON.stringify(record.data.ev),
          }).catch(() => undefined);
          if (record.data.ev.hook_event_name !== 'PermissionRequest') await request;
          // A held one has reached the session before the report that followed it (about 30 ms
          // later, recorded); the unanswered request itself never settles in the meantime.
          else await Promise.race([request, new Promise((resolve) => setTimeout(resolve, 50))]);
          const {
            hook_event_name: event,
            tool_name: tool,
            notification_type: type,
          } = record.data.ev;
          this.posted.push([event, tool, type].filter((one) => typeof one === 'string').join(':'));
          due = Math.max(due, performance.now());
          break;
        }
        case 'exit':
          this.#end(record.data.exitCode);
          return;
        default:
          break;
      }
    }
  }

  /** Waits until the session has sent `keys`. */
  async #keys(keys: string): Promise<void> {
    for (;;) {
      const at = this.#unread.indexOf(keys);
      if (at !== -1) {
        this.#unread = this.#unread.slice(at + keys.length);
        return;
      }
      if (this.exited) return;
      await new Promise<void>((resolve) => (this.#wake = resolve));
      this.#wake = undefined;
    }
  }
}
