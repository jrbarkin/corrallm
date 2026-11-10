import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdapterPrompt,
  PromptAnswer,
  PromptEnded,
  PromptEvent,
} from '../../../shared/model/prompts';
import type { CodexMode, SessionEvent } from '../../../shared/session';
import type { SessionSpec } from '../connector';
import type { TerminalCli, TerminalHold, TerminalSignal } from './cli';
import { HookServer } from './hooks';
import type { HookEvent, HookRegistration } from './hooks';
import type { Pty, PtyOptions } from './pty';
import type { Screen } from './screen';
import { TerminalSession, TIMING } from './session';
import type { ProgramStatus } from './status';

/*
 * B23: a Terminal session that holds its CLI's hook requests. A CLI shaped like both real ones
 * (its state in its window title) with a hook that decides, behind the real hook server: held
 * requests are listed as the CLI reports the wait they cover (`both`) or from their arrival
 * (`api`), answered only through their own request, let go of at their deadline, and ended as the
 * terminal, the CLI or the session ends them.
 */

const title = (text: string) => `\x1b]0;${text}\x07`;
const yes = { value: 'yes', label: 'Yes', hint: 'allow_once' } as const;
const no = { value: 'no', label: 'No', hint: 'reject_once' } as const;

/** What a request names: the prompt it raises, held. */
function approval(answerIn: 'both' | 'api' | 'terminal', command = 'ls'): AdapterPrompt {
  return {
    kind: 'approval',
    title: 'Held wants to run a command',
    subject: { type: 'command', command, cwd: '/work/app' },
    answerIn,
    choices: answerIn === 'terminal' ? [] : [yes, no],
  };
}

/** A question as a hook tells it (no previews) and as a held card shows it (with them). */
function ask(previews: boolean, answerIn: 'terminal' | 'api'): AdapterPrompt {
  return {
    kind: 'question',
    title: 'Pick a color',
    answerIn,
    questions: [
      {
        id: 'q1',
        header: 'Color',
        text: 'Pick a color',
        options: [
          { label: 'Red', ...(previews ? { preview: '<b>red</b>' } : {}) },
          { label: 'Blue', ...(previews ? { preview: '<b>blue</b>' } : {}) },
        ],
        multiple: false,
        other: true,
      },
    ],
  };
}

class HeldCli implements TerminalCli<CodexMode> {
  readonly name = 'Held';
  readonly words = {
    answer: 'Answer it in its terminal.',
    mode: 'Use /permissions in its terminal.',
    model: 'Use /model in its terminal.',
    login: 'Log in in its terminal.',
    waiting: {
      permission: 'It asks for your approval.',
      question: 'It asks you something.',
      auth: 'Log in in its terminal.',
      none: 'It needs you: see its terminal.',
    },
  };
  hooks: HookRegistration | undefined;

  newId(): null {
    return null;
  }
  prepare(_dir: string, hooks: HookRegistration): Promise<void> {
    this.hooks = hooks;
    return Promise.resolve();
  }
  args(): string[] {
    return [];
  }
  resumeFailed(): boolean {
    return false;
  }
  title(text: string): ProgramStatus | undefined {
    if (text.includes('Action Required')) {
      // What the dialog says follows the colon, as a CLI that describes its wait.
      const msg = text.split('Action Required:')[1]?.trim();
      return { state: 'blocked', kind: 'permission', ...(msg ? { msg } : {}) };
    }
    if (text.includes('Working')) return { state: 'working' };
    if (text === 'Ready') return { state: 'idle' };
    return undefined;
  }
  hook(event: HookEvent): TerminalSignal<CodexMode>[] {
    // What it tells without holding: the ask, answered in the terminal.
    if (event.hook_event_name === 'PreToolUse' && event.question === true) {
      return [{ kind: 'ask', id: 'told-q', prompt: ask(false, 'terminal') }];
    }
    if (event.hook_event_name === 'PreToolUse') {
      return [{ kind: 'ask', id: 'told', prompt: approval('terminal') }];
    }
    if (event.hook_event_name === 'PermissionRequest' && event.question === true) return [];
    if (event.hook_event_name === 'PermissionRequest') {
      return [{ kind: 'ask', id: 'told2', prompt: approval('terminal') }];
    }
    return [];
  }
  hold(event: HookEvent): TerminalHold | undefined {
    if (event.hook_event_name !== 'PermissionRequest') return undefined;
    if (event.question === true) {
      return { prompt: ask(true, 'api'), reply: () => ({}) };
    }
    const answerIn = event.answer_in === 'api' ? 'api' : 'both';
    return {
      prompt: approval(answerIn),
      reply: (answer: PromptAnswer) => {
        if (answer.kind !== 'choice') throw new Error('Only a choice.');
        if (answer.value === 'broken') throw new Error('It cannot say that.');
        return { decision: answer.value };
      },
    };
  }
  draft(screen: Screen): string | undefined {
    const line = screen
      .text()
      .split('\n')
      .find((row) => row.startsWith('›'));
    return line?.slice(1).trim();
  }
  keystrokes(text: string): string[] {
    return [text];
  }
  submitted(text: string): string {
    return text.trim();
  }
}

/** A CLI that never reports a state: nothing says when a wait begins or ends. */
class SilentCli extends HeldCli {
  override title(): ProgramStatus | undefined {
    return undefined;
  }
}

class FakePty implements Pty {
  readonly pid = 78;
  readonly #data = new Set<(data: string) => void>();
  readonly #exit = new Set<(exit: { exitCode: number }) => void>();
  readonly args: readonly string[];
  readonly options: PtyOptions;
  constructor(args: readonly string[], options: PtyOptions) {
    this.args = args;
    this.options = options;
    setTimeout(() => {
      this.print(title('Ready'));
      this.print('\x1b[H\x1b[2J › \r\n');
    }, 1);
  }
  print(data: string): void {
    for (const listener of this.#data) listener(data);
  }
  onData(listener: (data: string) => void): void {
    this.#data.add(listener);
  }
  onExit(listener: (exit: { exitCode: number }) => void): void {
    this.#exit.add(listener);
  }
  resize(): void {
    /* Nothing to redraw. */
  }
  pause(): void {
    /* Never fills. */
  }
  resume(): void {
    /* Never fills. */
  }
  write(): void {
    /* Typed keys are not under test. */
  }
  kill(): void {
    for (const listener of this.#exit) listener({ exitCode: 0 });
  }
}

let dir: string;
let events: SessionEvent[];
let owner: (PromptEvent | PromptEnded)[];
let sessions: TerminalSession<CodexMode>[];
let aborts: AbortController[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-held-'));
  events = [];
  owner = [];
  sessions = [];
  aborts = [];
});
afterEach(async () => {
  for (const abort of aborts) abort.abort();
  await Promise.all(sessions.map((session) => session.close()));
  await rm(dir, { recursive: true, force: true });
});

const SPEC: SessionSpec<CodexMode> = {
  agentId: 'a',
  cwd: '/work/app',
  env: { PATH: '/usr/bin' },
  model: null,
  mode: 'auto',
  resume: null,
};

/** The session, its CLI and its fake terminal, with the hook server holding for `heldMs`. */
async function start(heldMs = 5000, cli: HeldCli = new HeldCli()) {
  let pty: FakePty | undefined;
  const session = new TerminalSession<CodexMode>(
    SPEC,
    {
      emit: (event) => {
        if (event.type === 'prompt' || event.type === 'prompt-ended') owner.push(event);
        else events.push(event);
      },
      remember: () => undefined,
    },
    {
      executable: '/bin/held',
      cli,
      spawn: (_file, args, options) => {
        pty = new FakePty(args, options);
        return Promise.resolve(pty);
      },
      hooks: new HookServer({ heldMs }),
      tmp: dir,
      features: { role: 'none', resume: false, list: false },
      env: () => ({ ...SPEC.env }),
      timing: {
        ...TIMING,
        key: 0,
        enter: 1,
        confirm: 300,
        settle: 5,
        startup: 120,
        batch: 1,
        kill: 200,
      },
    },
  );
  await session.launch();
  sessions.push(session);
  // Its first screen is drawn.
  await pause(30);
  const screen = () => {
    if (pty === undefined) throw new Error('not started');
    return pty;
  };
  return { cli, session, screen };
}

type Started = Awaited<ReturnType<typeof start>>;

/** Posts a hook as the CLI would, without waiting for the reply. */
function post(started: Started, event: Record<string, unknown>) {
  const hooks = started.cli.hooks;
  if (hooks === undefined) throw new Error('not prepared');
  const abort = new AbortController();
  aborts.push(abort);
  return fetch(hooks.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hooks.token}` },
    body: JSON.stringify(event),
    signal: abort.signal,
  }).then(async (response) => ({
    status: response.status,
    body: (await response.json()) as unknown,
  }));
}
const request = (more: Record<string, unknown> = {}) => ({
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  ...more,
});

const until = (check: () => void) => vi.waitFor(check, { timeout: 2000, interval: 5 });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The prompts the owner settled with an answer (it, not the session, ends those). */
const settled = new Set<string>();
beforeEach(() => {
  settled.clear();
});

/** What the owner has been raised and not ended, by key. */
function open(): Map<string, AdapterPrompt> {
  const live = new Map<string, AdapterPrompt>();
  for (const event of owner) {
    if (event.type === 'prompt') live.set(event.key, event.prompt);
    else live.delete(event.key);
  }
  for (const key of settled) live.delete(key);
  return live;
}

/** Answers as the core's owner does: the session writes it, and the owner settles the prompt. */
function answerAs(started: Started, key: string, answer: PromptAnswer): void {
  started.session.prompts.answer(key, answer);
  settled.add(key);
}
const endsOf = () => owner.filter((event): event is PromptEnded => event.type === 'prompt-ended');
const lastStatus = () =>
  events.findLast(
    (event): event is Extract<SessionEvent, { type: 'status' }> => event.type === 'status',
  )?.status;

/** A turn that works, so a status can be told. */
async function working(started: Started) {
  started.screen().print(title('⠋ Working'));
  await until(() => {
    expect(lastStatus()).toBe('working');
  });
}

describe('a held request, answered in the terminal too (both)', () => {
  it('is listed only once the CLI reports the wait it covers, with its deadline', async () => {
    const started = await start();
    await working(started);
    const reply = post(started, request());
    await pause(60);
    expect(open().size).toBe(0);
    await pause(40);
    started.screen().print(title('[ ! ] Action Required'));
    await until(() => {
      expect(open().size).toBe(1);
    });
    const [prompt] = [...open().values()];
    expect(prompt).toMatchObject({
      kind: 'approval',
      answerIn: 'both',
      title: approval('both').title,
    });
    expect(prompt?.until).toBeGreaterThan(Date.now());
    // The told ask (`ask` signal) is superseded by the hold: only one prompt is listed.
    expect(open().size).toBe(1);
    // Nothing is written until it is answered.
    const early = await Promise.race([reply, pause(40).then(() => 'waiting')]);
    expect(early).toBe('waiting');
  });

  it('lists nothing when the CLI never reports a wait, and lets the request go at its deadline', async () => {
    const started = await start(120);
    await working(started);
    const reply = post(started, request());
    await expect(reply).resolves.toEqual({ status: 200, body: {} });
    expect(owner).toEqual([]);
  });

  it('writes the owner’s answer to that request alone, ending and raising nothing', async () => {
    const started = await start();
    await working(started);
    const first = post(started, request({ tool_name: 'Bash' }));
    await pause(40);
    const other = post(started, request({ tool_name: 'Write' }));
    await pause(40);
    started.screen().print(title('[ ! ] Action Required'));
    await until(() => {
      expect(open().size).toBeGreaterThan(0);
    });
    const [key] = [...open().keys()];
    if (key === undefined) throw new Error('no prompt');
    answerAs(started, key, { kind: 'choice', value: 'yes' });
    const replies = [
      first.then((value) => ({ which: 'first', value })),
      other.then((value) => ({ which: 'other', value })),
    ];
    const winner = await Promise.race(replies);
    expect(winner.value).toEqual({ status: 200, body: { decision: 'yes' } });
    // The other request is still pending: the answer was written to one request alone.
    const rest = replies[winner.which === 'first' ? 1 : 0];
    expect(await Promise.race([rest, pause(60).then(() => 'waiting')])).toBe('waiting');
    expect(endsOf()).toEqual([]);
  });

  it('refuses an answer its CLI cannot express, writing nothing and keeping the prompt', async () => {
    const started = await start(5000);
    await working(started);
    const reply = post(started, request());
    await pause(40);
    started.screen().print(title('[ ! ] Action Required'));
    await until(() => {
      expect(open().size).toBe(1);
    });
    const [key] = [...open().keys()];
    if (key === undefined) throw new Error('no prompt');
    expect(() => {
      started.session.prompts.answer(key, { kind: 'choice', value: 'broken' });
    }).toThrow(/cannot say/);
    expect(open().size).toBe(1);
    expect(await Promise.race([reply, pause(40).then(() => 'waiting')])).toBe('waiting');
  });

  it('raises a wait the CLI still reports after an answer, but not one that clears in time', async () => {
    const started = await start();
    await working(started);
    void post(started, request()).catch(() => undefined);
    await pause(40);
    started.screen().print(title('[ ! ] Action Required'));
    await until(() => {
      expect(open().size).toBe(1);
    });
    const [key] = [...open().keys()];
    if (key === undefined) throw new Error('no prompt');
    answerAs(started, key, { kind: 'choice', value: 'yes' });
    // Spoken for through the grace (300 ms) ...
    await pause(100);
    expect(open().size).toBe(0);
    // ... and still reported after it: the CLI did not act on the reply, so it shows as a wait.
    await until(() => {
      expect(open().size).toBe(1);
    });
    expect([...open().values()][0]).toMatchObject({ answerIn: 'terminal' });
  });

  it('raises nothing for a wait that clears within the grace', async () => {
    const started = await start();
    await working(started);
    void post(started, request()).catch(() => undefined);
    await pause(40);
    started.screen().print(title('[ ! ] Action Required'));
    await until(() => {
      expect(open().size).toBe(1);
    });
    const [key] = [...open().keys()];
    if (key === undefined) throw new Error('no prompt');
    answerAs(started, key, { kind: 'choice', value: 'yes' });
    started.screen().print(title('⠙ Working'));
    await pause(450);
    expect(open().size).toBe(0);
    expect(endsOf()).toEqual([]);
  });

  it('ends answered in the terminal when the wait clears to working, releasing the request at once', async () => {
    const started = await start();
    await working(started);
    const reply = post(started, request());
    await pause(40);
    started.screen().print(title('[ ! ] Action Required'));
    await until(() => {
      expect(open().size).toBe(1);
    });
    const [key] = [...open().keys()];
    if (key === undefined) throw new Error('no prompt');
    started.screen().print(title('⠙ Working'));
    await expect(reply).resolves.toEqual({ status: 200, body: {} });
    expect(endsOf()).toEqual([{ type: 'prompt-ended', key, reason: 'answered-natively' }]);
    expect(() => {
      started.session.prompts.answer(key, { kind: 'choice', value: 'yes' });
    }).toThrow();
  });

  it('withdraws it when the wait clears to idle', async () => {
    const started = await start();
    await working(started);
    const reply = post(started, request());
    await pause(40);
    started.screen().print(title('[ ! ] Action Required'));
    await until(() => {
      expect(open().size).toBe(1);
    });
    started.screen().print(title('Ready'));
    await expect(reply).resolves.toEqual({ status: 200, body: {} });
    expect(endsOf().map((end) => end.reason)).toEqual(['withdrawn']);
  });
});

describe('a held request only corrallm answers (api)', () => {
  it('is listed from its arrival, makes the session wait, and is answered through its request', async () => {
    const started = await start();
    await working(started);
    const reply = post(started, request({ answer_in: 'api' }));
    await until(() => {
      expect(open().size).toBe(1);
    });
    const [key, prompt] = [...open().entries()][0] ?? [];
    expect(prompt).toMatchObject({ answerIn: 'api', title: approval('api').title });
    expect(prompt?.until).toBeGreaterThan(Date.now());
    await until(() => {
      expect(lastStatus()).toBe('waiting');
    });
    answerAs(started, key ?? '', { kind: 'choice', value: 'no' });
    await expect(reply).resolves.toEqual({ status: 200, body: { decision: 'no' } });
    await until(() => {
      expect(lastStatus()).toBe('working');
    });
  });

  it('moves to its terminal at its deadline: let go of, ended moved, raised again answered there', async () => {
    const started = await start(150);
    await working(started);
    const reply = post(started, request({ answer_in: 'api' }));
    await until(() => {
      expect(open().size).toBe(1);
    });
    const [key, held] = [...open().entries()][0] ?? [];
    await expect(reply).resolves.toEqual({ status: 200, body: {} });
    await until(() => {
      expect(endsOf()).toEqual([{ type: 'prompt-ended', key, reason: 'moved' }]);
    });
    // The CLI now shows its own dialog: raised again as one answered in the terminal, the same
    // ask with no choices and no deadline.
    started.screen().print(title('[ ! ] Action Required'));
    await until(() => {
      expect(open().size).toBe(1);
    });
    const again = [...open().values()][0];
    expect(again).toMatchObject({
      kind: 'approval',
      title: held?.title,
      subject: held && 'subject' in held ? held.subject : undefined,
      answerIn: 'terminal',
      choices: [],
    });
    expect(again).not.toHaveProperty('until');
    // A late answer is refused.
    expect(() => {
      started.session.prompts.answer(key ?? '', { kind: 'choice', value: 'yes' });
    }).toThrow();
  });

  it('moves to its terminal on release, and on a decline, never answering', async () => {
    const started = await start();
    await working(started);
    for (const let_go of ['release', 'decline'] as const) {
      const reply = post(started, request({ answer_in: 'api' }));
      await until(() => {
        expect([...open().values()].some((prompt) => prompt.answerIn === 'api')).toBe(true);
      });
      const key = [...open().entries()].find(([, prompt]) => prompt.answerIn === 'api')?.[0] ?? '';
      if (let_go === 'release') started.session.prompts.release?.(key);
      else started.session.prompts.decline(key, 'because');
      await expect(reply).resolves.toEqual({ status: 200, body: {} });
      expect(endsOf().find((end) => end.key === key)?.reason).toBe('moved');
    }
  });
});

describe('a telling a hold supersedes', () => {
  it('lists the ask once, answerable in both places, not twice', async () => {
    const started = await start();
    await working(started);
    // The hook that only tells comes first, as Claude's PreToolUse does.
    await post(started, { hook_event_name: 'PreToolUse' });
    started.screen().print(title('[ ! ] Action Required'));
    await until(() => {
      expect([...open().values()].map((prompt) => prompt.answerIn)).toEqual(['terminal']);
    });
    void post(started, request()).catch(() => undefined);
    await until(() => {
      expect([...open().values()].map((prompt) => prompt.answerIn)).toEqual(['both']);
    });
    expect(endsOf().map((end) => end.reason)).toEqual(['withdrawn']);
  });
});

describe('a held question whose options have previews', () => {
  it('supersedes its telling and, moved at its deadline, is listed once in the terminal', async () => {
    const started = await start(150);
    await working(started);
    await post(started, { hook_event_name: 'PreToolUse', question: true });
    const reply = post(started, request({ question: true, answer_in: 'api' }));
    await until(() => {
      expect([...open().values()].map((prompt) => prompt.answerIn)).toEqual(['api']);
    });
    await expect(reply).resolves.toEqual({ status: 200, body: {} });
    await until(() => {
      expect(endsOf().map((end) => end.reason)).toEqual(['moved']);
    });
    // The CLI now shows its dialog: one terminal prompt for the one question.
    started.screen().print(title('[ ! ] Action Required'));
    await until(() => {
      expect([...open().values()].map((prompt) => prompt.answerIn)).toEqual(['terminal']);
    });
    await pause(40);
    expect(open().size).toBe(1);
  });
});

describe('the end of a hold', () => {
  it('withdraws what the CLI closes, raising and writing nothing', async () => {
    const started = await start();
    await working(started);
    const reply = post(started, request({ answer_in: 'api' }));
    reply.catch(() => undefined);
    await until(() => {
      expect(open().size).toBe(1);
    });
    const [key] = [...open().keys()];
    aborts.at(-1)?.abort();
    await until(() => {
      expect(endsOf()).toEqual([{ type: 'prompt-ended', key, reason: 'withdrawn' }]);
    });
    expect(open().size).toBe(0);
  });

  it('releases every hold when the turn ends and when the session closes', async () => {
    const started = await start();
    await working(started);
    const one = post(started, request({ answer_in: 'api' }));
    await until(() => {
      expect(open().size).toBe(1);
    });
    started.screen().print(title('Ready'));
    await expect(one).resolves.toEqual({ status: 200, body: {} });
    expect(endsOf().map((end) => end.reason)).toEqual(['withdrawn']);
    await working(started);
    const two = post(started, request({ answer_in: 'api' }));
    await until(() => {
      expect(open().size).toBe(1);
    });
    await started.session.close();
    await expect(two).resolves.toEqual({ status: 200, body: {} });
    expect(open().size).toBe(0);
  });

  it('holds only what its CLI says to hold; every other event is answered at once', async () => {
    const started = await start();
    await expect(post(started, { hook_event_name: 'Stop' })).resolves.toEqual({
      status: 200,
      body: {},
    });
    await expect(
      post(started, { hook_event_name: 'UserPromptSubmit', prompt: 'x' }),
    ).resolves.toEqual({
      status: 200,
      body: {},
    });
  });
});

describe('a wait its CLI describes anew', () => {
  const skew = { ms: 0 };
  beforeEach(() => {
    skew.ms = 0;
    const real = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => real() + skew.ms);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const bothPrompts = () => [...open().values()].map((prompt) => prompt.answerIn);

  async function firstHold(started: Started) {
    await working(started);
    const reply = post(started, request());
    reply.catch(() => undefined);
    await pause(40);
    started.screen().print(title('[ ! ] Action Required: approve a'));
    await until(() => {
      expect(bothPrompts()).toEqual(['both']);
    });
    return { reply };
  }

  it('withdraws the hold it replaced, releasing its request, and holds the next', async () => {
    const started = await start();
    const { reply: first } = await firstHold(started);
    const [key] = [...open().keys()];
    void post(started, request({ tool_name: 'Write' })).catch(() => undefined);
    await pause(40);
    started.screen().print(title('[ ! ] Action Required: approve b'));
    await expect(first).resolves.toEqual({ status: 200, body: {} });
    expect(endsOf()).toEqual([{ type: 'prompt-ended', key, reason: 'withdrawn' }]);
    await until(() => {
      expect(bothPrompts()).toEqual(['both']);
    });
    expect(() => {
      started.session.prompts.answer(key ?? '', { kind: 'choice', value: 'yes' });
    }).toThrow();
  });

  it('does so too when the first wait lasted longer than the window', async () => {
    const started = await start();
    const { reply: first } = await firstHold(started);
    skew.ms = 6000;
    void post(started, request({ tool_name: 'Write' })).catch(() => undefined);
    await pause(40);
    started.screen().print(title('[ ! ] Action Required: approve b'));
    await expect(first).resolves.toEqual({ status: 200, body: {} });
    expect(endsOf().map((end) => end.reason)).toEqual(['withdrawn']);
    await until(() => {
      expect(bothPrompts()).toEqual(['both']);
    });
  });

  it('binds the next hold after an owner answer', async () => {
    const started = await start();
    await firstHold(started);
    const [key] = [...open().keys()];
    answerAs(started, key ?? '', { kind: 'choice', value: 'yes' });
    skew.ms = 6000;
    void post(started, request({ tool_name: 'Write' })).catch(() => undefined);
    await pause(40);
    started.screen().print(title('[ ! ] Action Required: approve b'));
    await until(() => {
      expect(bothPrompts()).toEqual(['both']);
    });
  });
});

describe('a CLI that never reports a state', () => {
  it('releases a both hold at once and tells its ask answered in the terminal', async () => {
    const started = await start(5000, new SilentCli());
    const reply = post(started, request());
    await expect(reply).resolves.toEqual({ status: 200, body: {} });
    await until(() => {
      expect([...open().values()].map((prompt) => prompt.answerIn)).toEqual(['terminal']);
    });
    expect([...open().values()].some((prompt) => prompt.answerIn === 'both')).toBe(false);
  });
});
