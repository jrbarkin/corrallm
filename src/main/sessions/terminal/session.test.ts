import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionEvent } from '../../../shared/session';
import type { TerminalEvent } from '../../../shared/terminal';
import type { UsageBackendId } from '../../../shared/adapter';
import type { UsageWindows } from '../../../shared/usage';
import type { LiveSession, SessionSpec } from '../connector';
import { helpFlags } from '../claude-code/claude';
import { TerminalConnector } from '../claude-code/connector';
import { FakeClaude } from '../claude-code/fake-claude';
import type { FakeClaudeOptions } from '../claude-code/fake-claude';
import { HOOK_TOKEN } from './hooks';

/*
 * A Terminal session driving a fake Claude Code (fake-claude.ts) through a fake pseudo-terminal:
 * the real screen copy, status reports, hook server and typing, at test speed.
 */

const TIMING = {
  key: 0,
  enter: 1,
  echo: 300,
  confirm: 500,
  settle: 5,
  startup: 120,
  batch: 1,
  kill: 200,
};

let dir: string;
let runs: FakeClaude[];
let fake: FakeClaudeOptions;
let events: SessionEvent[];
let remembered: string[];
let sessions: LiveSession[];
let readings: [UsageBackendId, UsageWindows][];
/** What its claude's --help says. */
let help: string;
/** While set, the fake pty starts only once it resolves. */
let spawning: Promise<void> | undefined;
let activity: number;

beforeEach(async () => {
  spawning = undefined;
  activity = 0;
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-terminal-'));
  runs = [];
  fake = {};
  events = [];
  remembered = [];
  sessions = [];
  readings = [];
  help = [
    '  --effort <level>  Effort level for the current session',
    '  --model <model>  Model',
    '  --append-system-prompt <prompt>  Append native instructions',
    '  --system-prompt-snapshot <on|off>  Record and reuse the system prompt',
  ].join('\n');
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

/** A connector running the fake CLI (with the options `fake` has when it starts). */
function connector() {
  return new TerminalConnector({
    spawn: async (file, args, options) => {
      await spawning;
      const run = new FakeClaude(file, args, options, fake);
      runs.push(run);
      return run;
    },
    findClaude: () => Promise.resolve('/home/me/.local/bin/claude'),
    flags: () => Promise.resolve(helpFlags(help)),
    tmp: dir,
    timing: TIMING,
    usage: (backend, windows) => readings.push([backend, windows]),
  });
}

/**
 * Starts a session: with a connector of its own, unless `using` (sessions of one connector share
 * its folders' first runs), its events in `sink`.
 */
async function start(
  spec: Partial<SessionSpec> = {},
  { using = connector(), sink = events }: { using?: TerminalConnector; sink?: SessionEvent[] } = {},
) {
  const session = await using.start(
    { ...SPEC, ...spec },
    {
      emit: (event) => sink.push(event),
      remember: (id) => remembered.push(id),
      activity: () => {
        activity++;
      },
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
        return `end:${event.result.status === 'cancelled' ? 'interrupted' : event.result.status === 'failed' ? 'failed' : 'done'}`;
      case 'mode':
        return `mode:${event.mode ?? 'unknown'}`;
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
  it('keeps hook authorization in private files, never command arguments or child environments', async () => {
    await start({ env: { ...SPEC.env, [HOOK_TOKEN]: 'inherited-secret' } });
    const run = claude();
    const settingsFile = run.arg('--settings') ?? '';
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
      hooks: Record<
        string,
        { hooks: { command?: string; headers?: { Authorization: string } }[] }[]
      >;
    };
    const command = settings.hooks.SessionStart?.[0]?.hooks[0]?.command ?? '';
    expect(command).not.toContain(HOOK_TOKEN);
    expect(run.options.env).not.toHaveProperty(HOOK_TOKEN);
    const header = run.options.env.CORRALLM_HOOK_HEADER ?? '';
    expect(path.dirname(header)).toBe(path.dirname(settingsFile));
    expect(statSync(header).mode & 0o777).toBe(0o600);
    expect(statSync(settingsFile).mode & 0o777).toBe(0o600);
    const authorization = readFileSync(header, 'utf8').trim();
    expect(authorization).toMatch(/^Authorization: Bearer [0-9a-f]{48}$/);
    expect(settings.hooks.Stop?.[0]?.hooks[0]?.headers?.Authorization).toBe(
      authorization.slice('Authorization: '.length),
    );
    const token = authorization.slice('Authorization: Bearer '.length);
    expect(run.args.join(' ')).not.toContain(token);
    expect(JSON.stringify(run.options.env)).not.toContain(token);
    expect(command).not.toContain(token);
  });

  it.each([true, false])(
    'carries its pre-launch permission baseline when SessionStart has no permission_mode (asks: %s)',
    async (asks) => {
      await start({ startupAsks: asks });
      expect(last('started')).toMatchObject({ mode: null, asks });
      expect(last('mode')).toBeUndefined();
      expect(claude().prompts).toEqual([]);
      const settings = JSON.parse(readFileSync(claude().arg('--settings') ?? '', 'utf8')) as {
        hooks: { SessionStart?: { hooks: { type: string; command: string }[] }[] };
      };
      expect(settings.hooks.SessionStart?.[0]?.hooks[0]).toMatchObject({ type: 'command' });
      await until(() => {
        expect(claude().answers).toContainEqual({ hook: 'SessionStart', answer: '{}' });
      });
    },
  );

  it.each([{ httpHookAllowedEnvVars: ['OTHER'] }, { httpHookAllowedEnvVars: [] }])(
    'registers its file-backed hooks without an unheard warning under %j',
    async (settings) => {
      const home = path.join(dir, 'home');
      await mkdir(path.join(home, '.claude'), { recursive: true });
      await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings));
      await start({ env: { ...SPEC.env, HOME: home } });
      const kept = JSON.parse(readFileSync(claude().arg('--settings') ?? '', 'utf8')) as {
        hooks: Record<string, { hooks: { type: string; headers?: { Authorization: string } }[] }[]>;
      };
      expect(kept.hooks.SessionStart?.[0]?.hooks[0]).toMatchObject({ type: 'command' });
      expect(kept.hooks.Stop?.[0]?.hooks[0]?.type).toBe('http');
      expect(kept.hooks.Stop?.[0]?.hooks[0]?.headers?.Authorization).toMatch(
        /^Bearer [0-9a-f]{48}$/,
      );
      await until(() => {
        expect(claude().answers).toContainEqual({ hook: 'SessionStart', answer: '{}' });
      });
      expect(last('mode')).toBeUndefined();
      expect(last('unheard')).toBeUndefined();
    },
  );

  it.each([{ disableAllHooks: true }, { allowedHttpHookUrls: ['https://example.test/*'] }])(
    'does not bypass hook restrictions with the command startup post (%j)',
    async (settings) => {
      const home = path.join(dir, 'home');
      await mkdir(path.join(home, '.claude'), { recursive: true });
      await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings));
      await start({ env: { ...SPEC.env, HOME: home } });
      const kept = JSON.parse(readFileSync(claude().arg('--settings') ?? '', 'utf8')) as {
        hooks: Record<string, unknown>;
      };
      expect(kept.hooks).toEqual({});
      expect(last('unheard')).toBeDefined();
    },
  );

  it('does not pass a modern snapshot flag to an older CLI on role launch or resume', async () => {
    help = '  --model <model>  Model\n  --append-system-prompt <prompt>  Append instructions';
    const id = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11';
    fake.transcripts = [id];
    for (const role of ['Review changes', undefined]) {
      const session = await start({
        resume: id,
        roleChanged: true,
        ...(role === undefined ? {} : { role }),
      });
      expect(claude().args).toContain(`--resume=${id}`);
      expect(claude().args).not.toContain('--system-prompt-snapshot=off');
      if (role !== undefined) expect(claude().args).toContain(`--append-system-prompt=${role}`);
      expect(claude().prompts).toEqual([]);
      await session.close();
    }
  });

  it('refuses unverified role or changed-role capabilities with a retry message before spawning', async () => {
    help = '';
    const resume = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11';
    await expect(start({ role: 'Review changes' })).rejects.toThrow(
      /read Claude Code.*retry|retry.*Claude Code/i,
    );
    await expect(start({ resume, roleChanged: true })).rejects.toThrow(
      /read Claude Code.*retry|retry.*Claude Code/i,
    );
    expect(runs).toEqual([]);
  });

  it('refuses a role when the CLI cannot append native instructions', async () => {
    help = '  --model <model>  Model';
    await expect(start({ role: 'Review changes' })).rejects.toThrow(/update Claude Code/i);
    expect(runs).toEqual([]);
  });

  it.each([null, '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11'])(
    'starts a default conversation without querying optional capabilities (resume: %s)',
    async (resume) => {
      const flags = vi.fn(() => Promise.reject(new Error('Must not read optional flags')));
      if (resume !== null) fake.transcripts = [resume];
      await start(
        { resume, ...(resume === null ? {} : { roleChanged: false }) },
        {
          using: new TerminalConnector({
            findClaude: () => Promise.resolve('/home/me/.local/bin/claude'),
            flags,
            spawn: (file, args, options) => {
              const run = new FakeClaude(file, args, options, fake);
              runs.push(run);
              return Promise.resolve(run);
            },
            tmp: dir,
            timing: TIMING,
          }),
        },
      );
      expect(flags).not.toHaveBeenCalled();
      expect(claude().args).not.toContain('--system-prompt-snapshot=off');
      if (resume !== null) expect(claude().args).toContain(`--resume=${resume}`);
    },
  );

  it.each([{ effort: 'low' }, { role: 'Review changes' }])(
    'keeps the prompt snapshot when resuming with unchanged settings %j',
    async (settings) => {
      const resume = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11';
      fake.transcripts = [resume];
      await start({ resume, roleChanged: false, ...settings });
      expect(claude().args).toContain(`--resume=${resume}`);
      expect(claude().args).not.toContain('--system-prompt-snapshot=off');
      if (settings.role !== undefined) {
        expect(claude().args).toContain(`--append-system-prompt=${settings.role}`);
      }
    },
  );

  it('carries the captured role through native startup and exact-ID resume without sending a prompt', async () => {
    const role = 'Review changes\nKeep project conventions';
    const first = await start({ role });
    const id = claude().arg('--session-id');
    if (id === undefined) throw new Error('No native session ID');
    expect(claude().args).toContain(`--append-system-prompt=${role}`);
    expect(claude().args).not.toContain('--system-prompt-snapshot=off');
    expect(claude().prompts).toEqual([]);
    await first.close();
    const second = await start({ resume: id, role: 'Updated role', roleChanged: true });
    expect(claude().args).toContain(`--resume=${id}`);
    expect(claude().args).toContain('--append-system-prompt=Updated role');
    expect(claude().args).toContain('--system-prompt-snapshot=off');
    expect(claude().prompts).toEqual([]);
    await second.close();
    await start({ resume: id, roleChanged: true });
    expect(claude().args).toContain(`--resume=${id}`);
    expect(claude().args).toContain('--system-prompt-snapshot=off');
    expect(claude().args.some((arg) => arg.startsWith('--append-system-prompt='))).toBe(false);
    expect(claude().prompts).toEqual([]);
  });

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
    expect(events[0]).toEqual({ type: 'started', model: null, mode: null, models: [] });

    const { env } = run.options;
    expect(env).toMatchObject({ PATH: '/usr/bin', TERM: 'xterm-256color', COLORTERM: 'truecolor' });
    expect(env).not.toHaveProperty(HOOK_TOKEN);
    // It must report its status to corrallm's terminal.
    expect(env).not.toHaveProperty('CLAUDE_CODE_DISABLE_TERMINAL_TITLE');

    const settings = run.arg('--settings') ?? '';
    expect(path.dirname(path.dirname(settings))).toBe(dir);
    const { hooks } = JSON.parse(readFileSync(settings, 'utf8')) as {
      hooks: Record<string, { hooks: { url: string }[] }[]>;
    };
    expect(hooks.UserPromptSubmit?.[0]?.hooks[0]?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook$/);
  });

  it('counts hooks but not raw screen redraws as activity without an attached terminal view', async () => {
    await start();
    const before = activity;
    claude().print('Still working…');
    expect(activity).toBe(before);
    const printed = activity;
    await claude().hook('Notification', { message: 'Progress' });
    expect(activity).toBeGreaterThan(printed);
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
          ['claude-code', { fiveHour: { usedPercent: 61, resetsAt: 1_791_810_000_000 } }],
        ]);
      });
    },
  );

  it('says once, as it starts, that it can’t hear Claude Code where its settings turn hooks off', async () => {
    await start();
    expect(seen()).not.toContain('unheard');
    // The user's settings, read as they are (never changed).
    const home = path.join(dir, 'home');
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude', 'settings.json'), '{ "disableAllHooks": true }');
    events = [];
    const session = await start({ env: { ...SPEC.env, HOME: home } });
    expect(seen().slice(0, 2)).toEqual(['started', 'unheard']);
    expect(last('unheard')?.text).toMatch(
      /^Claude Code’s settings turn off its hooks \(disableAllHooks in ~.\.claude.settings\.json\), so corrallm can’t hear this agent’s replies/,
    );
    await session.send({ id: 'm1', text: 'hello there' });
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    expect(seen().filter((one) => one === 'unheard')).toHaveLength(1);
    expect(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).toBe(
      '{ "disableAllHooks": true }',
    );
  });

  it('starts in a mode or model chosen in corrallm', async () => {
    await start({ mode: 'plan', model: 'haiku' });
    expect(claude().arg('--permission-mode')).toBe('plan');
    expect(claude().arg('--model')).toBe('haiku');
  });

  it('starts at the effort chosen in corrallm, where its claude takes --effort', async () => {
    await start({ effort: 'low' });
    expect(claude().arg('--effort')).toBe('low');
    // None chosen: the user's own.
    await start({ effort: null });
    expect(claude().args).not.toContain('--effort');
    // Not one of Claude Code's levels: left out.
    await start({ effort: 'ultra' });
    expect(claude().args).not.toContain('--effort');
    // An older claude, without the flag, would not start with it: left out.
    help = '  --model <model>  Model for the current session';
    await start({ effort: 'low' });
    expect(claude().args).not.toContain('--effort');
    expect(claude().arg('--settings')).toBeDefined();
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

  it('pauses Claude Code while its screen copy is behind, so a flood of output never overflows it', async () => {
    // xterm.js throws away writes (throwing in main) once more than 5e7 characters are pending.
    await start();
    await until(() => {
      expect(claude().written).toContain('\x1b]7501;?\x1b\\');
    });
    const chunk = 'x'.repeat(1 << 20);
    for (let i = 0; i < 60; i += 1) claude().print(chunk);
    expect(claude().pauses).toBeGreaterThan(0);
    await until(() => {
      expect(claude().drained).toBe(true);
    }, 30_000);
  }, 60_000);

  it('resumes the session it had; one with no transcript starts afresh under its id', async () => {
    const kept = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11';
    const gone = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e12';
    fake.transcripts = [kept];
    await start({ resume: kept });
    expect(claude().arg('--resume')).toBe(kept);
    expect(claude().args).toContain(`--resume=${kept}`);

    await start({ resume: gone, role: 'Fallback review role' });
    await until(() => {
      expect(claude().arg('--session-id')).toBe(gone);
    });
    expect(runs.map((run) => run.arg('--resume') ?? run.arg('--session-id'))).toEqual([
      kept,
      gone,
      gone,
    ]);
    expect(
      runs.slice(-2).map((run) => run.args.includes('--append-system-prompt=Fallback review role')),
    ).toEqual([true, true]);
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
      'status:working',
      'user:Fix the bug',
      'mode:manual',
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
      [
        'status:working',
        'mode:manual',
        'user:hello there',
        'text:Done: hello there',
        'end:done',
      ].sort(),
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
      'status:working',
      'user:ask to run the tests',
      'mode:manual',
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
    const shown: TerminalEvent[] = [];
    const hide = session.terminal?.show((event) => shown.push(event));
    await session.send({ id: 'm1', text: 'ask to run the tests' });
    await until(() => {
      expect(last('asking')?.asks).toHaveLength(1);
    });
    expect(last('asking')?.asks[0]).toMatchObject({ kind: 'permission', summary: 'echo hello' });
    // The hook reaches main before the CLI receives its HTTP response and draws the choices.
    // Answer only once the native prompt is visible, as a person at the console would.
    await until(() => {
      expect(
        shown.some(
          (event) => event.type !== 'exit' && event.data.includes('Do you want to proceed?'),
        ),
      ).toBe(true);
    });
    session.terminal?.input('1');
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    expect(last('asking')?.asks).toEqual([]);
    hide?.();
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
    expect(last('end')).toMatchObject({
      messages: ['m1'],
      result: { status: 'cancelled', reason: 'interrupted' },
    });
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
    expect(events.filter((event) => event.type === 'user')).toEqual([]);
    await session.interrupt();
    expect(events.filter((event) => event.type === 'user')).toEqual([]);
    expect(last('end')).toMatchObject({
      messages: ['m1'],
      result: { status: 'cancelled', reason: 'interrupted' },
    });
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

  it('presses Enter once the prompt shows what was typed, though Claude Code reads keys late', async () => {
    // As the real CLI does right after the folder trust dialog and as a turn ends: keys that pile
    // up while it is busy are read in one go, as a paste, where Enter is not a submit.
    fake.trust = true;
    fake.busy = 100;
    const session = await start();
    await session.send({ id: 'm1', text: 'Hello' });
    await until(() => {
      expect(seen()).toContain('status:waiting');
    });
    session.terminal?.input('\r');
    const ends = () => events.filter((event) => event.type === 'end');
    await until(() => {
      expect(ends()).toHaveLength(1);
    });
    // Typed as soon as the turn has ended.
    await session.send({ id: 'm2', text: 'And the changelog' });
    await until(() => {
      expect(ends()).toHaveLength(2);
    });
    expect(claude().prompts).toEqual(['Hello', 'And the changelog']);
    expect(seen()).not.toContainEqual(expect.stringMatching(/^notice:/));
    expect(ends()).toMatchObject([
      { messages: ['m1'], result: { status: 'completed', reason: 'completed' } },
      { messages: ['m2'], result: { status: 'completed', reason: 'completed' } },
    ]);
  });

  it('lists Claude Code’s folder trust dialog as asking the user, though no turn goes on', async () => {
    fake.trust = true;
    const session = await start();
    await until(() => {
      expect(last('asking')?.asks).toEqual([{ kind: 'trust', id: expect.any(String) as unknown }]);
    });
    // The user trusts the folder, in the terminal: it asks nothing more.
    session.terminal?.input('\r');
    await until(() => {
      expect(last('asking')?.asks).toEqual([]);
    });
    // Nothing ran: no turn, so no status.
    expect(seen()).toEqual(['started', 'asking:trust', 'asking:']);
  });

  it('waits on the user at once while the folder trust dialog keeps the prompt from showing', async () => {
    fake.trust = true;
    const session = await start();
    await until(() => {
      expect(seen()).toContain('asking:trust');
    });
    await session.send({ id: 'm1', text: 'Hello' });
    expect(seen()).toContain('status:waiting');
    expect(claude().prompts).toEqual([]);
    // The user trusts the folder, in the terminal.
    session.terminal?.input('\r');
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    expect(claude().prompts).toEqual(['Hello']);
    expect(seen(1)).toEqual([
      'asking:trust',
      'status:waiting',
      'asking:',
      'status:working',
      'user:Hello',
      'mode:manual',
      'text:Done: Hello',
      'end:done',
    ]);
  });

  it('starts one Claude Code first in a folder, and the others once it is trusted there', async () => {
    fake.trust = true;
    const using = connector();
    const first: SessionEvent[] = [];
    const second: SessionEvent[] = [];
    const a = await start({ agentId: 'a' }, { using, sink: first });
    const b = await start({ agentId: 'b' }, { using, sink: second });
    // Only the first runs, and asks whether to trust the folder.
    expect(runs).toHaveLength(1);
    await until(() => {
      expect(first.findLast((event) => event.type === 'asking')).toMatchObject({
        asks: [{ kind: 'trust' }],
      });
    });
    // The other's view says why it waits.
    const shown: TerminalEvent[] = [];
    b.terminal?.show((event) => shown.push(event));
    await until(() => {
      expect(shown[0]?.type === 'screen' && shown[0].data).toContain(
        'Another agent’s Claude Code is starting in this folder first.',
      );
    });
    // A message for it waits too, on the other agent's dialog, not on the user here.
    await b.send({ id: 'm1', text: 'Hello from b' });
    await new Promise((resolve) => setTimeout(resolve, TIMING.startup + 30));
    expect(second.map((event) => event.type)).toEqual(['started', 'status']);
    expect(second.at(-1)).toEqual({ type: 'status', status: 'working' });

    // Trusted in the first one's terminal: the other starts, asks nothing, and takes its message.
    fake.trust = false;
    a.terminal?.input('\r');
    await until(() => {
      expect(runs).toHaveLength(2);
    });
    await until(() => {
      expect(second.findLast((event) => event.type === 'end')).toBeDefined();
    });
    expect(runs[1]?.prompts).toEqual(['Hello from b']);
    expect(second.filter((event) => event.type === 'user')).toEqual([
      { type: 'user', id: 'm1', text: 'Hello from b' },
    ]);
    expect(second.filter((event) => event.type === 'asking')).toEqual([]);
    // Its view starts afresh, from the new process's screen.
    const fresh = shown.findLastIndex((event) => event.type === 'screen');
    expect(fresh).toBeGreaterThan(0);
    expect(
      shown
        .slice(fresh)
        .some((event) => event.type === 'output' && event.data.includes('Claude Code (fake)')),
    ).toBe(true);
    // Later ones start at once.
    await start({ agentId: 'c' }, { using, sink: [] });
    expect(runs).toHaveLength(3);
  });

  it('ends the CLI of a session closed as it starts, once the folder is trusted', async () => {
    fake.trust = true;
    const using = connector();
    const a = await start({ agentId: 'a' }, { using, sink: [] });
    const b = await start({ agentId: 'b' }, { using, sink: [] });
    let spawned: () => void = () => undefined;
    spawning = new Promise((resolve) => {
      spawned = resolve;
    });
    fake.trust = false;
    a.terminal?.input('\r');
    // b's CLI is on its way when b closes.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await b.close();
    spawned();
    await until(() => {
      expect(runs).toHaveLength(2);
    });
    await until(() => {
      expect(runs[1]?.exited).toBe(true);
    });
  });

  it('starts the next one waiting when the first exits at its trust dialog; never one that closed', async () => {
    fake.trust = true;
    const using = connector();
    const second: SessionEvent[] = [];
    await start({ agentId: 'a' }, { using, sink: [] });
    const b = await start({ agentId: 'b' }, { using, sink: [] });
    await start({ agentId: 'c' }, { using, sink: second });
    await b.close();
    // The user picked "No, exit": the next one waiting starts, and asks in its turn.
    claude().exit(1);
    await until(() => {
      expect(runs).toHaveLength(2);
    });
    await until(() => {
      expect(second.findLast((event) => event.type === 'asking')).toMatchObject({
        asks: [{ kind: 'trust' }],
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runs).toHaveLength(2);
  });

  it('says why a turn failed, once, and ends it failed', async () => {
    const session = await start();
    await session.send({ id: 'm1', text: 'fail please' });
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    expect(seen(1)).toEqual([
      'status:working',
      'user:fail please',
      'mode:manual',
      'notice:error:Limit reached',
      'end:failed',
    ]);
    // Its StopFailure hook says nothing of when the limit lifts: the core takes that from the
    // backend's latest reading (core/engines.ts).
    expect(last('end')?.result).toEqual({
      status: 'failed',
      reason: 'usage-limit',
      message: 'Limit reached',
    });
  });

  it('works without status reports (an older Claude Code): its prompt and hooks tell', async () => {
    fake.reports = false;
    const session = await start();
    await session.send({ id: 'm1', text: 'Hello' });
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    expect(seen(1)).toEqual([
      'status:working',
      'user:Hello',
      'mode:manual',
      'text:Done: Hello',
      'end:done',
    ]);
  });

  it('follows the session id and the permission mode its hooks tell', async () => {
    const afterClear = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e13';
    fake.sessionId = afterClear;
    const session = await start();
    claude().setMode('acceptEdits');
    await session.send({ id: 'm1', text: 'Hello' });
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    expect(remembered.at(-1)).toBe(afterClear);
    expect(seen()).toContain('mode:acceptEdits');
    // /clear: until the next prompt says the new id, one that starts afresh after a restart.
    await claude().hook('SessionEnd', { reason: 'clear' });
    await until(() => {
      expect(remembered).toHaveLength(3);
    });
    expect(remembered[2]).not.toBe(afterClear);
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

  it('gives Claude its native Ctrl+C exit sequence before resorting to a kill', async () => {
    fake = { exitOnCtrlC: 3 };
    const session = await start();
    await session.close();
    expect(claude().written.filter((keys) => keys === '\x03')).toHaveLength(3);
    expect(claude().kills).toEqual([]);
    expect(claude().exited).toBe(true);
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
