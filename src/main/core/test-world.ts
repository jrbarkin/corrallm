import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MAX_MESSAGE_BYTES } from '../../shared/api/limits';
import type { OpName, Reach } from '../../shared/api/surface';
import type { SessionMode } from '../../shared/session';
import type { Connector } from '../sessions/connector';
import { FakeConnector } from '../sessions/fake';
import { createCore } from './core';
import type { Core } from './core';
import { CALLERS, CANVAS, isLead, NO_DESKTOP, OTHER_CANVAS } from './test-registry';
import type { OpFixture, OutOfReach } from './test-registry';

/*
 * The core the registry's generated tests (T3a, T3b) run on: a profile keeping one canvas, as the
 * app would once it was opened and its folder picked, whose agents match the test registry's
 * callers. `lead` (a lead, with `helper` nested inside it), `worker` (with `apprentice` nested
 * inside it), `peer` and `shell` (each linked to the lead and the worker) and `stranger`, linked to
 * nobody. Nothing they are sent ever runs a turn, so what every call reads stays still: `peer` runs
 * an adapter this build lacks, and `shell`'s Terminal won't start; the others are never sent
 * anything. Its message store starts with a message waiting for `peer` from each party that may
 * take one back, and the lead is paused, by you.
 */

/** The messages waiting for `peer` as the core starts, each from a party that may take it back. */
export const SEEDED = {
  you: '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a50',
  lead: '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a51',
  worker: '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a52',
  orchestrator: '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a53',
} as const;

/** Who sent each seeded message: yours is from another outside party, which you may take back. */
const SENDERS = {
  you: 'outside:other',
  lead: 'agent:lead',
  worker: 'agent:worker',
  orchestrator: 'outside:orchestrator',
} as const;

const NODES = [
  { id: 'lead', connection: 'codex.app-server' },
  { id: 'helper', connection: 'codex.app-server', parent: 'lead' },
  { id: 'worker', connection: 'codex.app-server' },
  { id: 'apprentice', connection: 'codex.app-server', parent: 'worker' },
  { id: 'peer', adapter: 'gemini' },
  { id: 'shell', connection: 'codex.terminal' },
  { id: 'stranger', connection: 'codex.app-server' },
];
const LINKS = [
  ['worker', 'peer'],
  ['lead', 'peer'],
  ['worker', 'shell'],
  ['lead', 'shell'],
];

/** A Terminal whose sessions never start: it says why, as a login it can't run on does. */
const REFUSING: Connector<SessionMode> = {
  start: (_spec, host) => {
    host.emit({
      type: 'notice',
      id: crypto.randomUUID(),
      level: 'error',
      text: 'This terminal can’t start here.',
      switchTo: 'codex.app-server',
    });
    return Promise.reject(new Error('This terminal can’t start here.'));
  },
};

/** Starts the core on a profile of its own, keeping the canvas, with its canvas open. */
export async function startWorld(): Promise<{ core: Core; close(): Promise<void> }> {
  const profile = await mkdtemp(path.join(tmpdir(), 'corrallm-world-'));
  const project = path.join(profile, 'project');
  await mkdir(project);
  const file = path.join(profile, 'world.corral');
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: CANVAS,
      nodes: NODES.map(({ id, connection, parent, adapter = 'codex' }, i) => ({
        id,
        kind: 'agent',
        label: `${id.charAt(0).toUpperCase()}${id.slice(1)}`,
        position: { x: 0, y: i * 100 },
        adapter,
        ...(connection === undefined ? {} : { connection }),
        ...(parent === undefined ? {} : { parent }),
      })),
      links: LINKS.map((agents) => ({ agents })),
    }),
  );
  await writeFile(
    path.join(profile, 'canvases.json'),
    JSON.stringify({ version: 2, canvases: { [CANVAS]: { file, project, conversations: {} } } }),
  );
  const log = path.join(profile, 'runs', CANVAS, 'messages.jsonl');
  await mkdir(path.dirname(log), { recursive: true });
  await writeFile(
    log,
    Object.entries(SEEDED)
      .map(([party, id], i) =>
        JSON.stringify({
          seq: i + 1,
          message: {
            id,
            canvas: CANVAS,
            from: SENDERS[party as keyof typeof SENDERS],
            to: 'agent:peer',
            kind: 'text',
            body: 'Waiting',
            state: 'pending',
            at: 1,
          },
        }),
      )
      .join('\n'),
  );
  let clock = 0;
  const core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '1.0.0' },
      check: true,
      distribution: 'local',
      leads: isLead,
      // Each call a second after the last: no token's writes are limited here.
      limitsClock: () => (clock += 1000),
      sessions: {
        connectors: {
          'codex.app-server': new FakeConnector({ adapter: 'codex' }),
          'codex.terminal': REFUSING,
        },
        environment: () => Promise.resolve({}),
      },
    },
    NO_DESKTOP,
  );
  await core.engines.open(CANVAS);
  const paused = await core.call(
    'run.pause',
    { canvas: CANVAS, target: { agent: 'lead' } },
    CALLERS.you,
  );
  if (!paused.ok) throw new Error(paused.error.sentence);
  // Shell's Terminal has refused to start once, so nothing sent it is tried again.
  const tried = await core.call(
    'message',
    { canvas: CANVAS, to: 'shell', body: 'Start' },
    CALLERS.you,
  );
  if (!tried.ok) throw new Error(tried.error.sentence);
  await new Promise<void>((resolve) => {
    const stuck = () =>
      core.engines
        .canvas(CANVAS)
        ?.delivery.stuck()
        .some((one) => one.agent === 'shell');
    const check = () => {
      if (stuck()) resolve();
      else setTimeout(check, 5);
    };
    check();
  });
  return {
    core,
    close: async () => {
      await core.close();
      await rm(profile, { recursive: true, force: true });
    },
  };
}

/** A request id for each fixture that writes, so that a call repeated through another transport dedupes. */
const request = (n: number) => `2c3d4e5f-6071-4829-9bac-1d2e3f4a5b${String(n).padStart(2, '0')}`;

/** A target the lead's team holds (its helper, and its own group), and every outside token reaches. */
const TARGETS = [
  { canvas: CANVAS, target: { agent: 'helper' } },
  { canvas: CANVAS, target: { group: 'lead' } },
];

/** What the generated tests call each of the registry's operations with. */
export const REAL_FIXTURES: Readonly<Record<OpName, OpFixture>> = {
  'app.info': { valid: [{}, undefined], invalid: [{ verbose: true }, 'text', null] },
  'catalog.get': { valid: [{}, undefined], invalid: [{ canvas: CANVAS }, 'text', null] },
  agents: {
    valid: [{ canvas: CANVAS }, {}],
    invalid: [{ canvas: 'nope' }, { canvas: CANVAS, extra: 1 }],
  },
  status: { valid: [{ canvas: CANVAS }], invalid: [{ canvas: CANVAS, after: 'x' }] },
  needs: { valid: [{ canvas: CANVAS }, {}], invalid: [{ canvas: 'nope' }] },
  messages: {
    valid: [
      { canvas: CANVAS },
      { canvas: CANVAS, limit: 1 },
      { canvas: CANVAS, with: 'agent:peer' },
    ],
    invalid: [
      { canvas: CANVAS, limit: 0 },
      { canvas: CANVAS, after: 'not a cursor' },
      { canvas: CANVAS, with: 'nobody' },
    ],
  },
  message: {
    valid: [{ canvas: CANVAS, to: 'peer', body: 'Hello', request: request(1) }],
    by: Object.fromEntries(
      (['you', 'lead', 'worker', 'outside-write'] as const).map((party, i) => [
        party,
        [
          {
            canvas: CANVAS,
            to: 'peer',
            body: 'About that',
            replyTo: SEEDED[party === 'outside-write' ? 'orchestrator' : party],
            request: request(10 + i),
          },
        ],
      ]),
    ),
    fresh: ['id'],
    invalid: [
      { canvas: CANVAS, to: 'peer', body: '' },
      { canvas: CANVAS, to: 'peer', body: 'x'.repeat(MAX_MESSAGE_BYTES + 1) },
      { canvas: CANVAS, to: 'peer' },
    ],
    meetsRule: {
      'shell-text': { canvas: CANVAS, to: 'shell', body: '!ls', request: request(2) },
    },
  },
  withdraw: {
    valid: [],
    by: {
      you: [{ canvas: CANVAS, id: SEEDED.you, request: request(20) }],
      lead: [{ canvas: CANVAS, id: SEEDED.lead, request: request(21) }],
      worker: [{ canvas: CANVAS, id: SEEDED.worker, request: request(22) }],
      'outside-write': [{ canvas: CANVAS, id: SEEDED.orchestrator, request: request(23) }],
    },
    invalid: [{ canvas: CANVAS, id: 'nope' }, { canvas: CANVAS }],
  },
  'session.get': {
    valid: [{ canvas: CANVAS, agent: 'peer' }],
    invalid: [{ canvas: CANVAS }, { canvas: CANVAS, agent: '' }],
  },
  'session.transcript': {
    valid: [
      { canvas: CANVAS, agent: 'peer' },
      { canvas: CANVAS, agent: 'peer', limit: 1 },
    ],
    by: { worker: [{ canvas: CANVAS, agent: 'worker' }] },
    invalid: [
      { canvas: CANVAS, agent: 'peer', limit: 0 },
      { canvas: CANVAS, agent: 'peer', after: '' },
    ],
  },
  'session.interrupt': {
    valid: [{ canvas: CANVAS, agent: 'helper', request: request(30) }],
    invalid: [{ canvas: CANVAS }, { canvas: CANVAS, agent: 'helper', extra: true }],
  },
  'run.pause': {
    valid: TARGETS.map((args, i) => ({ ...args, request: request(40 + i) })),
    invalid: [
      { canvas: CANVAS, target: {} },
      { canvas: CANVAS, target: { agent: '' } },
    ],
  },
  'run.kill': {
    valid: TARGETS.map((args, i) => ({ ...args, request: request(50 + i) })),
    invalid: [{ canvas: CANVAS, target: { agent: 'helper', group: 'lead' } }],
  },
  'run.unpause': {
    // The group first: once its pauses are released, none holds the helper but its own, so every
    // party's release of it says nothing holds it still.
    valid: TARGETS.toReversed().map((args, i) => ({ ...args, request: request(60 + i) })),
    invalid: [{ canvas: CANVAS }],
    // The lead's pause is yours.
    meetsRule: { sticky: { canvas: CANVAS, target: { agent: 'lead' }, request: request(70) } },
  },
  'usage.get': { valid: [{}, undefined], invalid: [{ backend: 'any' }, [], null] },
};

/** The agents each agent doesn't reach on the canvas, as far as an op lets it. */
const AGENTS_OUT_OF_REACH: Readonly<Record<string, Partial<Record<Reach, readonly string[]>>>> = {
  // A lead's write reaches its team; its read, its links too.
  lead: {
    team: ['worker', 'apprentice', 'peer', 'shell', 'stranger'],
    linked: ['worker', 'apprentice', 'stranger'],
  },
  // A worker reaches the agents linked to it, never its own children; or, for its own, itself.
  worker: {
    linked: ['lead', 'helper', 'apprentice', 'stranger'],
    own: ['lead', 'helper', 'apprentice', 'peer', 'shell', 'stranger'],
  },
};

/** The messages each token party doesn't reach: every seeded one it neither sent nor received. */
const MESSAGES_OUT_OF_REACH: Readonly<Record<string, readonly string[]>> = {
  lead: [SEEDED.you, SEEDED.worker, SEEDED.orchestrator],
  worker: [SEEDED.you, SEEDED.lead, SEEDED.orchestrator],
  orchestrator: [SEEDED.you, SEEDED.lead, SEEDED.worker],
  watcher: [SEEDED.you, SEEDED.lead, SEEDED.worker, SEEDED.orchestrator],
};

/** What each token party doesn't reach on the canvas. */
export const REAL_OUT_OF_REACH: OutOfReach = {
  CanvasId: () => [OTHER_CANVAS],
  AgentId: (caller, reach) =>
    caller.kind === 'outside' ? [] : AGENTS_OUT_OF_REACH[caller.agent]?.[reach],
  // A lead's team holds its own group, not the worker's.
  NodeId: (caller, reach) =>
    caller.kind === 'outside'
      ? []
      : caller.agent === 'lead' && reach === 'team'
        ? ['worker']
        : undefined,
  MessageId: (caller) =>
    MESSAGES_OUT_OF_REACH[caller.kind === 'outside' ? caller.name : caller.agent],
};
