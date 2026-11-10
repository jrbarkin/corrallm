import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpResult } from '../../shared/api/errors';
import type { LeadGrants } from '../../shared/api/ops/leads';
import { isLeadCopy, isLeadNotice } from '../../shared/model/messages';
import type { Message } from '../../shared/model/messages';
import type { NeedsItem } from '../../shared/model/needs';
import type { PromptAnswer } from '../../shared/model/prompts';
import type { SessionMode, TurnResult, UserMessage } from '../../shared/session';
import type { Connector, SessionHost } from '../sessions/connector';
import type { AgentCaller, Caller, OutsideCaller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { mailboxTasks } from './delivery/tasks';
import { expectRestorable, liveRunOf } from './engine/run/test-restore';
import { keepCanvases } from './store/test-store';
import { CALLERS, CANVAS, NO_DESKTOP } from './test-registry';
import { legacyDirectories } from './workspaces/test-directories';

/*
 * B24's lead journey through the whole core, over fake sessions: a worker's prompt that carries no
 * `requiresUser` mark is routed to the lead above it; the lead is sent one host-built copy
 * (delivery's lane, before party traffic, held by a pause), answers with `reply`, and its answer
 * reaches the worker's CLI. Its turn's end makes no reply message, and a lead that answered or
 * handed back is sent no notice. A commit that moves the worker off the team takes the route from
 * the old lead at once.
 */

const YOU = CALLERS.you;
const OUTSIDE = CALLERS['outside-write'] as OutsideCaller;
const agentCaller = (agent: string): AgentCaller => ({
  kind: 'agent',
  canvas: CANVAS,
  agent,
  generation: 1,
  session: `${agent}-session`,
});
const LEAD = agentCaller('lead');
const GRANTS: LeadGrants = { questions: true, plans: true, approvals: true };
const COMPLETED: TurnResult = { status: 'completed', reason: 'completed' };
/** A prompt with no `signals` mark: the lead may answer it (the shared fakes are all human-only). */
const approval = {
  kind: 'approval',
  title: 'Run the cleanup?',
  subject: { type: 'command', command: 'rm -rf build', cwd: '/work/app' },
  answerIn: 'api',
  choices: [
    { value: 'yes', label: 'Yes', hint: 'allow_once', effects: {} },
    { value: 'no', label: 'No', hint: 'reject_once', effects: {} },
  ],
};

let profile: string;
let core: Core;
/** Each agent's latest session host and everything it was sent, and the prompts answered. */
let hosts: Map<string, SessionHost>;
let sent: Map<string, UserMessage[]>;
let answered: [string, PromptAnswer][];

function sentTo(agent: string): UserMessage[] {
  return sent.get(agent) ?? [];
}

/** A connector whose turns the test ends. */
function driven(): Connector<SessionMode> {
  return {
    start: (spec, given) => {
      hosts.set(spec.agentId, given);
      given.emit({
        type: 'started',
        role: 'append',
        resume: true,
        list: true,
        model: null,
        mode: 'acceptEdits',
        models: [],
      });
      return Promise.resolve({
        send: (message) => {
          sent.set(spec.agentId, [...sentTo(spec.agentId), message]);
          given.emit({ type: 'user', id: message.id, text: message.text });
          given.emit({ type: 'status', status: 'working' });
          return Promise.resolve();
        },
        answer: () => Promise.resolve(),
        interrupt: () => Promise.resolve(),
        close: () => Promise.resolve(),
        setMode: () => Promise.resolve(),
        setModel: () => Promise.resolve(),
        prompts: {
          answer: (key, answer) => {
            answered.push([key, answer]);
          },
          decline: () => undefined,
        },
      });
    },
  };
}

/** Ends the turn of the last thing sent `agent`, having said `text`. */
function endTurn(agent: string, text: string): void {
  const last = sentTo(agent).at(-1);
  const host = hosts.get(agent);
  if (last === undefined || host === undefined) throw new Error(`Nothing was sent ${agent}.`);
  host.emit({ type: 'text', id: randomUUID(), text });
  host.emit({ type: 'end', messages: [last.id], seconds: 1, result: COMPLETED });
}

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-lead-journey-'));
  hosts = new Map();
  sent = new Map();
  answered = [];
  const project = path.join(profile, 'project');
  await mkdir(project);
  const file = path.join(profile, 'canvas.corral');
  const node = (id: string, label: string, y: number, parent?: string) => ({
    id,
    kind: 'agent',
    label,
    ...(parent === undefined ? {} : { parent }),
    position: { x: 0, y },
    adapter: 'claude-code',
    connection: 'claude-code.sdk',
  });
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 3,
      id: CANVAS,
      nodes: [node('lead', 'Lead', 0), node('worker', 'Worker', 200, 'lead')],
      links: [],
    }),
  );
  await keepCanvases(profile, { [CANVAS]: { file, project } });
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
      sessions: {
        // Its agent callers are made up: no session authority issued them.
        callers: () => true,
        connectors: { 'claude-code.sdk': driven() },
        environment: () => Promise.resolve({}),
      },
      watchFolder: () => ({ close: () => undefined }),
    },
    NO_DESKTOP,
  );
  const engine = await core.engines.open(CANVAS);
  const open = core.engines.canvas(CANVAS);
  if (open === undefined) throw new Error('No open canvas.');
  liveRunOf(engine.run, engine.catalog, () => Date.now(), mailboxTasks(open.messages));
  engine.run.update(open.document.nodes);
  await ok('agent.setLead', { agent: 'lead', lead: { grants: GRANTS } });
});

afterEach(async () => {
  expectRestorable();
  vi.restoreAllMocks();
  await core.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>, caller: Caller = YOU) {
  return (await core.call(name as never, { canvas: CANVAS, ...args }, caller)) as OpResult<unknown>;
}

async function ok<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
  caller: Caller = YOU,
): Promise<T> {
  const result = await call(name, args, caller);
  if (!result.ok) throw new Error(`${name} failed: ${JSON.stringify(result)}`);
  return result.value as T;
}

const messages = (): readonly Message[] => core.engines.canvas(CANVAS)?.messages.all() ?? [];
const copies = () => messages().filter((one) => isLeadCopy(one));
const notices = () => messages().filter((one) => isLeadNotice(one));
const toCorrallm = () => messages().filter((one) => one.to === 'corrallm');

/** Has the worker ask, and returns the key its session raised and the Need that waits. */
async function workerAsks(): Promise<{ key: string; need: string }> {
  await ok('message', { to: 'worker', body: 'Clean up' });
  await vi.waitFor(() => {
    expect(hosts.get('worker')).toBeDefined();
  });
  await vi.waitFor(() => {
    expect(sentTo('worker')).toHaveLength(1);
  });
  const key = randomUUID();
  hosts.get('worker')?.emit({ type: 'prompt', key, prompt: approval as never });
  let item: NeedsItem | undefined;
  await vi.waitFor(async () => {
    item = (await ok<{ items: NeedsItem[] }>('needs', {})).items.find(
      ({ agent }) => agent === 'worker',
    );
    expect(item).toBeDefined();
  });
  return { key, need: item?.id ?? '' };
}

describe('a team’s prompt, from the worker to its lead and back', () => {
  it('sends the lead one copy, takes its reply to the worker’s CLI, and makes no reply or notice', async () => {
    const { key, need } = await workerAsks();
    await vi.waitFor(() => {
      expect(sentTo('lead')).toHaveLength(1);
    });
    expect(sentTo('lead')[0]?.text).toContain(need);
    expect(copies()).toHaveLength(1);
    // The lead answers as itself, within its allowance.
    await ok('reply', { to: need, answer: { choice: 'yes' } }, LEAD);
    await vi.waitFor(() => {
      expect(answered).toEqual([[key, { kind: 'choice', value: 'yes' }]]);
    });
    // Its turn ends with words of its own.
    endTurn('lead', 'I allowed it.');
    await vi.waitFor(() => {
      expect(copies()[0]?.state).toBe('replied');
    });
    // Nothing is owed to corrallm for a copy, and the lead that answered is told nothing more.
    expect(toCorrallm()).toEqual([]);
    expect(notices()).toEqual([]);
    expect(messages().filter((one) => one.from === 'agent:lead')).toEqual([]);
    // And no second copy follows.
    expect(sentTo('lead')).toHaveLength(1);
  });

  it('sends no notice to a lead that handed back, and none of its turn is a reply', async () => {
    const { need } = await workerAsks();
    await vi.waitFor(() => {
      expect(sentTo('lead')).toHaveLength(1);
    });
    await ok('reply', { to: need, answer: { choice: 'hand-back' } }, LEAD);
    endTurn('lead', 'Handed it back.');
    await vi.waitFor(() => {
      expect(copies()[0]?.state).toBe('replied');
    });
    expect(notices()).toEqual([]);
    expect(toCorrallm()).toEqual([]);
    expect(answered).toEqual([]);
  });

  it('notices the lead once, and makes no reply to the notice, when you answer first', async () => {
    const { key, need } = await workerAsks();
    await vi.waitFor(() => {
      expect(sentTo('lead')).toHaveLength(1);
    });
    endTurn('lead', 'Looking.');
    await vi.waitFor(() => {
      expect(copies()[0]?.state).toBe('replied');
    });
    await ok('reply', { to: need, answer: { choice: 'no' } });
    await vi.waitFor(() => {
      expect(sentTo('lead')).toHaveLength(2);
    });
    expect(sentTo('lead')[1]?.text).toContain('the user answered it');
    expect(notices()).toHaveLength(1);
    expect(answered).toEqual([[key, { kind: 'choice', value: 'no' }]]);
    endTurn('lead', 'Understood.');
    await vi.waitFor(() => {
      expect(notices()[0]?.state).toBe('replied');
    });
    expect(toCorrallm()).toEqual([]);
  });

  it('holds the copy while the lead is paused, then sends it before party traffic that came first', async () => {
    await ok('run.pause', { target: { agent: 'lead' } });
    await ok('message', { to: 'lead', body: 'Plain note from an outside party' }, OUTSIDE);
    const { need } = await workerAsks();
    await vi.waitFor(() => {
      expect(copies()).toHaveLength(1);
    });
    expect(sentTo('lead')).toEqual([]);
    await ok('run.unpause', { target: { agent: 'lead' } });
    await vi.waitFor(() => {
      expect(sentTo('lead')).toHaveLength(1);
    });
    // The copy goes first (lane 1), though the party's message was recorded before it.
    expect(sentTo('lead')[0]?.text).toContain(need);
    expect(sentTo('lead')[0]?.text).not.toContain('Plain note');
  });

  it('withdraws a copy unsent when its route moves before it is delivered', async () => {
    await ok('run.pause', { target: { agent: 'lead' } });
    const { key } = await workerAsks();
    await vi.waitFor(() => {
      expect(copies()).toHaveLength(1);
    });
    // You take the lead's grants away: the route goes to you alone.
    await ok('agent.setLead', { agent: 'lead', lead: null });
    await ok('run.unpause', { target: { agent: 'lead' } });
    await vi.waitFor(() => {
      expect(copies()[0]?.state).toBe('withdrawn');
    });
    expect(sentTo('lead')).toEqual([]);
    expect(notices()).toEqual([]);
    expect(answered).toEqual([]);
    expect(key).toBeDefined();
  });
});

describe('a commit that moves the worker off its lead’s team', () => {
  it('takes the prompt from the old lead at once, whose reply is then refused', async () => {
    const { need } = await workerAsks();
    await vi.waitFor(() => {
      expect(sentTo('lead')).toHaveLength(1);
    });
    const before = (await ok<{ items: NeedsItem[] }>('needs', {})).items.find(
      ({ id }) => id === need,
    );
    expect(before?.routed).toMatchObject({ to: 'agent:lead' });
    await ok('canvas.ungroup', { nodes: ['worker'] });
    await vi.waitFor(async () => {
      const item = (await ok<{ items: NeedsItem[] }>('needs', {})).items.find(
        ({ id }) => id === need,
      );
      expect(item?.routed).toBeUndefined();
    });
    const refused = await call('reply', { to: need, answer: { choice: 'yes' } }, LEAD);
    expect(refused.ok).toBe(false);
    expect(answered).toEqual([]);
    // The lead that lost it is told it no longer waits, once.
    await vi.waitFor(() => {
      expect(notices()).toHaveLength(1);
    });
  });
});
