import { readFileSync } from 'node:fs';

import { HOOK_TOKEN } from './hooks';
import type { Pty, PtyOptions } from './pty';

/*
 * For tests: Claude Code's interactive CLI, faked at the pseudo-terminal, printing what the real
 * one does (as recorded from Claude Code 2.1.296): its terminal probes, Program Status reports,
 * a prompt box with a dim placeholder, and the hooks it was given in --settings, posted to their
 * server. Each prompt submitted gets a turn: "ask …" asks for permission first (answered with
 * "1"), "slow …" works until told otherwise, "fail …" fails, anything else is answered at once.
 */

const PROBES = '\x1b]11;?\x07\x1b[c\x1b[>0q\x1b[?u\x1b]7501;?\x07\x1b[c';
const RULE = '─'.repeat(40);

export interface FakeClaudeOptions {
  /** Whether it reports its status (Claude Code 2.1.295 and later do). */
  reports?: boolean;
  /** Shows the folder trust dialog first, until "Yes" (Enter on option 2) is picked. */
  trust?: boolean;
  /** Its session id, as its hooks tell it (default: the one it was given). */
  sessionId?: string;
  /** Sessions it can resume. */
  transcripts?: readonly string[];
}

/** One run of the fake CLI. */
export class FakeClaude implements Pty {
  readonly pid = 4242;
  readonly file: string;
  readonly args: readonly string[];
  readonly options: PtyOptions;
  /** Everything corrallm wrote to it, as written. */
  readonly written: string[] = [];
  /** The prompts it was sent, as its hooks told them. */
  readonly prompts: string[] = [];
  readonly kills: (string | undefined)[] = [];
  /** Whether it has exited. */
  exited = false;
  draft = '';
  readonly #options: FakeClaudeOptions;
  readonly #data = new Set<(data: string) => void>();
  readonly #exit = new Set<(exit: { exitCode: number }) => void>();
  #trusting: boolean;
  #state: 'starting' | 'idle' | 'working' | 'blocked' | 'done' | 'error' = 'starting';
  #mode = 'default';

  constructor(file: string, args: readonly string[], options: PtyOptions, fake: FakeClaudeOptions) {
    this.file = file;
    this.args = args;
    this.options = options;
    this.#options = fake;
    this.#trusting = fake.trust ?? false;
    setTimeout(() => {
      this.#boot();
    }, 1);
  }

  /** The value of a flag it was started with. */
  arg(flag: string): string | undefined {
    const at = this.args.indexOf(flag);
    return at === -1 ? undefined : this.args[at + 1];
  }

  get sessionId(): string {
    return this.#options.sessionId ?? this.arg('--resume') ?? this.arg('--session-id') ?? '';
  }

  onData(listener: (data: string) => void): void {
    this.#data.add(listener);
  }

  onExit(listener: (exit: { exitCode: number }) => void): void {
    this.#exit.add(listener);
  }

  resize(): void {
    // Nothing to redraw at another size.
  }

  kill(signal?: string): void {
    this.kills.push(signal);
    this.exit(0);
  }

  /** Prints to the terminal. */
  print(data: string): void {
    if (this.exited) return;
    for (const listener of this.#data) listener(data);
  }

  /** Exits with `code`. */
  exit(code: number): void {
    if (this.exited) return;
    this.print('\x1b]7501;state=clear\x07');
    this.exited = true;
    for (const listener of this.#exit) listener({ exitCode: code });
  }

  /** Posts a hook event, as Claude Code does with the hooks in its --settings. */
  async hook(name: string, fields: Record<string, unknown> = {}): Promise<void> {
    const file = this.arg('--settings');
    if (file === undefined) return;
    const settings = JSON.parse(readFileSync(file, 'utf8')) as {
      hooks: Record<string, { hooks: { url: string }[] }[] | undefined>;
    };
    const url = settings.hooks[name]?.[0]?.hooks[0]?.url;
    if (url === undefined) return;
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.options.env[HOOK_TOKEN] ?? ''}`,
      },
      body: JSON.stringify({
        session_id: this.sessionId,
        cwd: this.options.cwd,
        permission_mode: this.#mode,
        hook_event_name: name,
        ...fields,
      }),
    });
  }

  /** Reports a Program Status, if it does. */
  report(fields: string): void {
    if (this.#options.reports ?? true) this.print(`\x1b]7501;${fields}:app=claude-code\x07`);
  }

  /** Switches permission mode, as Shift+Tab does (its hooks tell it from the next one). */
  setMode(mode: string): void {
    this.#mode = mode;
  }

  write(data: string): void {
    this.written.push(data);
    if (this.exited) return;
    // A terminal's answers to its queries (or another key's escape sequence): not typing.
    if (data.startsWith('\x1b') && data.length > 1) return;
    if (this.#trusting) {
      if (data === '\r') {
        this.#trusting = false;
        this.#ready('idle');
      }
      return;
    }
    if (this.#state === 'blocked') {
      if (data === '1') {
        this.#become('working');
        setTimeout(() => void this.#finish(), 5);
      } else if (data === '\x1b') this.#become('idle');
      return;
    }
    for (const key of data) {
      if (key === '\r') void this.#submit();
      else if (key === '\x1b') {
        if (this.#state === 'working') this.#become('idle');
      } else if (key === '\x03') {
        this.draft = '';
      } else if (key === '\n' || key >= ' ') {
        this.draft += key;
      }
    }
    this.#draw();
  }

  #boot(): void {
    const resume = this.arg('--resume');
    if (resume !== undefined && !(this.#options.transcripts ?? []).includes(resume)) {
      this.print(`No conversation found with session ID: ${resume}\r\n`);
      this.exit(1);
      return;
    }
    this.print('\x1b[?2004h\x1b[?2031h\x1b[?1004h');
    this.print(PROBES);
    if (this.#trusting) {
      this.print(
        '\x1b[H\x1b[2J Quick safety check: Is this a project you created or one you trust?\r\n\r\n' +
          ' ❯ No, exit\r\n   Yes, I trust this folder\r\n',
      );
      return;
    }
    this.#ready('idle');
  }

  #ready(state: 'idle'): void {
    this.report(`state=${state}`);
    this.#state = state;
    this.#draw();
  }

  #become(state: 'idle' | 'working' | 'blocked' | 'done' | 'error', extra = ''): void {
    this.#state = state;
    this.report(`state=${state}${extra}`);
  }

  /** The whole screen: a header, the prompt box (its draft, or a dim placeholder), a footer. */
  #draw(): void {
    if (this.#state === 'starting') return;
    const lines =
      this.draft === '' ? ['\x1b[2mTry "fix lint errors"\x1b[22m'] : this.draft.split('\n');
    this.print(
      '\x1b[H\x1b[2J Claude Code (fake)\r\n\r\n' +
        `${RULE}\r\n` +
        lines.map((line, i) => `${i === 0 ? '❯ ' : '  '}${line}`).join('\r\n') +
        `\r\n${RULE}\r\n  ? for shortcuts`,
    );
  }

  async #submit(): Promise<void> {
    const prompt = this.draft;
    if (prompt === '' || this.#state === 'working') return;
    this.draft = '';
    this.prompts.push(prompt);
    this.#become('working');
    await this.hook('UserPromptSubmit', { prompt });
    this.print(`\r\n⏺ ${prompt}\r\n`);
    if (prompt.startsWith('ask')) {
      // As recorded: what it waits for, in base64.
      this.#become('blocked', `:kind=permission:msg=${base64('approve Bash: echo hello')}`);
      this.print('Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n');
      return;
    }
    if (prompt.startsWith('slow')) return;
    if (prompt.startsWith('fail')) {
      await this.hook('StopFailure', { error: 'rate_limit', error_details: 'Limit reached' });
      this.#become('error', `:msg=${base64('You’ve hit your limit · resets 3pm')}`);
      return;
    }
    setTimeout(() => void this.#finish(), 5);
  }

  async #finish(): Promise<void> {
    if (!this.#working()) return;
    const prompt = this.prompts.at(-1) ?? '';
    await this.hook('Stop', { last_assistant_message: `Done: ${prompt}` });
    // Unless interrupted meanwhile.
    if (!this.#working()) return;
    this.#become('done');
    this.#draw();
  }

  #working(): boolean {
    return this.#state === 'working';
  }
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}
