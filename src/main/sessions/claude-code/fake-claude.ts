import { readFileSync } from 'node:fs';

import { HOOK_HEADER } from '../terminal/hooks';
import type { Pty, PtyOptions } from '../terminal/pty';

/*
 * For tests: Claude Code's interactive CLI, faked at the pseudo-terminal, printing what the real
 * one does (as recorded from Claude Code 2.1.296): its terminal probes, Program Status reports,
 * a prompt box with a dim placeholder, and the hooks it was given in --settings, posted to their
 * server. Each prompt submitted gets a turn: "ask …" asks for permission first (answered with
 * "1"), as "question …" asks a question (AskUserQuestion) and "plan …" a plan to approve
 * (ExitPlanMode), and "elicit …" waits on the user for an MCP server, told only by a notification;
 * "slow …" works until told otherwise, "fail …" fails, anything else is answered at once. With
 * `busy`, it reads keys late as its prompt shows and as a turn ends, as the real one does.
 */

const PROBES = '\x1b]11;?\x07\x1b[c\x1b[>0q\x1b[?u\x1b]7501;?\x07\x1b[c';
const RULE = '─'.repeat(40);

export interface FakeClaudeOptions {
  /** Emulates SessionStart, in this permission mode, before any prompt is typed. */
  sessionStart?: string;
  /** Test graceful native exit after this many Ctrl+C keys. */
  exitOnCtrlC?: number;
  /** Whether it reports its status (Claude Code 2.1.295 and later do). */
  reports?: boolean;
  /** Shows the folder trust dialog first, until "Yes" (Enter on option 2) is picked. */
  trust?: boolean;
  /** Its session id, as its hooks tell it (default: the one it was given). */
  sessionId?: string;
  /** Sessions it can resume. */
  transcripts?: readonly string[];
  /**
   * For this long (ms) after its prompt shows (as it starts or the trust dialog closes) and after
   * each turn ends, it reads no keys: what is written meanwhile is read in one go once it is free,
   * as by the real CLI (2.1.296), which takes such a read for a paste: its text goes into the
   * prompt, and an Enter in it is an invisible character on a line of its own, not a submit. The
   * next Enter removes that and asks for a review instead of sending ("Removed 1 invisible
   * character · review and press Enter to send").
   */
  busy?: number;
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
  /** What its hooks were answered, by event: a decision would change what it does. */
  readonly answers: { hook: string; answer: string }[] = [];
  readonly kills: (string | undefined)[] = [];
  /** Whether it has exited. */
  exited = false;
  draft = '';
  #shutdownKeys = 0;
  readonly #options: FakeClaudeOptions;
  readonly #data = new Set<(data: string) => void>();
  readonly #exit = new Set<(exit: { exitCode: number }) => void>();
  #trusting: boolean;
  /** Until when it reads no keys (see `busy`); what was written meanwhile; an Enter taken in. */
  #busyUntil = 0;
  #unread: string[] = [];
  #invisible = false;
  #state: 'starting' | 'idle' | 'working' | 'blocked' | 'done' | 'error' = 'starting';
  #mode = 'default';
  /** Paused (as a pty stops reading its CLI's output): what it prints meanwhile waits. */
  paused = false;
  /** How many times it was paused. */
  pauses = 0;
  readonly #held: string[] = [];

  constructor(file: string, args: readonly string[], options: PtyOptions, fake: FakeClaudeOptions) {
    this.file = file;
    this.args = args;
    this.options = options;
    this.#options = fake;
    this.#mode = fake.sessionStart ?? this.#mode;
    this.#trusting = fake.trust ?? false;
    setTimeout(() => {
      this.#boot();
    }, 1);
  }

  /** The value of a flag it was started with. */
  arg(flag: string): string | undefined {
    const assigned = this.args.find((arg) => arg.startsWith(`${flag}=`));
    if (assigned !== undefined) return assigned.slice(flag.length + 1);
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

  pause(): void {
    if (!this.paused) this.pauses += 1;
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    // Read again later, as a pty's next read is.
    setTimeout(() => {
      while (!this.paused && this.#held.length > 0) this.print(this.#held.shift() ?? '');
    }, 0);
  }

  /** Whether everything it printed has been read. */
  get drained(): boolean {
    return !this.paused && this.#held.length === 0;
  }

  /** Prints to the terminal. */
  print(data: string): void {
    if (this.exited) return;
    if (this.paused) {
      this.#held.push(data);
      return;
    }
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
      hooks: Record<
        string,
        | {
            matcher?: string;
            hooks: { url?: string; command?: string; headers?: { Authorization: string } }[];
          }[]
        | undefined
      >;
    };
    const group = settings.hooks[name]?.[0];
    const hook = group?.hooks[0];
    const url = hook?.url ?? /http:\/\/127\.0\.0\.1:\d+\/hook/.exec(hook?.command ?? '')?.[0];
    if (url === undefined) return;
    // Only for the tools its matcher names, if it names any.
    const tool = fields.tool_name;
    if (group?.matcher !== undefined && !group.matcher.split('|').some((one) => one === tool)) {
      return;
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:
          hook?.headers?.Authorization ??
          readFileSync(this.options.env[HOOK_HEADER] ?? '', 'utf8')
            .trim()
            .slice('Authorization: '.length),
      },
      body: JSON.stringify({
        session_id: this.sessionId,
        cwd: this.options.cwd,
        permission_mode: this.#mode,
        hook_event_name: name,
        ...fields,
      }),
    });
    this.answers.push({ hook: name, answer: await response.text() });
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
    if (
      data === '\x03' &&
      this.#options.exitOnCtrlC !== undefined &&
      ++this.#shutdownKeys >= this.#options.exitOnCtrlC
    ) {
      this.exit(0);
      return;
    }
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
    const wait = this.#busyUntil - Date.now();
    if (wait > 0) {
      if (this.#unread.push(data) === 1) {
        setTimeout(() => {
          this.#read(this.#unread.splice(0).join(''));
        }, wait);
      }
      return;
    }
    this.#read(data);
  }

  /** Keys read in one go: more than one is a paste, where Enter goes in as a character. */
  #read(data: string): void {
    for (const key of data) {
      if (key === '\r' && data.length > 1) {
        this.draft += '\n';
        this.#invisible = true;
      } else if (key === '\r') void this.#submit();
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
    if (this.#options.sessionStart !== undefined)
      void this.hook('SessionStart', { source: 'startup' });
    this.report(`state=${state}`);
    this.#state = state;
    this.#busyUntil = Date.now() + (this.#options.busy ?? 0);
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
    if (this.#invisible) {
      this.#invisible = false;
      this.print('\r\n  Removed 1 invisible character · review and press Enter to send');
      return;
    }
    const prompt = this.draft;
    if (prompt === '' || this.#state === 'working') return;
    this.draft = '';
    this.prompts.push(prompt);
    this.#become('working');
    await this.hook('UserPromptSubmit', { prompt });
    this.print(`\r\n⏺ ${prompt}\r\n`);
    if (prompt.startsWith('ask')) {
      // As recorded: its permission hook first, then its report of what it waits for (base64).
      await this.hook('PermissionRequest', {
        tool_name: 'Bash',
        tool_input: { command: 'echo hello', description: 'Say hello' },
        permission_suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'echo hello' }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ],
      });
      this.#become('blocked', `:kind=permission:msg=${base64('approve Bash: echo hello')}`);
      this.print('Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n');
      return;
    }
    if (prompt.startsWith('question')) {
      // As recorded: the tool's hook, then the permission hook for it (with no call id).
      const input = {
        questions: [
          {
            question: 'Pick a color',
            header: 'Color',
            options: [
              { label: 'Red', description: 'Warm' },
              { label: 'Blue', description: 'Cool' },
            ],
            multiSelect: false,
          },
        ],
      };
      await this.hook('PreToolUse', {
        tool_name: 'AskUserQuestion',
        tool_input: input,
        tool_use_id: 'toolu_question',
      });
      await this.hook('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: input });
      this.#become('blocked', `:kind=question:msg=${base64('answer: Pick a color (Red · Blue)')}`);
      this.print('Pick a color\r\n ❯ 1. Red\r\n   2. Blue\r\n');
      return;
    }
    if (prompt.startsWith('plan')) {
      const input = {
        plan: '## Plan\nRun `git init`.\n',
        planFilePath: '/home/me/.claude/plans/a.md',
      };
      await this.hook('PreToolUse', {
        tool_name: 'ExitPlanMode',
        tool_input: input,
        tool_use_id: 'toolu_plan',
      });
      await this.hook('PermissionRequest', { tool_name: 'ExitPlanMode', tool_input: input });
      this.#become('blocked', `:kind=permission:msg=${base64('approve plan')}`);
      this.print('Would you like to proceed?\r\n ❯ 1. Yes\r\n   2. No, keep planning\r\n');
      return;
    }
    if (prompt.startsWith('elicit')) {
      await this.hook('Notification', {
        notification_type: 'elicitation_dialog',
        message: 'shop-db needs your input',
        title: 'Input needed',
      });
      this.#become('blocked', ':kind=question');
      this.print('shop-db asks: Which region?\r\n');
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
    this.#busyUntil = Date.now() + (this.#options.busy ?? 0);
    this.#draw();
  }

  #working(): boolean {
    return this.#state === 'working';
  }
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}
