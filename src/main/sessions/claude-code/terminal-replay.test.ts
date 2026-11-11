import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdapterPrompt, PromptEnded, PromptEvent } from '../../../shared/model/prompts';
import type { SessionEvent } from '../../../shared/session';
import type { LiveSession, SessionSpec } from '../connector';
import { helpFlags } from './claude';
import { TerminalConnector } from './connector';
import { Replay } from './replay';
import type { TerminalFixture } from './replay';

/*
 * Claude Code in corrallm's terminal, as the real Claude Code 2.1.321 behaved (B13 C13): each
 * pseudo-terminal plays a recording (fixtures/terminal-*.jsonl: see replay.ts) back to the
 * session, its output, Program Status reports and hooks in order, waiting wherever keys were sent
 * until the test sends the same keys. What the session raised for the core's prompt owner is read
 * as the owner is told.
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
let runs: Replay[];
let events: SessionEvent[];
let prompts: (PromptEvent | PromptEnded)[];
let sessions: LiveSession[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-claude-replay-'));
  runs = [];
  events = [];
  prompts = [];
  sessions = [];
});
afterEach(async () => {
  await Promise.all(sessions.map((session) => session.close()));
  await rm(dir, { recursive: true, force: true });
});

const SPEC: SessionSpec = {
  agentId: 'a',
  cwd: '/work/smoke/p2',
  env: { PATH: '/usr/bin', HOME: '/home/user' },
  model: null,
  mode: null,
  resume: null,
};

/** Starts a session whose pseudo-terminal plays `name`'s recording. */
async function start(name: TerminalFixture) {
  const connector = new TerminalConnector({
    spawn: (_file, args, options) => {
      const run = new Replay(name, args, options);
      runs.push(run);
      return Promise.resolve(run);
    },
    findClaude: () => Promise.resolve('/home/user/.local/bin/claude'),
    flags: () => Promise.resolve(helpFlags('')),
    tmp: dir,
    home: '/home/user',
    managed: path.join(dir, 'managed'),
    timing: TIMING,
  });
  const session = await connector.start(SPEC, {
    emit: (event) => {
      if (event.type === 'prompt' || event.type === 'prompt-ended') prompts.push(event);
      else events.push(event);
    },
    remember: () => undefined,
  });
  sessions.push(session);
  return session;
}

/** What it raised and has yet to end, by key, in the order raised. */
function open(): Map<string, AdapterPrompt> {
  const live = new Map<string, AdapterPrompt>();
  for (const event of prompts) {
    if (event.type === 'prompt') live.set(event.key, event.prompt);
    else live.delete(event.key);
  }
  return live;
}

const raised = () =>
  prompts
    .filter((event): event is PromptEvent => event.type === 'prompt')
    .map(({ prompt }) => prompt);

/** How each that ended ended, in the order raised: its title and the reason. */
const endings = () =>
  prompts
    .filter((event): event is PromptEnded => event.type === 'prompt-ended')
    .map(({ key, reason }) => {
      const prompt = prompts.find(
        (event): event is PromptEvent => event.type === 'prompt' && event.key === key,
      )?.prompt;
      return `${prompt?.title ?? '?'}:${reason}`;
    });

const until = (check: () => void, timeout = 4000) => vi.waitFor(check, { timeout, interval: 5 });
const pause = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const last = <T extends SessionEvent['type']>(type: T) =>
  events.findLast((event): event is Extract<SessionEvent, { type: T }> => event.type === type);

/** The one prompt open now, which a test expects. */
function onlyOpen(): [string, AdapterPrompt] {
  const live = [...open()];
  expect(live).toHaveLength(1);
  const [one] = live;
  if (one === undefined) throw new Error('nothing open');
  return one;
}

/** Sends the message the recorded turns began with, and waits for the first prompt. */
async function ask(name: TerminalFixture) {
  const session = await start(name);
  await session.send({ id: 'm1', text: 'do the thing' });
  await until(() => {
    expect(open().size).toBe(1);
  });
  return session;
}

describe('what the real Claude Code waits on in its terminal (2.1.321), raised to the core’s prompt owner (B13 C13)', () => {
  it('raises a permission from its PermissionRequest hook before its `blocked` report, and a Notification hook after the report neither replaces nor repeats it', async () => {
    const session = await ask('permission');
    const [key, prompt] = onlyOpen();
    expect(prompt).toEqual({
      kind: 'approval',
      title: 'Claude wants to use Bash',
      summary: 'touch made.txt',
      subject: {
        type: 'tool',
        tool: 'Bash',
        input: { command: 'touch made.txt', description: 'Make a file' },
      },
      answerIn: 'both',
      omitted: true,
      until: expect.any(Number) as number,
      choices: [
        {
          value: 'allow',
          label: 'Yes',
          hint: 'allow_once',
          effects: {},
          endsTurn: false,
          feedback: 'none',
        },
        {
          value: 'deny',
          label: 'No',
          hint: 'reject_once',
          effects: {},
          endsTurn: true,
          feedback: 'none',
        },
        {
          value: 'deny-feedback',
          label: 'No, and tell Claude what to do differently',
          hint: 'reject_once',
          effects: {},
          endsTurn: false,
          feedback: 'required',
        },
      ],
    });
    // Seconds after its report, with the dialog still up: "Claude needs your permission".
    const run = runs[0];
    await until(() => {
      expect(run?.posted).toContain('Notification:permission_prompt');
    });
    await pause();
    expect(raised()).toHaveLength(1);
    expect(onlyOpen()[0]).toBe(key);
    // Answered in the terminal, and the turn goes on to its end.
    session.terminal?.input('1');
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    expect(endings()).toEqual(['Claude wants to use Bash:answered-natively']);
    expect(raised()).toHaveLength(1);
    expect(run?.posted.slice(0, 3)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PermissionRequest:Bash',
    ]);
  });

  it('raises AskUserQuestion’s questions from its hook, once, answered in the terminal', async () => {
    const session = await ask('question');
    expect(onlyOpen()[1]).toEqual({
      kind: 'question',
      title: 'Which color should the header be?',
      answerIn: 'both',
      until: expect.any(Number) as number,
      questions: [
        {
          id: 'q1',
          header: 'Color',
          text: 'Which color should the header be?',
          options: [
            { label: 'Red', description: 'Warm' },
            { label: 'Blue', description: 'Cool' },
          ],
          multiple: false,
          other: true,
        },
      ],
    });
    // Its PreToolUse and PermissionRequest hooks both told it, and its report: one prompt.
    await pause();
    expect(raised()).toHaveLength(1);
    session.terminal?.input('\r');
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    expect(endings()).toEqual(['Which color should the header be?:answered-natively']);
  });

  it('raises ExitPlanMode’s plan from its hooks, without the plan file’s path; keeping planning (Esc) withdraws it as the turn ends', async () => {
    const session = await ask('exit-plan');
    const [, prompt] = onlyOpen();
    expect(prompt).toEqual({
      kind: 'plan',
      title: 'Approve Claude’s plan?',
      plan: '## Plan\nRun `ls`.\n',
      answerIn: 'terminal',
      choices: [],
    });
    expect(JSON.stringify(prompt)).not.toContain('plans/');
    await pause();
    expect(raised()).toHaveLength(1);
    session.terminal?.input('\x1b');
    await until(() => {
      expect(open().size).toBe(0);
    });
    expect(endings()).toEqual(['Approve Claude’s plan?:withdrawn']);
  });

  it('raises two permissions back to back as two prompts, each ended as it is answered', async () => {
    const session = await ask('two-permissions');
    const [first] = onlyOpen();
    expect(onlyOpen()[1]).toMatchObject({ summary: 'touch one.txt' });
    session.terminal?.input('1');
    await until(() => {
      expect(raised()).toHaveLength(2);
    });
    const [second, prompt] = onlyOpen();
    expect(second).not.toBe(first);
    expect(prompt).toMatchObject({ kind: 'approval', summary: 'touch two.txt' });
    session.terminal?.input('1');
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    expect(endings()).toEqual([
      'Claude wants to use Bash:answered-natively',
      'Claude wants to use Bash:answered-natively',
    ]);
    expect(open().size).toBe(0);
  });

  it('raises an MCP server’s form in its report’s words alone: Claude Code ran no hook for it', async () => {
    const session = await ask('elicitation');
    expect(onlyOpen()[1]).toMatchObject({
      kind: 'approval',
      title: 'Claude wants to use mcp__tracker__file_issue',
    });
    session.terminal?.input('1');
    await until(() => {
      expect(raised()).toHaveLength(2);
    });
    // Its `blocked` report says "question" and "MCP input: tracker"; its hooks said nothing of the form.
    expect(onlyOpen()[1]).toEqual({
      kind: 'question',
      title: 'MCP input: tracker',
      answerIn: 'terminal',
      questions: [],
    });
    session.terminal?.input('\x1b');
    await until(() => {
      expect(last('end')).toBeDefined();
    });
    expect(endings()).toEqual([
      'Claude wants to use mcp__tracker__file_issue:answered-natively',
      'MCP input: tracker:answered-natively',
    ]);
    // Its only hook for the form came after the answer.
    expect(runs[0]?.posted).toContain('Notification:elicitation_response');
    expect(runs[0]?.posted.indexOf('Notification:elicitation_response')).toBeGreaterThan(
      runs[0]?.posted.indexOf('PermissionRequest:mcp__tracker__file_issue') ?? 0,
    );
  });
});

describe('the folder trust dialog of the real Claude Code (2.1.321), raised to the core’s prompt owner (B13 C13)', () => {
  const TRUST = 'Claude Code asks whether you trust the project folder.';

  it('is yours to answer there; Yes (Down, Enter) gets past it, and that ends the prompt answered there', async () => {
    const session = await start('trust-yes');
    await until(() => {
      expect(open().size).toBe(1);
    });
    expect(onlyOpen()[1]).toEqual({
      kind: 'approval',
      title: TRUST,
      subject: { type: 'trust' },
      answerIn: 'terminal',
      choices: [],
    });
    // It reported and ran nothing until it was answered.
    expect(runs[0]?.posted).toEqual([]);
    session.terminal?.input('\x1b[B');
    session.terminal?.input('\r');
    await until(() => {
      expect(open().size).toBe(0);
    });
    expect(endings()).toEqual([`${TRUST}:answered-natively`]);
    expect(last('closed')).toBeUndefined();
  });

  it('is withdrawn when "No, exit" (its default, Enter) ends Claude Code with code 1', async () => {
    const session = await start('trust-no');
    await until(() => {
      expect(open().size).toBe(1);
    });
    session.terminal?.input('\r');
    await until(() => {
      expect(last('closed')).toBeDefined();
    });
    expect(last('closed')?.error).toMatch(/exited with code 1/);
    expect(endings()).toEqual([`${TRUST}:withdrawn`]);
  });
});
