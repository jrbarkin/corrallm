import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MAX_LINK_LENGTH } from '../../shared/ipc';
import { MAX_MESSAGE_BYTES } from '../../shared/api/limits';
import type { OpName, Reach } from '../../shared/api/surface';
import type { SessionMode } from '../../shared/session';
import { MAX_FILE_QUERY_LENGTH } from '../../shared/session';
import type { Connector } from '../sessions/connector';
import { FakeConnector } from '../sessions/fake';
import { createCore } from './core';
import type { Core } from './core';
import { cursorOf } from './delivery/messages';
import { keepCanvases, keepMessages } from './store/test-store';
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
 * take one back, and a notice corrallm sent the read-only token's party; and the lead is paused,
 * by you.
 */

/** The messages waiting for `peer` as the core starts, each from a party that may take it back. */
export const SEEDED = {
  you: '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a50',
  lead: '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a51',
  worker: '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a52',
  orchestrator: '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a53',
} as const;

/** The notice corrallm sent the read-only token's party (`watcher`) before the core started. */
export const NOTICE = '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a54';

/** A `wait` cursor at the start of the canvas's messages. */
const START = cursorOf('wait', { [CANVAS]: 0 });

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
  await keepCanvases(profile, { [CANVAS]: { file, project } });
  await keepMessages(profile, CANVAS, [
    ...Object.entries(SEEDED).map(([party, id]) => ({
      message: {
        id,
        from: SENDERS[party as keyof typeof SENDERS],
        to: 'agent:peer' as const,
        kind: 'text' as const,
        body: 'Waiting',
        state: 'pending' as const,
        at: 1,
      },
    })),
    {
      message: {
        id: NOTICE,
        from: 'corrallm' as const,
        to: 'outside:watcher' as const,
        kind: 'notice' as const,
        body: 'Noted',
        state: 'delivered' as const,
        at: 1,
      },
    },
  ]);
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
  // Shell's Terminal has refused to start, so nothing sent it within the next minute (RETRY_AFTER,
  // on the real clock) tries it again: the generated tests finish well within that.
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
  'catalog.installed': { valid: [{}, undefined], invalid: [{ canvas: CANVAS }, 'text', null] },
  'templates.list': {
    valid: [{}, undefined],
    invalid: [{ canvas: CANVAS }, { extra: true }, 'text', null],
  },
  'settings.get': { valid: [{}, undefined], invalid: [{ canvas: CANVAS }, 'text', null] },
  'project.files': {
    valid: [
      { canvas: CANVAS, query: 'ipc' },
      { query: '' },
      { query: 'x'.repeat(MAX_FILE_QUERY_LENGTH) },
    ],
    invalid: [
      {},
      { canvas: CANVAS, query: 42 },
      { canvas: CANVAS, query: 'x'.repeat(MAX_FILE_QUERY_LENGTH + 1) },
      { canvas: CANVAS, query: 'ipc', folder: '/etc' },
      { canvas: 'nope', query: '' },
    ],
  },
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
      you: [
        { canvas: CANVAS, id: SEEDED.you, request: request(20) },
        { id: SEEDED.you, request: request(20) },
      ],
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
  'topics.subscribe': {
    valid: [
      { topic: 'usage', request: request(75) },
      { topic: 'settings', request: request(76) },
    ],
    invalid: [{}, { topic: 'missing' }, { topic: 'usage', window: 2 }],
    fresh: ['epoch'],
  },
  'topics.unsubscribe': {
    valid: [
      { topic: 'usage', request: request(77) },
      { topic: 'settings', request: request(78) },
    ],
    invalid: [{}, { topic: 'missing' }],
  },
  'usage.get': { valid: [{}, undefined], invalid: [{ backend: 'any' }, [], null] },
  'usage.setRule': {
    valid: [
      {
        backend: 'codex',
        rule: { window: 'weekly', percent: 80, action: 'warn' },
        request: request(80),
      },
      { backend: 'codex', rule: null, request: request(81) },
    ],
    invalid: [
      { backend: 'missing', rule: null },
      { backend: 'codex' },
      { backend: 'codex', rule: { window: 'weekly', percent: 100, action: 'ask' } },
      { backend: 'codex', rule: { window: 'weekly', percent: 80, action: 'nextBackend' } },
    ],
  },
  'usage.simulate': {
    valid: [
      {
        backend: 'codex',
        windows: { fiveHour: { usedPercent: 42, resetsAt: null } },
        request: request(90),
      },
      { backend: 'codex', windows: {}, request: request(91) },
      { backend: 'codex', windows: null, request: request(92) },
    ],
    invalid: [
      { backend: 'missing', windows: null },
      { backend: 'codex' },
      { backend: 'codex', windows: { fiveHour: { usedPercent: 101, resetsAt: null } } },
      { backend: 'codex', windows: { weekly: { usedPercent: 50, resetsAt: -1 } } },
      {
        backend: 'codex',
        windows: { weekly: { usedPercent: 50, resetsAt: Date.now() + 30 * 86_400_000 } },
      },
    ],
  },
  // From the start first, which moves each party's read position past all it was sent: a wait
  // with no cursor then answers alike however often it is called.
  'link.open': {
    valid: [{ url: 'https://example.com/a', request: request(93) }],
    invalid: [
      {},
      { url: 1 },
      { url: 'x'.repeat(MAX_LINK_LENGTH + 1) },
      { url: 'https://example.com', window: 8 },
    ],
  },
  'link.reveal': {
    valid: [{ url: 'file:///not-a-project-file', request: request(94) }],
    invalid: [
      {},
      { url: 1 },
      { url: 'x'.repeat(MAX_LINK_LENGTH + 1) },
      { url: 'file:///work/app', canvas: CANVAS },
    ],
  },
  'window.get': {
    valid: [{}],
    invalid: [{ window: 8 }, { c: CANVAS }],
  },
  'terminal.attach': {
    valid: [{ agent: 'shell', request: request(95) }],
    invalid: [{}, { agent: 1 }, { agent: 'shell', canvas: CANVAS }],
  },
  'terminal.detach': {
    valid: [{ agent: 'shell', request: request(96) }],
    invalid: [{}, { agent: 'shell', extra: true }],
  },
  'terminal.input': {
    valid: [{ agent: 'shell', data: '\x1b[Z\x03', request: request(97) }],
    invalid: [{}, { agent: 'shell', data: '' }, { agent: 'shell', data: 1 }],
  },
  'terminal.resize': {
    valid: [{ agent: 'shell', cols: 120, rows: 40, request: request(98) }],
    invalid: [{}, { agent: 'shell', cols: 80.5, rows: 24 }, { agent: 'shell', cols: 80, rows: 0 }],
  },
  'terminal.drop': {
    valid: [
      { agent: 'shell', paths: [path.join(tmpdir(), 'not-a-dropped-file')], request: request(99) },
    ],
    invalid: [{}, { agent: 'shell', paths: [] }, { agent: 'shell', paths: ['relative.png'] }],
  },
  wait: {
    valid: [{ timeoutSeconds: 0, after: START }, { timeoutSeconds: 0 }],
    by: {
      'outside-write': [
        { timeoutSeconds: 0, after: START },
        { timeoutSeconds: 0, for: SEEDED.orchestrator },
      ],
      'outside-read': [
        { timeoutSeconds: 0, after: START },
        { timeoutSeconds: 0, for: NOTICE },
      ],
    },
    invalid: [
      {},
      { timeoutSeconds: -1 },
      { timeoutSeconds: 3601 },
      { timeoutSeconds: 0, after: '' },
      { timeoutSeconds: 0, after: 'not a cursor' },
      { timeoutSeconds: 0, for: 'nope' },
      { timeoutSeconds: 0, canvas: CANVAS },
    ],
  },
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
  lead: [SEEDED.you, SEEDED.worker, SEEDED.orchestrator, NOTICE],
  worker: [SEEDED.you, SEEDED.lead, SEEDED.orchestrator, NOTICE],
  orchestrator: [SEEDED.you, SEEDED.lead, SEEDED.worker, NOTICE],
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
