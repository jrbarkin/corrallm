import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { SessionMode, UserMessage } from '../../shared/session';
import type { Connector, SessionHost } from '../sessions/connector';
import { fakeConnector } from '../sessions/test-fake';
import { createCore } from './core';
import type { Core } from './core';
import { Delivery } from './delivery/delivery';
import { MessageStore } from './delivery/messages';
import { mailboxTasks } from './delivery/tasks';
import { expectRestorable, liveRunOf } from './engine/run/test-restore';
import { keepCanvases } from './store/test-store';
import { CANVAS, NO_DESKTOP } from './test-registry';
import { legacyDirectories } from './workspaces/test-directories';

/*
 * G2: a reply streams word by word, each word a change to its agent's session, and under load many
 * arrive in one turn of the core's event loop. A word changes nothing delivery or Needs reads (the
 * session's status, its queue, its user messages, its mode), so none makes delivery look again at
 * every message it acts on, nor Needs at what waits for you.
 */

let profile: string;
const cores: Core[] = [];

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-streaming-'));
});

afterEach(async () => {
  expectRestorable();
  vi.restoreAllMocks();
  for (const core of cores.splice(0)) await core.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
});

/** A profile keeping a canvas of Worker and Helper, on Codex's App Server. */
async function keepCanvas(): Promise<void> {
  const project = path.join(profile, 'project');
  await mkdir(project);
  const file = path.join(profile, 'canvas.corral');
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: CANVAS,
      nodes: ['worker', 'helper'].map((id, i) => ({
        id,
        kind: 'agent',
        label: id.charAt(0).toUpperCase() + id.slice(1),
        position: { x: 0, y: i * 100 },
        adapter: 'codex',
        connection: 'codex.app-server',
      })),
      links: [],
    }),
  );
  await keepCanvases(profile, { [CANVAS]: { file, project } });
}

/** A connector whose turns the test plays: what each agent's sessions were sent, and their hosts. */
function driven() {
  const fake = fakeConnector({ adapter: 'codex', mode: 'auto' });
  const to = new Map<string, { host: SessionHost; sent: UserMessage[] }>();
  const connector: Connector<SessionMode> = {
    start: async (spec, given) => {
      const mine = { host: given, sent: to.get(spec.agentId)?.sent ?? [] };
      to.set(spec.agentId, mine);
      const session = await fake.start(spec, given);
      session.send = (message) => {
        mine.sent.push(message);
        given.emit({ type: 'user', id: message.id, text: message.text });
        given.emit({ type: 'status', status: 'working' });
        return Promise.resolve();
      };
      return session;
    },
  };
  return { connector, of: (agent: string) => to.get(agent) };
}

async function start(connector: Connector<SessionMode>): Promise<Core> {
  const core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      // As `serve` runs it: no OS notifications, whose own timers read what waits for you.
      notifications: false,
      directoryResolver: legacyDirectories,
      locale: 'en-GB',
      sessions: {
        connectors: { 'codex.app-server': connector },
        environment: () => Promise.resolve({}),
      },
      watchFolder: () => ({ close: () => undefined }),
    },
    NO_DESKTOP,
  );
  cores.push(core);
  // As `serve` does: what newly waits for an answer is told as it comes.
  core.watch({ need: () => undefined });
  const engine = await core.engines.open(CANVAS);
  const open = core.engines.canvas(CANVAS);
  if (open === undefined) throw new Error('No open canvas.');
  liveRunOf(engine.run, engine.catalog, () => Date.now(), mailboxTasks(open.messages));
  engine.run.update(open.document.nodes);
  return core;
}

/** Lets what a session event started run to its end, as the next I/O callback would. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Lets what a session event started run to its end before any timer or other I/O of the core's
 * (a presence count, a journal write) may: microtasks alone, as one I/O callback's end runs them.
 */
async function drained(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

it('looks at no message delivery acts on, and at nothing waiting for you, for a streamed word', async () => {
  await keepCanvas();
  const { connector, of } = driven();
  const core = await start(connector);
  const open = core.engines.canvas(CANVAS);
  if (open === undefined) throw new Error('No open canvas.');
  // Worker's turn goes on; forty messages wait behind it.
  const first = await open.delivery.send('outside:orchestrator', 'worker', 'Work');
  await vi.waitFor(() => {
    expect(of('worker')?.sent.map(({ text }) => text.split('\n').at(-1))).toEqual(['Work']);
  });
  for (let i = 0; i < 40; i++)
    await open.delivery.send(`outside:party-${String(i % 4)}`, 'worker', `More ${String(i)}`);
  const host = of('worker')?.host;
  if (host === undefined) throw new Error('Worker never started.');
  const reply = randomUUID();
  host.emit({ type: 'text', id: reply, text: 'Working' });
  await settled();

  const walks = vi.spyOn(MessageStore.prototype, 'active');
  const looks = vi.spyOn(Delivery.prototype, 'unasking');
  for (let word = 0; word < 50; word++) {
    host.emit({ type: 'text', id: reply, text: ` word${String(word)}` });
    // Each word's own callback ends, its microtasks (a check, a Needs look) run.
    await drained();
    expect(open.engine.sessions.of('worker').entries.find(({ id }) => id === reply)).toMatchObject({
      text: expect.stringMatching(new RegExp(` word${String(word)}$`)) as unknown,
    });
  }
  // The reply holds every word, and nothing was looked at again for any of them.
  expect({ walks: walks.mock.calls.length, looks: looks.mock.calls.length }).toEqual({
    walks: 0,
    looks: 0,
  });

  // Its turn's end is looked at as ever: the next message goes.
  walks.mockRestore();
  looks.mockRestore();
  const turn = of('worker')?.sent.at(-1)?.id ?? '';
  host.emit({
    type: 'end',
    messages: [turn],
    seconds: 1,
    result: { status: 'completed', reason: 'completed' },
  });
  await vi.waitFor(() => {
    expect(open.messages.get(first.id)?.state).toBe('replied');
  });
  await vi.waitFor(() => {
    expect(of('worker')?.sent.map(({ text }) => text.split('\n').at(-1))).toEqual([
      'Work',
      'More 0',
    ]);
  });
});
