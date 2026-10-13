import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionEvent } from '../../../shared/session';
import type { TerminalEvent } from '../../../shared/terminal';
import type { UsageBackend, UsageWindows } from '../../../shared/usage';
import type { LiveSession, SessionSpec } from '../connector';
import { TerminalConnector } from './connector';
import { FakeClaude } from './fake-claude';
import type { FakeClaudeOptions } from './fake-claude';
import { HOOK_TOKEN } from './hooks';

/*
 * A Terminal session driving a fake Claude Code (fake-claude.ts) through a fake pseudo-terminal:
 * the real screen copy, status reports, hook server and typing, at test speed.
 */

const TIMING = { key: 0, enter: 1, confirm: 500, settle: 5, startup: 120, batch: 1, kill: 200 };

let dir: string;
let runs: FakeClaude[];
let fake: FakeClaudeOptions;
let events: SessionEvent[];
let remembered: string[];
let sessions: LiveSession[];
let readings: [UsageBackend, UsageWindows][];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-terminal-'));
  runs = [];
  fake = {};
  events = [];
  remembered = [];
  sessions = [];
  readings = [];
});
afterEach(async () => {
  await Promise.all(sessions.map((session) => session.close()));
  await rm(dir, { recursive: true, force: true });
});

const SPEC: SessionSpec = {
  agentId: 'a',
  cwd: '/work/app',
  env: { PATH: '/usr/bin', HOME: '/home/me', CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' },
  model: null,
  mode: null,
  resume: null,
};

async function start(spec: Partial<SessionSpec> = {}) {
  const connector = new TerminalConnector({
    spawn: (file, args, options) => {
      const run = new FakeClaude(file, args, options, fake);
      runs.push(run);
      return Promise.resolve(run);
    },
    findClaude: () => Promise.resolve('/home/me/.local/bin/claude'),
    tmp: dir,
    timing: TIMING,
    usage: (backend, windows) => readings.push([backend, windows]),
  });
  const session = await connector.start(
    { ...SPEC, ...spec },
    {
      emit: (event) => events.push(event),
      remember: (id) => remembered.push(id),
    },
  );
  sessions.push(session);
  return session;
}

/** The run of the fake CLI going on. */
const claude = () => {
  const run = runs.at(-1);
  if (!run) throw new Error('claude never ran');
  return run;
};

/** The events after the first `skip`, by type, with what tells them apart. */
const seen = (skip = 0) =>
  events.slice(skip).map((event) => {
    switch (event.type) {
      case 'status':
        return `status:${event.status}`;
      case 'user':
      case 'text':
        return `${event.type}:${event.text}`;
      case 'notice':
        return `notice:${event.level}:${event.text}`;
      case 'end':
        return `end:${event.interrupted ? 'interrupted' : event.failed ? 'failed' : 'done'}`;
      case 'mode':
        return `mode:${event.mode}`;
      case 'closed':
        return `closed${event.error === undefined ? '' : `:${event.error}`}`;
      case 'asking':
        return `asking:${event.asks.map((ask) => ask.kind).join(',')}`;
      default:
        return event.type;
    }
  });

const until = (check: () => void, timeout = 2000) => vi.waitFor(check, { timeout, interval: 5 });
const last = <T extends SessionEvent['type']>(type: T) =>
  events.findLast((event): event is Extract<SessionEvent, { type: T }> => event.type === type);

describe('a Terminal session', () => {
  it('runs claude in the project folder, as a terminal, with its hooks and a new session id', async () => {
    await start();
    const run = claude();
    expect(run.file).toBe('/home/me/.local/bin/claude');
    expect(run.options.cwd).toBe('/work/app');
    const id = run.arg('--session-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(remembered).toEqual([id]);
    // The user's own default mode applies, and the CLI's default model.
    expect(run.args).not.toContain('--permission-mode');
    expect(run.args).not.toContain('--model');
    expect(events[0]).toEqual({ type: 'started', model: null, mode: 'manual', models: [] });

    const { env } = run.options;
    expect(env).toMatchObject({ PATH: '/usr/bin', TERM: 'xterm-256color', COLORTERM: 'truecolor' });
    expect(env[HOOK_TOKEN]).toMatch(/^[0-9a-f]{48}$/);
    // It must report its status to corrallm's terminal.
    expect(env).not.toHaveProperty('CLAUDE_CODE_DISABLE_TERMINAL_TITLE');

    const settings = run.arg('--settings') ?? '';
    expect(path.dirname(path.dirname(settings))).toBe(dir);
    const { hooks } = JSON.parse(readFileSync(settings, 'utf8')) as {
      hooks: Record<string, { hooks: { url: string }[] }[]>;
    };
    expect(hooks.UserPromptSubmit?.[0]?.hooks[0]?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook$/);
  });

  it.skipIf(process.platform === 'win32')(
    'hears Claude Code’s usage limits from the status line it is given',
    async () => {
      await start();
      const settings = claude().arg('--settings') ?? '';
      const { statusLine } = JSON.parse(readFileSync(settings, 'utf8')) as {
        statusLine: { type: string; command: string };
      };
      expect(statusLine.type).toBe('command');
      // Run as Claude Code runs it: through the shell, the input on stdin, the token in its env.
      const input = {
        session_id: 's',
        rate_limits: { five_hour: { used_percentage: 61, resets_at: 1_791_810_000 } },
      };
      const child = spawn(statusLine.command, [], { shell: true, env: claude().options.env });
      child.stdin.end(`${JSON.stringify(input)}\n`);
      await until(() => {
        expect(readings).toEqual([
          ['Claude', { fiveHour: { usedPercent: 61, resetsAt: 1_791_810_000_000 } }],
        ]);
      });
    },
  );

  it('starts in a mode or model chosen in corrallm', async () => {
    await start({ mode: 'plan', model: 'haiku' });
    expect(claude().arg('--permission-mode')).toBe('plan');
    expect(claude().arg('--model')).toBe('haiku');
  });

  it('starts in Manual when that was chosen, whatever the user’s default; the default model as such', async () => {
    await start({ mode: 'manual', model: 'default' });
    expect(claude().arg('--permission-mode')).toBe('manual');
    expect(claude().args).not.toContain('--model');
  });

  it('answers Claude Code’s status probe, and its device query while no view shows it', async () => {
    await start();
    await until(() => {
      expect(claude().written).toContain('\x1b]7501;?\x1b\\');
      expect(claude().written).toContain('\x1b[?1;2c');
    });
  });

  it('resumes the session it had; one with no transcript starts afresh under its id', async () => {
    fake.transcripts = ['kept'];
    await start({ resume: 'kept' });
    expect(claude().arg('--resume')).toBe('kept');

    await start({ resume: 'gone' });
    await until(() => {
      expect(claude().arg('--session-id')).toBe('gone');
    });
    expect(runs.map((run) => run.arg('--resume') ?? run.arg('--session-id'))).toEqual([
      'kept',
      'gone',
      'gone',
    ]);
    expect(seen()).not.toContain('closed');
  });

  it('types a message into the prompt once it is ready, and ends the turn when Claude Code is done', async () => {
    const session = await start();
    // Sent before the CLI is up: typed once its prompt is ready.
    await session.send({ id: 'm1', text: 'Fix the bug' });
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    expect(claude().prompts).toEqual(['Fix the bug']);
    expect(seen(1)).toEqual([
      'user:Fix the bug',
      'status:working',
      'text:Done: Fix the bug',
      'end:done',
    ]);
    expect(last('end')?.messages).toEqual(['m1']);
  });

  it('types a long message as a person would: never pasted, Ctrl+J for its line breaks', async () => {
    const session = await start();
    const text = `${'word '.repeat(40)}\nsecond line\n\nfourth`;
    await session.send({ id: 'm1', text });
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    const typed = claude().written.filter((data) => !data.startsWith('\x1b'));
    expect(typed.join('')).toBe(`${text.replace(/\n/g, '\n')}\r`);
    expect(typed.every((data) => data.length <= 32)).toBe(true);
    expect(typed.filter((data) => data.includes('\n'))).toEqual(['\n', '\n', '\n']);
    expect(claude().written.join('')).not.toContain('\x1b[200~');
    expect(claude().prompts).toEqual([text]);
  });

  it('hears a prompt typed in the terminal as a turn of its own', async () => {
    const session = await start();
    await until(() => {
      expect(claude().written).toContain('\x1b]7501;?\x1b\\');
    });
    session.terminal?.input('hello there');
    session.terminal?.input('\r');
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    // Its hook may tell the prompt before or after Claude Code says it works on it.
    expect(seen(1).sort()).toEqual(
      ['status:working', 'user:hello there', 'text:Done: hello there', 'end:done'].sort(),
    );
    expect(seen().at(-1)).toBe('end:done');
    const typedId = events.find((event) => event.type === 'user');
    expect(last('end')?.messages).toEqual([typedId?.type === 'user' ? typedId.id : '']);
  });

  it('waits on the user while Claude Code asks for permission', async () => {
    const session = await start();
    await session.send({ id: 'm1', text: 'ask to run the tests' });
    await until(() => {
      expect(seen()).toContain('status:waiting');
    });
    expect(last('end')).toBeUndefined();
    session.terminal?.input('1');
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    expect(seen(1)).toEqual([
      'user:ask to run the tests',
      'status:working',
      'asking:permission',
      'status:waiting',
      'asking:',
      'status:working',
      'text:Done: ask to run the tests',
      'end:done',
    ]);
  });

  it('lists what Claude Code asks in its terminal while it waits there, and never answers it', async () => {
    const session = await start();
    await session.send({ id: 'm1', text: 'ask to run the tests' });
    await until(() => {
      expect(last('asking')?.asks).toHaveLength(1);
    });
    expect(last('asking')?.asks).toEqual([
      {
        kind: 'permission',
        id: expect.any(String) as unknown,
        tool: 'Bash',
        summary: 'echo hello',
      },
    ]);
    // Every hook is answered with no decision: the user answers in the terminal.
    expect(claude().answers.length).toBeGreaterThan(0);
    expect(claude().answers.every(({ answer }) => answer === '{}')).toBe(true);
    // Answered there: it goes on, and asks nothing.
    session.terminal?.input('1');
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    expect(last('asking')?.asks).toEqual([]);

    // Its question, as both hooks tell it (once), and its plan.
    await session.send({ id: 'm2', text: 'question first' });
    await until(() => {
      expect(last('asking')?.asks).toHaveLength(1);
    });
    expect(last('asking')?.asks).toEqual([
      {
        kind: 'question',
        id: 'toolu_question',
        questions: [
          {
            header: 'Color',
            text: 'Pick a color',
            options: [
              { label: 'Red', description: 'Warm' },
              { label: 'Blue', description: 'Cool' },
            ],
            multiple: false,
          },
        ],
      },
    ]);
    session.terminal?.input('1');
    await until(() => {
      expect(last('asking')?.asks).toEqual([]);
    });
    await until(() => {
      expect(seen().filter((one) => one.startsWith('end'))).toHaveLength(2);
    });
    await session.send({ id: 'm3', text: 'plan it' });
    await until(() => {
      expect(last('asking')?.asks).toEqual([
        { kind: 'plan', id: 'toolu_plan', plan: '## Plan\nRun `git init`.\n' },
      ]);
    });
    session.terminal?.input('\x1b');
    await until(() => {
      expect(last('asking')?.asks).toEqual([]);
    });
  });

  it('says what Claude Code waits for when its hooks tell nothing: its status’s words, or its notification’s', async () => {
    const session = await start();
    await session.send({ id: 'm1', text: 'slow work' });
    await until(() => {
      expect(claude().prompts).toEqual(['slow work']);
    });
    claude().report(`state=blocked:kind=question:msg=${btoa('answer: Which region?')}`);
    await until(() => {
      expect(last('asking')?.asks).toEqual([
        { kind: 'other', id: expect.any(String) as unknown, text: 'answer: Which region?' },
      ]);
    });
    claude().report('state=working');
    await until(() => {
      expect(last('asking')?.asks).toEqual([]);
    });
    // A permission it was about to ask long ago (another hook answered it) is not listed.
    await claude().hook('PermissionRequest', {
      tool_name: 'Write',
      tool_input: { file_path: '/work/app/a.txt' },
    });
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 6000);
    claude().report('state=blocked:kind=permission');
    await until(() => {
      expect(last('asking')?.asks).toEqual([
        {
          kind: 'other',
          id: expect.any(String) as unknown,
          text: 'Claude Code asks for your permission.',
        },
      ]);
    });
    vi.restoreAllMocks();
    claude().report('state=working');
    await session.interrupt();
    await until(() => {
      expect(last('end')).toBeDefined();
    });

    // An MCP server's question: only its notification says what.
    await session.send({ id: 'm2', text: 'elicit a region' });
    await until(() => {
      expect(last('asking')?.asks).toEqual([
        { kind: 'other', id: expect.any(String) as unknown, text: 'shop-db needs your input' },
      ]);
    });
    // Claude Code exits: nothing is asked any more.
    claude().exit(1);
    await until(() => {
      expect(last('closed')).toBeDefined();
    });
    expect(seen().slice(-2)).toEqual(['asking:', 'closed:Claude Code exited with code 1.']);
  });

  it('lists what its hooks tell until the turn ends, without status reports', async () => {
    fake.reports = false;
    const session = await start();
    await session.send({ id: 'm1', text: 'ask to run the tests' });
    await until(() => {
      expect(last('asking')?.asks).toHaveLength(1);
    });
    expect(last('asking')?.asks[0]).toMatchObject({ kind: 'permission', summary: 'echo hello' });
    session.terminal?.input('1');
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    expect(last('asking')?.asks).toEqual([]);
  });

  it('is interrupted with Escape: the turn ends, interrupted', async () => {
    const session = await start();
    await session.send({ id: 'm1', text: 'slow work' });
    await until(() => {
      expect(seen()).toContain('status:working');
      expect(claude().prompts).toEqual(['slow work']);
    });
    await session.interrupt();
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    expect(claude().written.at(-1)).toBe('\x1b');
    expect(last('end')).toMatchObject({ messages: ['m1'], interrupted: true, failed: false });
  });

  it('interrupts what Claude Code just said it started, though its screen copy has yet to read it', async () => {
    const session = await start();
    await until(() => {
      expect(claude().written).toContain('\x1b]7501;?\x1b\\');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // It starts on its own (a background task reported back); corrallm interrupts at once.
    claude().report('state=working');
    await session.interrupt();
    expect(claude().written.at(-1)).toBe('\x1b');
  });

  it('drops a message not typed yet when interrupted', async () => {
    fake.trust = true;
    const session = await start();
    await session.send({ id: 'm1', text: 'never typed' });
    await session.interrupt();
    expect(last('end')).toMatchObject({ messages: ['m1'], interrupted: true });
    claude().write('\r');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(claude().prompts).toEqual([]);
  });

  it('waits for the user’s draft in the prompt before typing a message', async () => {
    const session = await start();
    await until(() => {
      expect(claude().written).toContain('\x1b]7501;?\x1b\\');
    });
    session.terminal?.input('my own thou');
    await session.send({ id: 'm1', text: 'From the queue' });
    await until(() => {
      expect(seen()).toContain('status:waiting');
    });
    expect(claude().draft).toBe('my own thou');
    // The user clears it: the message goes.
    session.terminal?.input('\x03');
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    expect(claude().prompts).toEqual(['From the queue']);
  });

  it('waits on the user while a dialog (folder trust) keeps the prompt from showing', async () => {
    fake.trust = true;
    const session = await start();
    await session.send({ id: 'm1', text: 'Hello' });
    await until(() => {
      expect(seen()).toContain('status:waiting');
    });
    expect(claude().prompts).toEqual([]);
    // The user trusts the folder, in the terminal.
    session.terminal?.input('\r');
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    expect(claude().prompts).toEqual(['Hello']);
    expect(seen(1)).toEqual([
      'user:Hello',
      'status:working',
      // Its prompt has not shown for a while.
      'status:waiting',
      'status:working',
      'text:Done: Hello',
      'end:done',
    ]);
  });

  it('says why a turn failed, once, and ends it failed', async () => {
    const session = await start();
    await session.send({ id: 'm1', text: 'fail please' });
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    expect(seen(1)).toEqual([
      'user:fail please',
      'status:working',
      'notice:error:Limit reached',
      'end:failed',
    ]);
  });

  it('works without status reports (an older Claude Code): its prompt and hooks tell', async () => {
    fake.reports = false;
    const session = await start();
    await session.send({ id: 'm1', text: 'Hello' });
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    expect(seen(1)).toEqual(['user:Hello', 'status:working', 'text:Done: Hello', 'end:done']);
  });

  it('follows the session id and the permission mode its hooks tell', async () => {
    fake.sessionId = 'after-clear';
    const session = await start();
    claude().setMode('acceptEdits');
    await session.send({ id: 'm1', text: 'Hello' });
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    expect(remembered.at(-1)).toBe('after-clear');
    expect(seen()).toContain('mode:acceptEdits');
    // /clear: until the next prompt says the new id, one that starts afresh after a restart.
    await claude().hook('SessionEnd', { reason: 'clear' });
    await until(() => {
      expect(remembered).toHaveLength(3);
    });
    expect(remembered[2]).not.toBe('after-clear');
  });

  it('refuses what only its terminal does: answers, modes and models', async () => {
    const session = await start();
    await expect(session.answer('p', { kind: 'permission', answer: 'once' })).rejects.toThrow(
      /terminal/,
    );
    await expect(session.setMode('plan')).rejects.toThrow(/Shift\+Tab/);
    await expect(session.setModel('opus')).rejects.toThrow(/\/model/);
  });

  it('shows its screen to a view: as it is, then what Claude Code prints, then that it exited', async () => {
    const session = await start();
    await until(() => {
      expect(claude().written).toContain('\x1b]7501;?\x1b\\');
    });
    const shown: TerminalEvent[] = [];
    const stop = session.terminal?.show((event) => shown.push(event));
    await until(() => {
      expect(shown[0]?.type).toBe('screen');
    });
    expect(shown[0]).toMatchObject({ cols: 100, rows: 30 });
    expect(shown[0]?.type === 'screen' && shown[0].data).toContain('Claude Code (fake)');

    // While shown, the view's terminal answers queries; main no longer does.
    const answered = claude().written.filter((data) => data === '\x1b[?1;2c').length;
    claude().print('\x1b[c');
    session.terminal?.input('hi');
    await until(() => {
      expect(shown.some((event) => event.type === 'output' && event.data.includes('❯ hi'))).toBe(
        true,
      );
    });
    expect(claude().written.filter((data) => data === '\x1b[?1;2c')).toHaveLength(answered);

    session.terminal?.resize(80, 24);
    claude().exit(0);
    await until(() => {
      expect(shown.at(-1)).toEqual({ type: 'exit', code: 0 });
    });
    expect(last('closed')).toEqual({ type: 'closed' });
    stop?.();
  });

  it('pastes what a view pastes (dropped files’ paths), bracketed as Claude Code asked', async () => {
    const session = await start();
    // It asks for bracketed pastes as it starts.
    await until(() => {
      expect(claude().written).toContain('\x1b]7501;?\x1b\\');
    });
    session.terminal?.paste("'/tmp/Screen Shot.png' ");
    expect(claude().written.at(-1)).toBe("\x1b[200~'/tmp/Screen Shot.png' \x1b[201~");
    claude().print('\x1b[?2004l');
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.terminal?.paste('/tmp/notes.txt ');
    expect(claude().written.at(-1)).toBe('/tmp/notes.txt ');
  });

  it('says when Claude Code exits with an error', async () => {
    await start();
    claude().exit(1);
    await until(() => {
      expect(last('closed')).toEqual({ type: 'closed', error: 'Claude Code exited with code 1.' });
    });
  });

  it('closes: ends Claude Code, waits for it, and removes its settings', async () => {
    const session = await start();
    const settings = claude().arg('--settings') ?? '';
    expect(existsSync(settings)).toBe(true);
    await session.close();
    expect(claude().kills).toEqual([undefined]);
    expect(claude().exited).toBe(true);
    expect(await readdir(dir)).toEqual([]);
    // Closed on purpose: nothing to tell.
    expect(seen()).not.toContain('closed');
    await expect(session.send({ id: 'm', text: 'Hi' })).rejects.toThrow(/not running/);
  });
});
