import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import type { Message } from '../../shared/model/messages';
import { recordWords } from '../../shared/model/records';
import type { RecordEntryView } from '../../shared/model/records';
import { handoff as fixture } from '../../shared/model/test-b19';
import { isQueueRowMessage, messageView } from '../../shared/model/views';
import type { EntryView } from '../../shared/model/views';
import type { SessionMode, UserMessage } from '../../shared/session';
import type { Connector, SessionHost } from '../sessions/connector';
import { fakeConnector } from '../sessions/test-fake';
import type { Caller, OutsideCaller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { expectRestorable, liveRunOf } from './engine/run/test-restore';
import { mailboxTasks } from './delivery/tasks';
import { keepCanvases } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';
import { legacyDirectories } from './workspaces/test-directories';

/*
 * B19 X4, headless: the journey the window draws from, driven through the core alone with fake
 * sessions (what `serve` runs, with no window): a queue hands a task to another agent, the hand-off
 * is a read-only row for the recipient while it waits and is received, its reply is evidence that
 * runs no turn of the sender, and the sender's OK is answered as you, leaving a record in its
 * window that you read and no token does. Nothing here opens a window, and nothing in it runs a
 * real CLI.
 */

const CANVAS = '5b1d7e3a-9c2f-4d68-8a1b-3e4f5a6b7c8d' as CanvasId;
const YOU = CALLERS.you;
/** An orchestrator outside corrallm holding a write token for the canvas. */
const ORCHESTRATOR: OutsideCaller = {
  kind: 'outside',
  token: 'write-token',
  name: 'orchestrator',
  access: 'write',
  merge: true,
  canvases: [CANVAS],
};

let profile: string;
let file: string;
const cores: Core[] = [];

/** The canvas file: Lead hands a review to Worker and then waits for your OK on it. */
async function canvas(workerQueue: unknown[] = []): Promise<void> {
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: CANVAS,
      nodes: [
        {
          id: 'lead',
          kind: 'agent',
          label: 'Lead',
          adapter: 'codex',
          connection: 'codex.app-server',
          position: { x: 0, y: 0 },
          queue: [
            { id: 'hand', message: 'Review this', target: 'worker' },
            { id: 'sign', approve: 'the review' },
          ],
        },
        {
          id: 'worker',
          kind: 'agent',
          label: 'Worker',
          adapter: 'codex',
          connection: 'codex.app-server',
          position: { x: 200, y: 0 },
          queue: workerQueue,
        },
      ],
      links: [{ agents: ['lead', 'worker'] }],
    }),
  );
}

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-b19-journey-'));
  const project = path.join(profile, 'project');
  await mkdir(project);
  file = path.join(profile, 'team.corral');
  await canvas();
  await keepCanvases(profile, { [CANVAS]: { file, project } });
});

afterEach(async () => {
  // Every run made here restores from its checkpoint, over the same rows, as it was.
  expectRestorable();
  vi.restoreAllMocks();
  for (const core of cores.splice(0)) await core.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
});

/** Sessions whose turns the test ends. */
function sessions() {
  const codex = fakeConnector({ adapter: 'codex' });
  const sent: (UserMessage & { agent: string })[] = [];
  const hosts = new Map<string, SessionHost>();
  const connector: Connector<SessionMode> = {
    start: async (spec, host) => {
      hosts.set(spec.agentId, host);
      const session = await codex.start(spec, host);
      session.send = (message) => {
        sent.push({ ...message, agent: spec.agentId });
        host.emit({ type: 'user', id: message.id, text: message.text });
        host.emit({ type: 'status', status: 'working' });
        return Promise.resolve();
      };
      return session;
    },
  };
  const end = (agent: string, text: string) => {
    const id = sent.findLast((one) => one.agent === agent)?.id;
    if (id === undefined) throw new Error(`Nothing was sent to ${agent}`);
    const host = hosts.get(agent);
    host?.emit({ type: 'text', id: `reply-${id}`, text });
    host?.emit({
      type: 'end',
      messages: [id],
      seconds: 1,
      result: { status: 'completed', reason: 'completed' },
    });
  };
  return { connector, sent, end };
}

async function start(connector: Connector<SessionMode>): Promise<Core> {
  const core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
      sessions: {
        connectors: { 'codex.app-server': connector },
        environment: () => Promise.resolve({}),
        callers: () => true,
      },
      watchFolder: () => ({ close: () => undefined }),
    },
    NO_DESKTOP,
  );
  cores.push(core);
  return core;
}

async function ok<T = unknown>(core: Core, op: string, args: object, caller: Caller = YOU) {
  const result = await core.call(op as never, { canvas: CANVAS, ...args }, caller);
  if (!result.ok) throw new Error(`${op}: ${result.error.code}: ${result.error.sentence}`);
  return result.value as T;
}

/** The canvas's messages as its topic gives them, in order (what a window mirrors). */
async function topicMessages(core: Core, caller: Caller = YOU): Promise<Message[]> {
  const read = await core.topics.read(`messages:${CANVAS}`, caller);
  if (!read.ok) throw new Error(read.error.sentence);
  const { items, order } = read.value as { items: Record<string, Message>; order: string[] };
  return order.flatMap((id) => items[id] ?? []);
}

async function transcript(core: Core, agent: string, caller: Caller = YOU) {
  const page = await ok<{ entries: EntryView[] }>(
    core,
    'session.transcript',
    { agent, limit: 100 },
    caller,
  );
  return page.entries;
}

describe('a queue hand-off and its sender’s OK, as the window reads them (B19 X4)', () => {
  it('is a read-only row for its recipient, runs no turn of its sender, and leaves your answer as a record only you read', async () => {
    const { connector, sent, end } = sessions();
    const core = await start(connector);
    const engine = await core.engines.open(CANVAS);
    const store = await core.engines.messagesOf(CANVAS);
    liveRunOf(engine.run, engine.catalog, () => Date.now(), mailboxTasks(store));
    engine.run.update(core.engines.canvas(CANVAS)?.document.nodes ?? []);

    engine.run.start();
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });

    // The topic gives the window the hand-off as the fixtures draw it: the run's, for the worker.
    const [offered] = (await topicMessages(core)).filter(
      (message) => message.purpose?.type === 'handoff',
    );
    if (offered === undefined) throw new Error('No hand-off');
    const view = messageView(offered, 'run');
    expect(view).toMatchObject({
      ...fixture('lead', 'worker', { id: offered.id, item: 'hand' }),
      canvas: CANVAS,
      at: expect.any(Number) as number,
      task: { agent: 'lead', item: 'hand', attempt: expect.any(String) as string },
      state: expect.stringMatching(/^(delivering|delivered)$/) as string,
    });
    expect(isQueueRowMessage(view)).toBe(true);
    // A token that is neither party reads neither the hand-off nor, later, its evidence.
    expect((await topicMessages(core, ORCHESTRATOR)).map(({ id }) => id)).not.toContain(offered.id);

    // The worker's reply is the lead's evidence: the lead is sent no turn of it, and reads its OK.
    end('worker', 'Looks right.\nAPPROVED');
    const hold = await vi.waitFor(
      async () => {
        const needs = await ok<{ items: { id: string; kind: string; agent?: string }[] }>(
          core,
          'needs',
          {},
        );
        const found = needs.items.find((item) => item.kind === 'hold' && item.agent === 'lead');
        expect(found).toBeDefined();
        return found;
      },
      { timeout: 10_000, interval: 10 },
    );
    expect(sent.map(({ agent }) => agent)).toEqual(['worker']);
    const messages = await topicMessages(core);
    const evidence = messages.filter((message) => message.purpose?.type === 'evidence');
    expect(evidence).toEqual([
      expect.objectContaining({ from: 'agent:worker', to: 'agent:lead', replyTo: offered.id }),
    ]);
    const [ended] = evidence;
    if (ended === undefined) throw new Error('No evidence');
    expect(isQueueRowMessage(messageView(ended, 'run'))).toBe(false);
    expect(messages.find(({ id }) => id === offered.id)?.state).toBe('replied');

    // Before you answer, the lead's window holds no record; after, one, in the core's words.
    expect((await transcript(core, 'lead')).some(({ kind }) => kind === 'record')).toBe(false);
    const answered = await ok<{ id: string }>(core, 'reply', {
      to: hold?.id,
      answer: { choice: 'approve' },
    });
    const records = (await transcript(core, 'lead')).filter(
      (entry): entry is RecordEntryView => entry.kind === 'record',
    );
    expect(records).toEqual([
      expect.objectContaining({
        id: `record/${answered.id}`,
        by: 'you',
        state: 'settled',
        record: { type: 'hold', choice: 'approve' },
      }),
    ]);
    const [settled] = records;
    if (settled === undefined) throw new Error('No record');
    expect(recordWords(settled, (party) => party)).toBe('Approved by you.');
    // The worker's window has none of the lead's, and a token reads none of anyone's.
    expect((await transcript(core, 'worker')).some(({ kind }) => kind === 'record')).toBe(false);
    for (const agent of ['lead', 'worker'])
      expect(
        (await transcript(core, agent, ORCHESTRATOR)).some(({ kind }) => kind === 'record'),
      ).toBe(false);
    await vi.waitFor(() => {
      expect(engine.run.snapshot().agents.lead?.status).toBe('done');
    });
    // The lead was never sent a turn: its work was the hand-off and its OK.
    expect(sent.map(({ agent }) => agent)).toEqual(['worker']);
  });

  it('waits while its recipient stands at an OK of its own, and goes once you answer it', async () => {
    await canvas([{ id: 'gate', approve: 'the gate' }]);
    const { connector, sent } = sessions();
    const core = await start(connector);
    const engine = await core.engines.open(CANVAS);
    const store = await core.engines.messagesOf(CANVAS);
    liveRunOf(engine.run, engine.catalog, () => Date.now(), mailboxTasks(store));
    engine.run.update(core.engines.canvas(CANVAS)?.document.nodes ?? []);
    engine.run.start();

    // The worker's OK holds it: pending, from the lead, sent to no one.
    const gate = await vi.waitFor(
      async () => {
        const needs = await ok<{ items: { id: string; kind: string; agent?: string }[] }>(
          core,
          'needs',
          {},
        );
        const found = needs.items.find((item) => item.kind === 'hold' && item.agent === 'worker');
        expect(found).toBeDefined();
        return found;
      },
      { timeout: 10_000, interval: 10 },
    );
    const waiting = (await topicMessages(core)).filter((one) => one.purpose?.type === 'handoff');
    expect(waiting).toEqual([expect.objectContaining({ state: 'pending', from: 'agent:lead' })]);
    expect(sent).toEqual([]);

    await ok(core, 'reply', { to: gate?.id, answer: { choice: 'approve' } });
    await vi.waitFor(() => {
      expect(sent.map(({ agent }) => agent)).toEqual(['worker']);
    });
    expect(sent[0]?.text).toContain('Review this');
  });
});
