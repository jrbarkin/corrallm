import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MAX_LINK_LENGTH } from '../../shared/ipc';
import {
  MAX_BATCH_OPS,
  MAX_CREATED_AGENTS,
  MAX_LABEL,
  MAX_MESSAGE_BYTES,
  MAX_OP_NODES,
} from '../../shared/api/limits';
import type { OpName, Reach, Rule } from '../../shared/api/surface';
import type { CanvasId } from '../../shared/canvas';
import { itemKey, linkKey, nodeKey } from '../../shared/model/rows';
import type { SessionMode } from '../../shared/session';
import { MAX_FILE_QUERY_LENGTH, MAX_ROLE_LENGTH } from '../../shared/session';
import type { Connector } from '../sessions/connector';
import { FakeConnector } from '../sessions/fake';
import type { OutsideCaller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { cursorOf } from './delivery/messages';
import { keepCanvases, keepMessages } from './store/test-store';
import { GitRunner } from './workspaces/git';
import { Provisioner } from './workspaces/provision';
import { WorkspaceSetups } from './workspaces/setup';
import { WorkspaceStore } from './workspaces/store';
import { git, gitEnvironment } from './workspaces/test-git';
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
 * by you. The lead's team also holds what calls meeting the change rules change, as you apply them
 * once every token was refused: `deputy` (linked to the lead and the helper) with `aide` nested
 * inside it, the frame `frame-team` holding `member`, `gate`, whose queue holds an OK, OKs at the
 * end of the helper's queue, `unlink-you` (linked to the helper, for you to unlink), and empty
 * frames; and what tokens' deletes propose to remove (`doomed`, `doomed-batch`), with two
 * proposals waiting for you as the tests begin (PROPOSED, the outside write token's deletes of
 * `condemned-a` and `condemned-b`, which the worker is linked to).
 * While a call meets R11 (`meeting`), every token's party is at its cap.
 *
 * Beside it, the profile keeps canvases a canvas's lifetime acts on (FILED), none of them open:
 * `closing`, which you close; `replaced`, which your canvas.create replaces; `discard-close` and
 * `discard-replace`, each with edits not saved, which a token's close or replace with discard
 * proposes and yours discards; and `shrunk`, whose document no longer has an agent its file has,
 * which a token's save proposes and yours saves. Only you reach them, but while a call meets R4
 * (`meeting`), the outside write token is granted them too.
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

/**
 * The proposals waiting for you as the generated tests begin: the outside write token's deletes of
 * `condemned-a` (which you refuse) and `condemned-b` (which tokens may not answer, and you allow).
 */
export const PROPOSED = {
  refused: 'proposal/1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a60',
  allowed: 'proposal/1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a61',
} as const;

/** The canvases kept beside the world's own, by what a canvas's lifetime does to them. */
export const FILED = {
  closing: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01',
  replaced: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b02',
  'discard-close': '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b03',
  'discard-replace': '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b04',
  shrunk: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b05',
} as const satisfies Record<string, string>;

/** A shipped template, with three open agents and a blank: Spec first. */
export const TEMPLATE = 'fb9ce84a-7237-4271-b494-933cb4d5f274';

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
  { id: 'deputy', connection: 'codex.app-server', parent: 'lead' },
  { id: 'aide', connection: 'codex.app-server', parent: 'deputy' },
  { id: 'member', connection: 'codex.app-server', parent: 'frame-team' },
  { id: 'gate', connection: 'codex.app-server', parent: 'lead' },
  { id: 'worker', connection: 'codex.app-server' },
  { id: 'apprentice', connection: 'codex.app-server', parent: 'worker' },
  { id: 'peer', adapter: 'gemini' },
  { id: 'shell', connection: 'codex.terminal' },
  { id: 'stranger', connection: 'codex.app-server' },
  // What tokens' deletes propose to remove, each once: alone, in a batch, and the two proposals
  // waiting as the tests begin.
  ...['doomed', 'doomed-batch', 'condemned-a', 'condemned-b'].map((id) => ({
    id,
    connection: 'codex.app-server',
    parent: 'lead',
  })),
  // What you unlink from the helper (canvas.unlink).
  { id: 'unlink-you', connection: 'codex.app-server', parent: 'lead' },
];
const HELPER_QUEUE = [
  { id: 'text', message: 'Original' },
  { id: 'step', action: 'exec_command', instruction: 'Work' },
  {
    id: 'loop',
    repeat: [{ id: 'inner', message: 'Inner' }],
    until: { kind: 'succeeded' },
    rounds: 3,
    otherwise: 'ask',
  },
  ...['you', 'lead', 'outside-write'].map((party) => ({
    id: `remove-${party}`,
    message: 'Remove me',
  })),
  ...['remove', 'move', 'update', 'batch'].map((what) => ({
    id: `ok-${what}`,
    approve: `The ${what}`,
  })),
];
const LINKS = [
  ['helper', 'unlink-you'],
  ['worker', 'peer'],
  ['lead', 'peer'],
  ['worker', 'shell'],
  ['lead', 'shell'],
  ['lead', 'deputy'],
  ['helper', 'deputy'],
  // The worker reaches what the waiting proposals would delete, so it may try to answer them.
  ['worker', 'condemned-a'],
  ['worker', 'condemned-b'],
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
export async function startWorld(): Promise<{
  core: Core;
  /** The profile folder it keeps its stores in. */
  profile: string;
  /**
   * Readies the world for a call meeting `rule`, before it is made: what undoes that, after. R11's
   * cap is then none, so that a call meets it whatever its party created before; R4's canvases
   * (FILED) are the outside write token's too.
   */
  meeting(rule: Rule): () => void;
  close(): Promise<void>;
}> {
  const profile = await mkdtemp(path.join(tmpdir(), 'corrallm-world-'));
  const project = path.join(profile, 'project');
  await mkdir(project);
  // A repository with one commit and no files, so its worktrees' setup command can be kept for it.
  const env = gitEnvironment(path.join(profile, 'home'));
  git(project, env, 'init', '-q', '-b', 'main');
  git(
    project,
    env,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'first',
  );
  const file = path.join(profile, 'world.corral');
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: CANVAS,
      nodes: [
        ...NODES.map(({ id, connection, parent, adapter = 'codex' }, i) => ({
          id,
          kind: 'agent',
          label: `${id.charAt(0).toUpperCase()}${id.slice(1)}`,
          position: { x: 0, y: i * 100 },
          adapter,
          ...(id === 'helper'
            ? { queue: HELPER_QUEUE }
            : id === 'stranger'
              ? { queue: [{ id: 'stranger-item', message: 'Private' }] }
              : id === 'gate'
                ? { queue: [{ id: 'gate-ok', approve: 'Check' }] }
                : {}),
          ...(connection === undefined ? {} : { connection }),
          ...(parent === undefined ? {} : { parent }),
        })),
        // Separate empty frames let each party add a parent once. Their ids stay in reach after
        // conversion, so transport retries can still resolve them before request deduplication.
        ...['you', 'lead', 'outside-write', 'delete', 'team', 'cap', 'spare'].map((party, i) => ({
          id: `frame-${party}`,
          kind: 'group',
          label: 'Frame',
          parent: 'lead',
          position: { x: 600, y: 100 + i * 100 },
        })),
      ],
      links: LINKS.map((agents) => ({ agents })),
    }),
  );
  const filed: Record<string, { file: string }> = {};
  for (const [name, id] of Object.entries(FILED)) {
    const at = path.join(profile, `${name}.corral`);
    await writeFile(
      at,
      JSON.stringify({
        format: 'corrallm',
        version: 2,
        id,
        nodes: ['solo', 'gone'].map((agent, i) => ({
          id: agent,
          kind: 'agent',
          label: agent,
          position: { x: i * 400, y: 0 },
          adapter: 'codex',
          connection: 'codex.app-server',
        })),
        links: [],
      }),
    );
    filed[id] = { file: at };
  }
  await keepCanvases(profile, { ...filed, [CANVAS]: { file, project } });
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
  let cap = MAX_CREATED_AGENTS;
  const proposals = Object.values(PROPOSED).map((id) => id.slice('proposal/'.length));
  const core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '1.0.0' },
      check: true,
      distribution: 'local',
      leads: isLead,
      // Each call a second after the last: no token's writes are limited here.
      limitsClock: () => (clock += 1000),
      maxCreatedAgents: () => cap,
      proposalIds: () => proposals.shift() ?? crypto.randomUUID(),
      sessions: {
        connectors: {
          'codex.app-server': new FakeConnector({ adapter: 'codex' }),
          'codex.terminal': REFUSING,
        },
        environment: () => Promise.resolve({}),
      },
      // The worktrees' setup, as B9a X11b is to compose it: nothing provisions a worktree here.
      setups: ({ store, processes, directories, profile: at, changed }) => {
        const workspaces = new WorkspaceStore({ store });
        const runner = new GitRunner({
          environment: () => Promise.resolve(env),
          processes,
          hooks: path.join(at, 'workspaces', 'hooks'),
        });
        return new WorkspaceSetups({
          workspaces,
          provisioner: new Provisioner({ workspaces, git: runner, profile: WORLD_PROFILE }),
          git: runner,
          directories,
          processes,
          environment: () => Promise.resolve(env),
          folder: path.join(at, 'workspaces', 'setup'),
          profile: at,
          changed,
        });
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
  for (const [doomed, id] of [
    ['condemned-a', PROPOSED.refused],
    ['condemned-b', PROPOSED.allowed],
  ] as const) {
    const proposed = await core.call(
      'canvas.delete',
      { canvas: CANVAS, nodes: [doomed] },
      CALLERS['outside-write'],
    );
    if (!proposed.ok || !('proposed' in proposed.value) || proposed.value.proposed !== id) {
      throw new Error(`Not proposed as ${id}: ${JSON.stringify(proposed)}`);
    }
  }
  // Edits not saved, by you: a rename, and an agent its file has deleted.
  for (const [canvas, edit, args] of [
    [FILED['discard-close'], 'canvas.rename', { node: 'solo', label: 'Edited' }],
    [FILED['discard-replace'], 'canvas.rename', { node: 'solo', label: 'Edited' }],
    [FILED.shrunk, 'canvas.delete', { nodes: ['gone'] }],
  ] as const) {
    for (const [name, more] of [
      ['canvas.get', {}],
      [edit, args],
    ] as const) {
      const done = await core.call(name, { canvas, ...more }, CALLERS.you);
      if (!done.ok) throw new Error(done.error.sentence);
    }
  }
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
    profile,
    meeting: (rule) => {
      if (rule === 'discard') {
        const granted = (CALLERS['outside-write'] as OutsideCaller).canvases as CanvasId[];
        const before = granted.length;
        granted.push(...(Object.values(FILED) as CanvasId[]));
        return () => {
          granted.splice(before);
        };
      }
      if (rule !== 'new-agent') return () => undefined;
      cap = 0;
      return () => {
        cap = MAX_CREATED_AGENTS;
      };
    },
    close: async () => {
      await core.close();
      await rm(profile, { recursive: true, force: true });
    },
  };
}

/** A request id for each fixture that writes, so that a call repeated through another transport dedupes. */
const request = (n: number) => `2c3d4e5f-6071-4829-9bac-1d2e3f4a5b${String(n).padStart(2, '0')}`;
const INSERT_REQUEST = '3c3d4e5f-6071-4829-9bac-1d2e3f4a5b00';
const ARRANGE_REQUEST = '3c3d4e5f-6071-4829-9bac-1d2e3f4a5b01';
const SHOW_REQUEST = '3c3d4e5f-6071-4829-9bac-1d2e3f4a5b02';

/** A request id for each fixture of a canvas's lifetime that writes. */
const lifetime = (n: number) => `3d4e5f60-7182-4a3b-8cad-2e3f4a5b6c${String(n).padStart(2, '0')}`;

/** The world's profile id, which its worktrees' branches and folders would be named by. */
const WORLD_PROFILE = '4e5f6071-8293-4a4b-9cbd-3f4a5b6c7d8e';
/** A request id for each fixture of the worktrees' setup that writes. */
const setupRequest = (n: number) =>
  `4e5f6071-8293-4a4b-9cbd-3f4a5b6c7d${String(n).padStart(2, '0')}`;

/** A target the lead's team holds (its helper, and its own group), and every outside token reaches. */
const TARGETS = [
  { canvas: CANVAS, target: { agent: 'helper' } },
  { canvas: CANVAS, target: { group: 'lead' } },
];

/** An absent item in the lead’s team: a stable expectation that also exercises EntityKey reach. */
const NO_ITEM = { 'item/helper/none': 0 };

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
  'canvas.list': {
    valid: [{}, undefined],
    invalid: [{ canvas: CANVAS }, { extra: true }, 'text', null],
  },
  'canvas.get': {
    valid: [{ canvas: CANVAS }, {}],
    invalid: [{ canvas: 'nope' }, { canvas: CANVAS, extra: true }, { node: 'helper' }],
  },
  'canvas.rename': {
    // The first call renames the helper; each after it names it as it is then, changing nothing,
    // so expecting its revision before is no conflict.
    valid: [
      {
        canvas: CANVAS,
        node: 'helper',
        label: 'Assistant',
        expect: { 'node/helper': 1, 'item/helper/none': 0 },
        request: request(31),
      },
      { node: 'helper', label: 'Assistant', request: request(32) },
    ],
    fresh: ['revs'],
    invalid: [
      { canvas: CANVAS, node: 'helper' },
      { canvas: CANVAS, node: '', label: 'Helper' },
      { canvas: CANVAS, node: 'helper', label: 'x'.repeat(MAX_LABEL + 1) },
      { canvas: CANVAS, node: 'helper', label: 'Helper', expect: { meta: 1 } },
      { canvas: CANVAS, node: 'helper', label: 'Helper', expect: { 'node/helper': -1 } },
    ],
  },
  'canvas.insertTemplate': {
    valid: [
      {
        canvas: CANVAS,
        template: TEMPLATE,
        values: { feature: 'Export invoices' },
        parent: 'lead',
        expect: NO_ITEM,
        request: INSERT_REQUEST,
      },
    ],
    fresh: ['group', 'agents', 'revs'],
    invalid: [
      { template: 'missing' },
      { template: TEMPLATE, values: { feature: 1 } },
      { template: TEMPLATE, values: { feature: 'x'.repeat(MAX_MESSAGE_BYTES + 1) } },
      { template: TEMPLATE, parent: '' },
      { template: TEMPLATE, extra: true },
      { template: TEMPLATE, agents: { planner: 1 } },
      { template: TEMPLATE, connections: { planner: '' } },
      {
        template: TEMPLATE,
        values: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [String(i), 'x'])),
      },
    ],
    meetsRule: {
      'new-agent': {
        canvas: CANVAS,
        template: TEMPLATE,
        values: {},
        parent: 'lead',
        request: '3c3d4e5f-6071-4829-9bac-1d2e3f4a5b03',
      },
    },
  },
  'canvas.setArrange': {
    valid: [{ canvas: CANVAS, on: true, expect: NO_ITEM, request: ARRANGE_REQUEST }],
    fresh: ['revs'],
    invalid: [
      { on: 1 },
      { canvas: CANVAS },
      { canvas: 'missing', on: true },
      { on: true, extra: true },
    ],
  },
  'canvas.addAgent': {
    valid: [
      {
        canvas: CANVAS,
        at: { x: 2000, y: 0 },
        adapter: 'codex',
        connection: 'codex.terminal',
        expect: NO_ITEM,
        request: request(40),
      },
    ],
    fresh: ['id', 'revs'],
    invalid: [
      { at: { x: 0, y: 0 } },
      { at: { x: '0', y: 0 }, adapter: 'codex' },
      { at: { x: 0, y: 0 }, adapter: '' },
      { at: { x: 0, y: 0 }, adapter: 'codex', connection: '' },
      { at: { x: 0, y: 0 }, adapter: 'codex', extra: true },
    ],
    meetsRule: {
      'new-agent': {
        canvas: CANVAS,
        at: { x: 3000, y: 0 },
        adapter: 'codex',
        request: request(27),
      },
    },
  },
  'canvas.spawnAgent': {
    valid: [
      { canvas: CANVAS, from: 'helper', relation: 'peer', expect: NO_ITEM, request: request(41) },
      { canvas: CANVAS, from: 'helper', relation: 'linked', expect: NO_ITEM, request: request(42) },
    ],
    fresh: ['id', 'revs'],
    invalid: [
      { from: 'helper' },
      { from: '', relation: 'peer' },
      { from: 'helper', relation: 'child' },
    ],
    meetsRule: {
      'new-agent': { canvas: CANVAS, from: 'helper', relation: 'peer', request: request(28) },
    },
  },
  'canvas.link': {
    valid: [
      {
        canvas: CANVAS,
        a: 'helper',
        b: 'lead',
        source: 'lead',
        dots: ['top', 'bottom'],
        expect: NO_ITEM,
        request: request(43),
      },
    ],
    fresh: ['revs'],
    invalid: [
      { a: 'helper' },
      { a: '', b: 'lead' },
      { a: 'helper', b: 'lead', dots: ['left', 'top'] },
      { a: 'helper', b: 'lead', source: 1 },
    ],
    // Two agents of the lead's team that exist and aren't linked.
    meetsRule: { links: { canvas: CANVAS, a: 'aide', b: 'helper', request: request(4) } },
  },
  'canvas.unlink': {
    // A link that isn't there is not-found, and a token never unlinks two agents that exist (R13,
    // below): only you have one to unlink, of your own.
    valid: [],
    by: {
      you: [
        { canvas: CANVAS, a: 'helper', b: 'unlink-you', expect: NO_ITEM, request: request(80) },
      ],
    },
    fresh: ['revs'],
    invalid: [
      { a: 'helper' },
      { a: 'helper', b: '' },
      { a: 'helper', b: 'lead', dots: ['top', 'bottom'] },
    ],
    meetsRule: { links: { canvas: CANVAS, a: 'lead', b: 'deputy', request: request(5) } },
  },
  'canvas.delete': {
    valid: [{ canvas: CANVAS, nodes: [], links: [], expect: NO_ITEM, request: request(45) }],
    // A removed id cannot pass a token’s reach check on its transport retry. The human fixture
    // exercises removal; tokens use the empty edit, with every named id still resolvable.
    by: {
      you: [
        {
          canvas: CANVAS,
          nodes: ['frame-delete'],
          links: [{ a: 'helper', b: 'lead' }],
          expect: NO_ITEM,
          request: request(54),
        },
      ],
    },
    fresh: ['revs'],
    invalid: [
      { nodes: [1] },
      { links: [{ a: 'helper' }] },
      { nodes: Array.from({ length: MAX_OP_NODES + 1 }, () => 'helper') },
      { links: Array.from({ length: MAX_OP_NODES + 1 }, () => ({ a: 'helper', b: 'lead' })) },
    ],
    meetsRule: {
      'human-gate': { canvas: CANVAS, nodes: ['gate'], request: request(19) },
      links: { canvas: CANVAS, links: [{ a: 'deputy', b: 'helper' }], request: request(3) },
      // A leaf of the lead's team, nothing in its queue: a token's delete of it is proposed.
      discard: { canvas: CANVAS, nodes: ['doomed'], request: request(34) },
    },
  },
  'canvas.group': {
    valid: [
      { canvas: CANVAS, nodes: ['helper'], kind: 'frame', expect: NO_ITEM, request: request(46) },
    ],
    fresh: ['id', 'revs'],
    invalid: [
      { nodes: [], kind: 'frame' },
      { nodes: ['helper'], kind: 'group' },
      { nodes: Array.from({ length: MAX_OP_NODES + 1 }, () => 'helper'), kind: 'frame' },
    ],
    meetsRule: {
      // An agent made around the aide gives it another manager.
      managers: { canvas: CANVAS, nodes: ['aide'], kind: 'agent', request: request(6) },
      // One made around an empty frame changes no manager.
      'new-agent': { canvas: CANVAS, nodes: ['frame-cap'], kind: 'agent', request: request(29) },
    },
  },
  'canvas.ungroup': {
    // Keep the named agent so a retry still resolves it; only its children move up. The lead
    // cannot reach the worker, so its valid call explicitly has no targets.
    valid: [{ canvas: CANVAS, nodes: ['worker'], expect: NO_ITEM, request: request(47) }],
    by: { lead: [{ canvas: CANVAS, nodes: [], expect: NO_ITEM, request: request(48) }] },
    fresh: ['revs'],
    invalid: [
      {},
      { nodes: [''] },
      { nodes: Array.from({ length: MAX_OP_NODES + 1 }, () => 'helper') },
    ],
    // What the deputy holds goes up to the lead.
    meetsRule: { managers: { canvas: CANVAS, nodes: ['deputy'], request: request(7) } },
  },
  'canvas.addParent': {
    valid: [],
    by: Object.fromEntries(
      (['you', 'lead', 'outside-write'] as const).map((party, i) => [
        party,
        [{ canvas: CANVAS, frame: `frame-${party}`, expect: NO_ITEM, request: request(50 + i) }],
      ]),
    ),
    fresh: ['revs'],
    invalid: [{}, { frame: '' }, { frame: 'frame-you', extra: true }],
    meetsRule: {
      // The frame holding the member becomes its manager.
      managers: { canvas: CANVAS, frame: 'frame-team', request: request(8) },
      'new-agent': { canvas: CANVAS, frame: 'frame-spare', request: request(33) },
    },
  },
  'canvas.move': {
    valid: [
      {
        canvas: CANVAS,
        moves: [{ node: 'helper', position: { x: 60, y: 80 } }],
        expect: NO_ITEM,
        request: request(53),
      },
    ],
    fresh: ['revs'],
    invalid: [
      { moves: [{ node: 'helper' }] },
      { moves: [{ node: '', position: { x: 0, y: 0 } }] },
      {
        moves: Array.from({ length: MAX_OP_NODES + 1 }, () => ({
          node: 'helper',
          position: { x: 0, y: 0 },
        })),
      },
    ],
  },
  'agent.setType': {
    valid: [
      {
        canvas: CANVAS,
        agent: 'stranger',
        adapter: 'claude-code',
        connection: 'claude-code.sdk',
        expect: NO_ITEM,
        request: request(60),
      },
    ],
    fresh: ['revs'],
    invalid: [
      { agent: 'helper' },
      { agent: 'helper', adapter: '' },
      { agent: 'helper', adapter: 'codex', then: { command: 'go' } },
    ],
    // Yours alone: no token is in its audience to refuse.
    meetsRule: {
      connection: {
        canvas: CANVAS,
        agent: 'stranger',
        adapter: 'codex',
        connection: 'codex.app-server',
        request: request(9),
      },
    },
  },
  'agent.setConnection': {
    valid: [
      {
        canvas: CANVAS,
        agent: 'worker',
        connection: 'codex.terminal',
        expect: NO_ITEM,
        request: request(61),
      },
    ],
    fresh: ['revs'],
    invalid: [
      { agent: 'helper' },
      { agent: 'helper', connection: '' },
      { agent: 'helper', connection: 'codex.app-server', then: { command: 'go' } },
    ],
    meetsRule: {
      connection: {
        canvas: CANVAS,
        agent: 'worker',
        connection: 'codex.app-server',
        request: request(14),
      },
    },
  },
  'agent.setSettings': {
    valid: [
      {
        canvas: CANVAS,
        agent: 'helper',
        adapter: 'codex',
        settings: { model: 'new-model' },
        expect: NO_ITEM,
        request: request(62),
      },
    ],
    fresh: ['revs'],
    invalid: [
      { agent: 'helper', adapter: 'codex' },
      { agent: 'helper', adapter: 'codex', settings: { model: '-flag' } },
      // Not a mode's id. (One that is, but that its connection can't start in, is a token's to
      // change no more than any other: R2 refuses it before the op reads it.)
      { agent: 'helper', adapter: 'codex', settings: { mode: 'Full access' } },
      { agent: 'helper', adapter: 'codex', settings: { other: true } },
    ],
    meetsRule: {
      // The helper starts in its user's default mode: a token sets it none.
      'mode-permits': {
        canvas: CANVAS,
        agent: 'helper',
        adapter: 'codex',
        settings: { mode: 'read-only' },
        request: request(15),
      },
      self: {
        canvas: CANVAS,
        agent: 'lead',
        adapter: 'codex',
        settings: { model: 'lead-model' },
        request: request(16),
      },
    },
  },
  'agent.setRole': {
    valid: [
      {
        canvas: CANVAS,
        agent: 'helper',
        role: 'Reviews changes',
        expect: NO_ITEM,
        request: request(63),
      },
    ],
    fresh: ['revs'],
    invalid: [
      { agent: 'helper' },
      { agent: 'helper', role: 'x'.repeat(MAX_ROLE_LENGTH + 1) },
      { agent: 'helper', role: 'bad\u0001role' },
    ],
    meetsRule: {
      self: { canvas: CANVAS, agent: 'lead', role: 'Leads the team', request: request(17) },
      role: { canvas: CANVAS, agent: 'helper', role: 'Plans the work', request: request(18) },
    },
  },
  'queue.add': {
    valid: [
      {
        canvas: CANVAS,
        agent: 'helper',
        entry: {
          repeat: [{ waitFor: [{ agent: 'helper', item: 'text' }] }],
          until: { kind: 'repeatEnds', agent: 'helper', item: 'loop' },
          rounds: 3,
          otherwise: 'ask',
        },
        expect: NO_ITEM,
        request: request(64),
      },
      {
        canvas: CANVAS,
        agent: 'helper',
        into: 'loop',
        entry: { message: 'Child' },
        expect: NO_ITEM,
        request: request(65),
      },
    ],
    fresh: ['id', 'revs'],
    invalid: [
      { agent: 'helper' },
      { agent: 'helper', entry: { message: '', by: 'you' } },
      { agent: 'helper', entry: { message: 'x'.repeat(MAX_MESSAGE_BYTES + 1) } },
      { agent: 'helper', entry: { action: 'x'.repeat(MAX_LABEL + 1) } },
      {
        agent: 'helper',
        entry: { waitFor: Array.from({ length: MAX_OP_NODES + 1 }, () => ({ agent: 'helper' })) },
      },
    ],
  },
  'queue.remove': {
    valid: [],
    // Separate items exercise successful removal for every audience. T3a tries you first, so
    // its token parity calls see the same not-found on both transports after that removal.
    by: Object.fromEntries(
      (['you', 'lead', 'outside-write'] as const).map((party, i) => [
        party,
        [
          {
            canvas: CANVAS,
            agent: 'helper',
            item: `remove-${party}`,
            expect: NO_ITEM,
            request: request(66 + i),
          },
        ],
      ]),
    ),
    fresh: ['revs'],
    invalid: [
      { agent: 'helper' },
      { agent: 'helper', item: '' },
      { agent: 'helper', item: 'text', extra: true },
    ],
    meetsRule: {
      'human-gate': {
        canvas: CANVAS,
        agent: 'helper',
        item: 'ok-remove',
        request: request(24),
      },
    },
  },
  'queue.move': {
    valid: [
      {
        canvas: CANVAS,
        agent: 'helper',
        item: 'step',
        before: 'text',
        expect: NO_ITEM,
        request: request(69),
      },
    ],
    fresh: ['revs'],
    invalid: [
      { agent: 'helper', item: 'text' },
      { agent: 'helper', item: 'text', before: null, after: null },
      { agent: 'helper', item: 'text', before: '' },
    ],
    meetsRule: {
      'human-gate': {
        canvas: CANVAS,
        agent: 'helper',
        item: 'ok-move',
        before: 'text',
        request: request(25),
      },
    },
  },
  'queue.update': {
    valid: [
      {
        canvas: CANVAS,
        agent: 'helper',
        item: 'text',
        change: { kind: 'message', message: 'New text' },
        expect: NO_ITEM,
        request: request(70),
      },
    ],
    fresh: ['revs'],
    invalid: [
      { agent: 'helper', item: 'text' },
      {
        agent: 'helper',
        item: 'text',
        change: { kind: 'message', message: 'x'.repeat(MAX_MESSAGE_BYTES + 1) },
      },
      { agent: 'helper', item: 'text', change: { kind: 'message', message: '', by: 'you' } },
      { agent: 'helper', item: 'text', change: { kind: 'target', target: '' } },
    ],
    meetsRule: {
      'human-gate': {
        canvas: CANVAS,
        agent: 'helper',
        item: 'ok-update',
        change: { kind: 'approve', approve: 'Check again' },
        request: request(26),
      },
    },
  },
  'canvas.batch': {
    // Each call after the first renames the helper as it is and moves its step where it is: no
    // change, as alike for every party.
    valid: [
      {
        canvas: CANVAS,
        ops: [
          { op: 'canvas.rename', args: { node: 'helper', label: 'Assistant' } },
          { op: 'queue.move', args: { agent: 'helper', item: 'step', before: 'text' } },
        ],
        expect: NO_ITEM,
        request: request(35),
      },
    ],
    fresh: ['revs'],
    invalid: [
      { ops: [] },
      { ops: [{ op: 'run.pause', args: { target: { agent: 'helper' } } }] },
      { ops: [{ op: 'canvas.batch', args: { ops: [] } }] },
      { ops: [{ op: 'canvas.rename', args: { canvas: CANVAS, node: 'helper', label: 'X' } }] },
      {
        ops: Array.from({ length: MAX_BATCH_OPS + 1 }, () => ({
          op: 'canvas.rename',
          args: { node: 'helper', label: 'X' },
        })),
      },
    ],
    // Every rule a batch can meet, each through one op of its own, on the whole change.
    meetsRule: {
      discard: {
        canvas: CANVAS,
        ops: [{ op: 'canvas.delete', args: { nodes: ['doomed-batch'] } }],
        request: request(36),
      },
      // The helper starts in read-only by now (agent.setSettings's own case, yours).
      'mode-permits': {
        canvas: CANVAS,
        ops: [
          {
            op: 'agent.setSettings',
            args: { agent: 'helper', adapter: 'codex', settings: { mode: 'plan' } },
          },
        ],
        request: request(37),
      },
      self: {
        canvas: CANVAS,
        ops: [{ op: 'agent.setRole', args: { agent: 'lead', role: 'Leads in a batch' } }],
        request: request(38),
      },
      'human-gate': {
        canvas: CANVAS,
        ops: [{ op: 'queue.remove', args: { agent: 'helper', item: 'ok-batch' } }],
        request: request(39),
      },
      'new-agent': {
        canvas: CANVAS,
        ops: [{ op: 'canvas.addAgent', args: { at: { x: 3300, y: 0 }, adapter: 'codex' } }],
        request: request(83),
      },
      role: {
        canvas: CANVAS,
        ops: [{ op: 'agent.setRole', args: { agent: 'helper', role: 'Plans in a batch' } }],
        request: request(84),
      },
      links: {
        canvas: CANVAS,
        ops: [{ op: 'canvas.link', args: { a: 'aide', b: 'lead' } }],
        request: request(85),
      },
      managers: {
        canvas: CANVAS,
        ops: [{ op: 'canvas.group', args: { nodes: ['member'], kind: 'agent' } }],
        request: request(86),
      },
    },
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
  reply: {
    // Only you answer a proposal: you refuse one, and allow the other once every token's answer
    // to it was refused.
    valid: [],
    by: {
      you: [
        {
          canvas: CANVAS,
          to: PROPOSED.refused,
          answer: { choice: 'refuse' },
          request: request(87),
        },
      ],
    },
    fresh: ['id', 'revs'],
    invalid: [
      { to: 'nope', answer: { choice: 'allow' } },
      { to: PROPOSED.allowed, answer: {} },
      { to: PROPOSED.allowed, answer: { choice: '' } },
      { to: PROPOSED.allowed, answer: { choice: 'allow' }, extra: true },
    ],
    meetsRule: {
      'human-choice': {
        canvas: CANVAS,
        to: PROPOSED.allowed,
        answer: { choice: 'allow' },
        request: request(88),
      },
    },
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
      { topic: 'canvases', request: request(71) },
      { topic: 'canvas', canvas: CANVAS, request: request(72) },
      // The canvas filled in: yours, the only one open.
      { topic: 'needs', request: request(73) },
    ],
    invalid: [
      {},
      { topic: 'missing' },
      { topic: 'usage', window: 2 },
      { topic: 'canvas', canvas: 'nope' },
    ],
    fresh: ['epoch'],
  },
  'topics.unsubscribe': {
    valid: [
      { topic: 'usage', request: request(77) },
      { topic: 'settings', request: request(78) },
      { topic: 'canvases', request: request(79) },
      { topic: 'canvas', canvas: CANVAS, request: request(74) },
      { topic: 'needs', canvas: CANVAS, request: request(82) },
    ],
    invalid: [{}, { topic: 'missing' }, { topic: 'needs', canvas: 'nope' }],
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
  'window.show': {
    valid: [{ canvas: CANVAS, request: SHOW_REQUEST }],
    invalid: [{ canvas: 5 }, { canvas: 'missing' }, { canvas: CANVAS, window: 8 }],
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
  // A canvas's lifetime. A token's calls make, save and close canvases of its own, or the world's;
  // what only you reach (FILED) is yours to make, close or replace, but for the calls meeting R4.
  'canvas.create': {
    valid: [{ request: lifetime(0) }],
    by: {
      you: [
        { request: lifetime(1) },
        { template: TEMPLATE, values: { feature: 'Export CSV' }, request: lifetime(2) },
        { replace: { canvas: FILED.replaced }, request: lifetime(3) },
      ],
    },
    fresh: ['canvas', 'revs'],
    invalid: [
      { template: 'nope' },
      { values: { feature: 'Export CSV' } },
      { replace: { canvas: 'nope' } },
      { replace: { canvas: CANVAS, discard: 'yes' } },
      { canvas: CANVAS },
    ],
    meetsRule: {
      discard: {
        replace: { canvas: FILED['discard-replace'], discard: true },
        request: lifetime(4),
      },
      'new-agent': { template: TEMPLATE, request: lifetime(5) },
    },
  },
  'canvas.open': {
    // The dialog is cancelled: nothing opens, so nothing is replaced.
    valid: [{}, { replace: { canvas: CANVAS } }],
    invalid: [{ replace: {} }, { replace: { canvas: 'nope' } }, { canvas: CANVAS }],
  },
  'canvas.save': {
    valid: [{ canvas: CANVAS, request: lifetime(6) }],
    fresh: ['revs'],
    invalid: [{ canvas: 'nope' }, { canvas: CANVAS, file: '/etc/passwd' }],
    meetsRule: { discard: { canvas: FILED.shrunk, request: lifetime(7) } },
  },
  'canvas.saveAs': {
    // The dialog is cancelled: nothing is saved.
    valid: [{ canvas: CANVAS }, {}],
    invalid: [{ canvas: 'nope' }, { canvas: CANVAS, file: '/etc/passwd' }],
  },
  'canvas.close': {
    valid: [],
    by: { you: [{ canvas: FILED.closing, request: lifetime(8) }] },
    fresh: ['revs'],
    invalid: [
      { canvas: 'nope' },
      { canvas: CANVAS, discard: 'yes' },
      { canvas: CANVAS, keep: true },
    ],
    meetsRule: {
      discard: { canvas: FILED['discard-close'], discard: true, request: lifetime(9) },
    },
  },
  'project.choose': {
    // The dialog is cancelled: the folder stays.
    valid: [{ canvas: CANVAS }],
    invalid: [{ canvas: 'nope' }, { canvas: CANVAS, path: '/tmp' }],
  },
  'project.clearSetupApproval': {
    // Yours alone: nothing was allowed always for the world's repository, so nothing is cleared.
    valid: [],
    by: { you: [{ canvas: CANVAS, request: setupRequest(3) }] },
    invalid: [{ canvas: 'nope' }, { canvas: CANVAS, command: 'make setup' }],
  },
  'project.setSetupCommand': {
    // Yours alone: you set the world repository's setup command, then go back to the detected one.
    valid: [],
    by: {
      you: [
        { canvas: CANVAS, command: 'make setup', request: setupRequest(1) },
        { canvas: CANVAS, command: null, request: setupRequest(2) },
      ],
    },
    invalid: [
      { canvas: CANVAS },
      { canvas: CANVAS, command: '' },
      { canvas: CANVAS, command: 'make\nsetup' },
      { canvas: CANVAS, command: 'make \u202esetup' },
      { canvas: CANVAS, command: 'x'.repeat(4097) },
      { canvas: CANVAS, command: 'make setup', shell: 'bash' },
      { canvas: CANVAS, command: 'make setup', folder: '/tmp' },
      { canvas: 'nope', command: 'make setup' },
    ],
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
  // A node is reached as an agent is.
  NodeId: (caller, reach) =>
    caller.kind === 'outside' ? [] : AGENTS_OUT_OF_REACH[caller.agent]?.[reach],
  // A real item on another agent, never in the queue a fixture edits.
  ItemId: () => ['stranger-item'],
  // Whatever a key names on a token's canvas; for an agent, what names an agent it doesn't reach:
  // its node, its items, a link to it.
  EntityKey: (caller, reach) =>
    caller.kind === 'outside'
      ? []
      : AGENTS_OUT_OF_REACH[caller.agent]?.[reach]?.flatMap((agent) => [
          nodeKey(agent),
          itemKey(agent, 'none'),
          linkKey(agent, caller.agent),
        ]),
  // A lead's team holds its own group, not the worker's.
  GroupId: (caller, reach) =>
    caller.kind === 'outside'
      ? []
      : caller.agent === 'lead' && reach === 'team'
        ? ['worker']
        : undefined,
  MessageId: (caller) =>
    MESSAGES_OUT_OF_REACH[caller.kind === 'outside' ? caller.name : caller.agent],
  // A Needs item that isn't there.
  NeedId: () => ['proposal/1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4aff'],
};
