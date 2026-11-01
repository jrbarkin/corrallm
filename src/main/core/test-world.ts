import { legacyDirectories } from './workspaces/test-directories';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MAX_LINK_LENGTH } from '../../shared/api/limits';
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
import { MAX_FILE_QUERY_LENGTH, MAX_MESSAGE_LENGTH, MAX_ROLE_LENGTH } from '../../shared/session';
import type { Connector } from '../sessions/connector';
import { CATALOG } from '../sessions/adapters';
import { FakeConnector } from '../sessions/fake';
import type { OutsideCaller } from './caller';
import { mintTrustedPath } from './host';
import { createCore } from './core';
import type { Core } from './core';
import { cursorOf } from './delivery/messages';
import { keepCanvases, keepMessages, openTestStore } from './store/test-store';
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
 * Its workspace records: the worker and apprentice share a real, idle tree for Review and
 * Merge (WORKER_WORKTREE), which the worker lists without the apprentice. Other trees were
 * made once and their checkouts have gone since (lost):
 * `kept-work` and `kept-work-batch`, in the lead's team, each work alone in a tree of its own, so
 * deleting either asks you (workspace-safety: what it holds can't be read); and a retained tree
 * (KEPT_WORKTREE), whose removal asks you too.
 *
 * The run's controls act on the canvas's run, never started before them (their fixtures come
 * last): three nappers in the lead's team (`sleeper-you`, `sleeper-lead`, `sleeper-outside`), each
 * a delay of an hour for one party to end with Go on now, and `spender`, on a backend no other agent
 * spends, whose usage rule (set as the core starts) holds its task for the window's reset, which
 * only you go on past (R3). Their sessions are sent nothing, or play no turn. A token's start meets
 * R9 once you stopped the run (`meeting`, for run.start and run.resume).
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

/** A retained tree whose checkout is gone: removal must ask, never assume it safe. */
export const KEPT_WORKTREE = '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a55';

/**
 * The worker's group's tree, which the worker and its apprentice share (a member the worker
 * doesn't reach), ready; and a tree each of `kept-work` and `kept-work-batch` work in alone, whose
 * checkouts are gone, so deleting either asks you what becomes of it (workspace-safety).
 */
export const WORKER_WORKTREE = '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a56';
const KEPT_WORK = {
  'kept-work': '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a57',
  'kept-work-batch': '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a58',
} as const;

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

/** A capable connection chosen through the catalog, never another CLI name in platform code. */
const CONTROL =
  CATALOG.adapters
    .flatMap((adapter) => adapter.connections.map((connection) => ({ adapter, connection })))
    .find(
      ({ connection }) =>
        connection.panels.rewind?.restores.includes('code') && connection.live.stopTask,
    ) ??
  (() => {
    throw new Error('The fixture needs a connection with code rewind and background tasks');
  })();
/** A connection spending another usage backend than Codex's app server, for a usage rule's hold. */
const CODEX_USAGE = CATALOG.adapters
  .flatMap((adapter) => adapter.connections)
  .find((connection) => connection.id === 'codex.app-server')?.usage;
const SPENDING =
  CATALOG.adapters
    .flatMap((adapter) => adapter.connections.map((connection) => ({ adapter, connection })))
    .find(({ connection }) => connection.usage !== null && connection.usage !== CODEX_USAGE) ??
  (() => {
    throw new Error('The fixture needs a connection spending another usage backend');
  })();
const SPENDING_BACKEND = SPENDING.connection.usage ?? '';
/** A delay none of the generated tests waits out: an hour. */
const NAP = { id: 'nap', delay: { seconds: 3600 } };
/** Sessions that start, and play no turn of what they are sent. */
function silent(adapter: string): Connector<SessionMode> {
  const fake = new FakeConnector({ adapter });
  return {
    start: async (spec, host) => {
      const session = await fake.start(spec, host);
      session.send = () => Promise.resolve();
      return session;
    },
  };
}
const CONTROL_AGENT = 'session-control';
/** The MCP server the capable connection's session reports. */
const CONTROL_SERVER = 'fixture-server';
/**
 * An agent of the capable connection whose conversations are resumed (B11 §7): its own, so no
 * other fixture's session closes under it.
 */
const RESUMER = 'resumer';
/** The conversations the capable connection's adapter keeps for the world's folder. */
const WORLD_KEPT = [
  { id: '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01', title: 'Earlier work', modified: 2 },
  { id: '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e02', title: 'Older work', modified: 1 },
] as const;
const CONTROL_MESSAGE = '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a80';
const CONTROL_TASKS = ['you', 'lead', 'outside-write'].map(
  (party) => `fixture-background-${party}`,
);
const controlRequest = (n: number) =>
  `2c3d4e5f-6071-4829-9bac-1d2e3f4a${String(n).padStart(4, '0')}`;
const CONTROL_MODE = CONTROL.connection.startModes[0];
if (!CONTROL_MODE) throw new Error('The fixture needs an asking start mode');
function controlConnector(): Connector<SessionMode> {
  const fake = new FakeConnector({ adapter: CONTROL.adapter.id });
  return {
    start: async (spec, host) => {
      const live = await fake.start(spec, host);
      if (spec.agentId === RESUMER) host.remember(WORLD_KEPT[0].id);
      // The resumer's sessions run nothing in the background, so its folder's restores go on.
      if (spec.agentId !== CONTROL_AGENT) return live;
      let tasks = CONTROL_TASKS.map((id) => ({
        id,
        description: 'Fixture task',
        kind: 'command' as const,
      }));
      live.stopTask = (id) => {
        tasks = tasks.filter((task) => task.id !== id);
        host.emit({ type: 'tasks', tasks });
        return Promise.resolve();
      };
      live.rewindFiles = () => Promise.resolve({ possible: true, files: [], added: 0, removed: 0 });
      // A regular MCP server and corrallm’s protected entry, unchanged by a fake’s change.
      live.mcpServers = () =>
        Promise.resolve([
          { name: CONTROL_SERVER, status: 'connected' as const, tools: 1 },
          { name: 'corrallm-server', status: 'connected' as const },
        ]);
      live.changeMcpServer = () => Promise.resolve();
      host.emit({
        type: 'history',
        events: [
          { type: 'user', id: CONTROL_MESSAGE, text: 'Fixture work' },
          { type: 'text', id: `${CONTROL_MESSAGE}/reply`, text: 'Done' },
          {
            type: 'end',
            messages: [CONTROL_MESSAGE],
            seconds: 1,
            result: { status: 'completed', reason: 'completed' },
          },
        ],
      });
      host.emit({ type: 'tasks', tasks });
      return live;
    },
  };
}

const NODES = [
  {
    id: CONTROL_AGENT,
    adapter: CONTROL.adapter.id,
    connection: CONTROL.connection.id,
    parent: 'lead',
  },
  { id: RESUMER, adapter: CONTROL.adapter.id, connection: CONTROL.connection.id, parent: 'lead' },
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
  // Each the last agent of a tree holding work: deleting it asks you (workspace-safety).
  ...Object.keys(KEPT_WORK).map((id) => ({ id, connection: 'codex.app-server', parent: 'lead' })),
  // The run's controls: a napper for each party's Go on now, and what a usage rule holds.
  ...['you', 'lead', 'outside'].map((party) => ({
    id: `sleeper-${party}`,
    connection: 'codex.app-server',
    parent: 'lead',
  })),
  {
    id: 'spender',
    adapter: SPENDING.adapter.id,
    connection: SPENDING.connection.id,
    parent: 'lead',
  },
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
    fresh: ['revs'],
    id: `ok-${what}`,
    approve: `The ${what}`,
  })),
];
const LINKS = [
  ['helper', 'unlink-you'],
  ['worker', 'peer'],
  ['lead', 'peer'],
  // Lets the lead review the worker's shared branch, but never name its hidden apprentice.
  ['lead', 'worker'],
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
   * Readies the world for a call of op `op` meeting `rule`, before it is made: what undoes that,
   * after. R11's cap is then none, so that a call meets it whatever its party created before; R4's
   * canvases (FILED) are the outside write token's too; and for R9 on run.start and run.resume, you
   * stopped the run (your own call, after, starts or resumes it again).
   */
  meeting(rule: Rule, op?: string): () => void;
  close(): Promise<void>;
}> {
  const profile = await mkdtemp(path.join(tmpdir(), 'corrallm-world-'));
  const project = path.join(profile, 'project');
  await mkdir(project);
  // The synthetic native sessions are separate from the picked checkout that Merge writes.
  const sessionFolder = mintTrustedPath(path.join(profile, 'sessions-folder'));
  await mkdir(sessionFolder);
  // A repository with one commit and no files, so its worktrees' setup command can be kept for it.
  const env = gitEnvironment(path.join(profile, 'home'));
  git(project, env, 'init', '-q', '-b', 'main');
  git(
    project,
    { ...env, GIT_AUTHOR_DATE: '2026-10-26T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-26T12:00:00Z' },
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
                : id.startsWith('sleeper-')
                  ? { queue: [NAP] }
                  : id === 'spender'
                    ? { queue: [{ id: 'spend', message: 'Spend' }] }
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
  const store = await openTestStore(profile);
  try {
    const workspaces = new WorkspaceStore({ store });
    const root = path.join(profile, 'kept-project');
    await workspaces.write((w) => {
      w.addRepository({
        id: KEPT_WORKTREE,
        pickedRoot: root,
        realRoot: root,
        commonDir: path.join(root, '.git'),
        identity: 'kept repository',
        rootKind: 'project',
        ownedRoot: path.join(root, '.corral/worktrees/profile'),
      });
      const make = (id: string, owner: `${'agent' | 'group'}/${string}`) =>
        w.createWorktree({
          id,
          canvas: CANVAS,
          repository: KEPT_WORKTREE,
          owner,
          path: path.join(root, '.corral/worktrees/profile', id),
          branchRef: `refs/heads/corrallm/profile/${id}`,
          baseCheckout: root,
          baseRef: 'refs/heads/main',
          baseOid: 'a'.repeat(40),
          forkedFrom: null,
        });
      make(KEPT_WORKTREE, 'agent/former');
      w.retain(KEPT_WORKTREE);
      // In use and bound: each made
      // once, its checkout gone since, so lost as the core's own check would leave it, and a
      // retry finds nothing to make again (deterministic: no Git work goes on in the background).
      const inUse: [string, `${'agent' | 'group'}/${string}`, readonly string[], string][] = [
        ...Object.entries(KEPT_WORK).map(
          ([agent, id], i): [string, `agent/${string}`, string[], string] => [
            id,
            `agent/${agent}`,
            [agent],
            `${KEPT_WORKTREE.slice(0, -2)}6${String(i + 1)}`,
          ],
        ),
      ];
      for (const [id, owner, agents, job] of inUse) {
        const tree = make(id, owner);
        w.recordJob({
          id: job,
          workspace: id,
          kind: 'create',
          phase: 'populated',
          generation: tree.generation,
          payload: {},
        });
        w.finishJob(job, 'done');
        w.transition(id, { from: 'creating', to: 'missing', errorCode: 'checkout-missing' });
        for (const agent of agents) w.bind(CANVAS, agent, id);
      }
    });
    // A real, idle shared branch for Review and an already-merged Merge. Fixed Git dates make
    // its compared pins stable across transport retries; no native session runs in this tree.
    const ids = ['4e5f6071-8293-4a4b-9cbd-3f4a5b6c7d81', WORKER_WORKTREE];
    const runner = new GitRunner({
      environment: () => Promise.resolve(env),
      hooks: path.join(profile, 'fixture-hooks'),
    });
    const provisioner = new Provisioner({
      workspaces,
      git: runner,
      profile: WORLD_PROFILE,
      ids: () => ids.shift() ?? crypto.randomUUID(),
    });
    const found = await provisioner.repository(project);
    if (found.kind !== 'repository') throw new Error('The fixture needs a Git repository.');
    const tree = await provisioner.provision({
      canvas: CANVAS,
      repository: found.record,
      owner: 'group/worker',
      within: (w, made) => {
        w.bindCanvas(CANVAS, found.record.id);
        for (const agent of ['worker', 'apprentice']) w.bind(CANVAS, agent, made.id);
      },
    });
    if (tree.state !== 'setup')
      throw new Error(`The fixture tree did not populate: ${tree.errorCode ?? tree.state}`);
    await workspaces.write((w) => {
      w.transition(tree.id, { from: 'setup', to: 'ready' });
    });
  } finally {
    await store.close();
  }
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
      directoryResolver: (projects) => {
        const legacy = legacyDirectories(projects);
        return {
          workingDirectory: async (canvas, agent) => {
            const directory = await legacy.workingDirectory(canvas, agent);
            return directory.state === 'ready' ? { ...directory, cwd: sessionFolder } : directory;
          },
          projectRoot: (canvas) => legacy.projectRoot(canvas),
          onAvailability: (canvas, listener) => legacy.onAvailability(canvas, listener),
        };
      },
      // Registry parity tests exercise Git results, not OS process inspection.
      watchFolder: () => ({ close: () => undefined }),
      children: {
        platform: 'darwin',
        inspect: (pid) => ({ started: 1, group: pid }),
        alive: () => false,
        signal: () => undefined,
        wait: () => Promise.resolve(),
        pause: () => undefined,
        now: Date.now,
      },
      leads: isLead,
      // Each call a second after the last: no token's writes are limited here.
      limitsClock: () => (clock += 1000),
      maxCreatedAgents: () => cap,
      proposalIds: () => proposals.shift() ?? crypto.randomUUID(),
      sessions: {
        connectors: {
          'codex.app-server': new FakeConnector({ adapter: 'codex' }),
          'codex.terminal': REFUSING,
          [CONTROL.connection.id]: controlConnector(),
          [SPENDING.connection.id]: silent(SPENDING.adapter.id),
        },
        environment: () => Promise.resolve(env),
        // Never the user's own conversations: the world's, for its folder.
        conversations: {
          [CONTROL.adapter.id]: {
            list: () => Promise.resolve(WORLD_KEPT.map((one) => ({ ...one }))),
          },
        },
      },
      // Isolated setup fixtures: directory resolution is faked, and nothing allocates a tree here.
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
  await core.engines.canvas(CANVAS)?.engine.sessions.ready(CONTROL_AGENT);
  // The spender's backend is over its usage rule's share for a day: once the run starts, its task
  // waits for the window's reset, which only you go on past (R3 on run.goOn).
  for (const [name, args] of [
    [
      'usage.setRule',
      {
        backend: SPENDING_BACKEND,
        rule: { window: 'fiveHour', percent: 50, action: 'waitForReset' },
      },
    ],
    [
      'usage.simulate',
      {
        backend: SPENDING_BACKEND,
        windows: { fiveHour: { usedPercent: 90, resetsAt: Date.now() + 24 * 3_600_000 } },
      },
    ],
  ] as const) {
    const set = await core.call(name, args, CALLERS.you);
    if (!set.ok) throw new Error(set.error.sentence);
  }
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
  const resumer = await core.call('session.open', { canvas: CANVAS, agent: RESUMER }, CALLERS.you);
  if (!resumer.ok) throw new Error(resumer.error.sentence);
  // The resumer's conversations, listed to each caller that resumes one of them (B11 §7): a list
  // admits only its own caller.
  for (const party of ['you', 'outside-write'] as const) {
    const listed = await core.call(
      'session.conversations',
      { canvas: CANVAS, agent: RESUMER },
      CALLERS[party],
    );
    if (!listed.ok) throw new Error(listed.error.sentence);
  }
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
    meeting: (rule, op) => {
      if (rule === 'sticky' && (op === 'run.start' || op === 'run.resume')) {
        // Yours: a token neither resumes it nor starts it afresh.
        core.engines.canvas(CANVAS)?.engine.run.stop();
        return () => undefined;
      }
      if (rule === 'merge-permits') {
        const caller = CALLERS['outside-write'] as OutsideCaller;
        Object.assign(caller, { merge: false });
        return () => {
          Object.assign(caller, { merge: true });
        };
      }
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
const BRANCH_TIP = 'fc0c4e764a79c32ba8aeb05c0f97ada0fafd9c7f';
const BRANCH_MERGE = {
  canvas: CANVAS,
  agent: 'worker',
  source: { ref: `refs/heads/corrallm/${WORLD_PROFILE}/${WORKER_WORKTREE}`, oid: BRANCH_TIP },
  into: { ref: 'refs/heads/main', oid: BRANCH_TIP },
};

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
      { canvas: CANVAS, agent: 'helper', query: 'ipc' },
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
  // Every party's, as far as it reaches: the worker sees itself in its group's tree, never its
  // apprentice (whom it doesn't reach), nor what is yours alone.
  'worktree.list': {
    valid: [{ canvas: CANVAS }, { canvas: CANVAS, agent: 'peer' }],
    invalid: [
      { canvas: CANVAS, agent: '' },
      { canvas: CANVAS, worktree: WORKER_WORKTREE },
      { canvas: CANVAS, path: '/a/checkout' },
      { canvas: 'nope' },
      'text',
    ],
  },
  'branch.diff': {
    valid: [{ canvas: CANVAS, agent: 'worker' }],
    invalid: [
      {},
      { canvas: CANVAS, agent: '' },
      { canvas: 'nope', agent: 'worker' },
      { canvas: CANVAS, agent: 'worker', limit: 0 },
      { canvas: CANVAS, agent: 'worker', limit: 201 },
      { canvas: CANVAS, agent: 'worker', after: 'x'.repeat(513) },
      { canvas: CANVAS, agent: 'worker', after: 'e30=' },
      { canvas: CANVAS, agent: 'worker', path: '/another/checkout' },
    ],
  },
  'branch.merge': {
    // Even already-merged calls publish their job's admission and end: receipts are per call,
    // not per party. C6 observes before answering, so each revision names that call's settled state.
    fresh: ['revs'],
    valid: [{ ...BRANCH_MERGE, request: controlRequest(400) }],
    invalid: [
      {},
      { ...BRANCH_MERGE, request: controlRequest(401), source: undefined },
      { ...BRANCH_MERGE, request: controlRequest(401), into: undefined },
      { ...BRANCH_MERGE, request: undefined },
      { ...BRANCH_MERGE, request: controlRequest(401), agent: '' },
      { ...BRANCH_MERGE, request: controlRequest(401), force: true },
      { ...BRANCH_MERGE, request: controlRequest(401), uncommitted: { choice: 'commit' } },
    ],
    meetsRule: { 'merge-permits': { ...BRANCH_MERGE, request: controlRequest(402) } },
  },
  // Retrying the worker's ready tree neither forces nor remakes it.
  'worktree.retry': {
    fresh: ['revs'],
    valid: [{ canvas: CANVAS, agent: 'worker', request: controlRequest(392) }],
    invalid: [
      { canvas: CANVAS },
      { canvas: CANVAS, agent: '' },
      { canvas: CANVAS, agent: 'worker', force: true },
      { canvas: CANVAS, agent: 'worker', worktree: WORKER_WORKTREE },
      { canvas: CANVAS, agent: 'worker', path: '/a/checkout' },
      { canvas: 'nope', agent: 'worker' },
    ],
  },
  'worktree.remove': {
    // No checkout can be assessed here: C7 raises a discard proposal instead of removing it.
    fresh: ['proposed', 'revs'],
    proposesForYou: ['workspace-safety'],
    valid: [{ canvas: CANVAS, worktree: KEPT_WORKTREE, request: controlRequest(390) }],
    invalid: [
      {},
      { canvas: CANVAS },
      { canvas: 'nope', worktree: KEPT_WORKTREE },
      { canvas: CANVAS, worktree: '/a/checkout' },
      { canvas: CANVAS, worktree: 'x'.repeat(4096) },
      { canvas: CANVAS, worktree: KEPT_WORKTREE, force: true },
      { canvas: CANVAS, worktree: KEPT_WORKTREE, path: '/a/checkout' },
    ],
    meetsRule: {
      'workspace-safety': {
        canvas: CANVAS,
        worktree: KEPT_WORKTREE,
        request: controlRequest(391),
      },
    },
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
    fresh: ['roots', 'agents', 'revs'],
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
      // The last agent of a tree holding work: anyone's delete of it asks you, yours too.
      'workspace-safety': { canvas: CANVAS, nodes: ['kept-work'], request: controlRequest(393) },
    },
    proposesForYou: ['workspace-safety'],
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
  'agent.setFallback': {
    valid: [
      {
        canvas: CANVAS,
        agent: 'stranger',
        fallback: {
          to: [{ adapter: 'codex', connection: 'codex.terminal' }, { adapter: 'claude-code' }],
          back: 'return',
        },
        expect: NO_ITEM,
        request: request(55),
      },
    ],
    fresh: ['revs'],
    invalid: [
      { agent: 'helper' },
      { agent: 'helper', fallback: { to: [] } },
      { agent: 'helper', fallback: { to: [{ adapter: 'codex' }], back: 'stay' } },
      { agent: 'helper', fallback: { to: [{ adapter: 'codex', model: '-flag' }] } },
      { agent: 'helper', fallback: { to: [{ adapter: 'codex', mode: 'auto' }] } },
      {
        agent: 'helper',
        fallback: {
          to: [
            { adapter: 'codex' },
            { adapter: 'codex', model: 'a' },
            { adapter: 'codex', model: 'b' },
            { adapter: 'codex', model: 'c' },
          ],
        },
      },
    ],
    // Yours alone: no token is in its audience to refuse.
    meetsRule: {
      connection: {
        canvas: CANVAS,
        agent: 'stranger',
        fallback: { to: [{ adapter: 'claude-code', connection: 'claude-code.terminal' }] },
        request: request(56),
      },
    },
  },
  'agent.setHandoff': {
    valid: [
      {
        canvas: CANVAS,
        agent: 'stranger',
        handoff: { at: 80, file: 'docs/HANDOFF.md' },
        expect: NO_ITEM,
        request: request(57),
      },
    ],
    fresh: ['revs'],
    invalid: [
      { agent: 'helper' },
      { agent: 'helper', handoff: { at: 9 } },
      { agent: 'helper', handoff: { at: 96 } },
      { agent: 'helper', handoff: { off: false } },
      { agent: 'helper', handoff: { file: '../HANDOFF.md' } },
      { agent: 'helper', handoff: { file: 'HANDOFF.txt' } },
      { agent: 'helper', handoff: { file: '.git/HANDOFF.md' } },
      { agent: 'helper', handoff: { file: '-HANDOFF.md' } },
    ],
    // Yours alone: no token is in its audience to refuse.
    meetsRule: {
      connection: {
        canvas: CANVAS,
        agent: 'stranger',
        handoff: { off: true },
        request: request(58),
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
      // The last agent of a tree holding work, deleted beside a rename: the whole batch asks you.
      'workspace-safety': {
        canvas: CANVAS,
        ops: [
          { op: 'canvas.rename', args: { node: 'helper', label: 'Assistant' } },
          { op: 'canvas.delete', args: { nodes: ['kept-work-batch'] } },
        ],
        request: controlRequest(394),
      },
    },
    proposesForYou: ['workspace-safety'],
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
      { canvas: CANVAS, to: 'peer', body: ' \n' },
      { canvas: CANVAS, to: 'peer', body: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) },
      { canvas: CANVAS, to: 'peer' },
    ],
    meetsRule: {
      'shell-text': { canvas: CANVAS, to: 'shell', body: '!ls', request: request(2) },
      // Past a token's 16 KiB: yours, as your composer's are (B11 §16.6).
      'human-text': {
        canvas: CANVAS,
        to: 'peer',
        body: 'x'.repeat(MAX_MESSAGE_BYTES + 1),
        request: controlRequest(350),
      },
    },
  },
  withdraw: {
    fresh: ['revs'],
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
    fresh: ['revs', 'id', 'revs'],
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
  'session.open': {
    fresh: ['revs'],
    valid: [{ canvas: CANVAS, agent: CONTROL_AGENT, request: controlRequest(300) }],
    invalid: [{ canvas: CANVAS }],
  },
  'session.setMode': {
    fresh: ['revs'],
    valid: [
      { canvas: CANVAS, agent: CONTROL_AGENT, mode: CONTROL_MODE, request: controlRequest(301) },
    ],
    invalid: [{ canvas: CANVAS, agent: CONTROL_AGENT, mode: '' }],
  },
  'session.setModel': {
    fresh: ['revs'],
    valid: [{ canvas: CANVAS, agent: 'helper', model: 'default', request: controlRequest(302) }],
    invalid: [{ canvas: CANVAS, agent: 'helper', model: '--help' }],
  },
  'session.setEffort': {
    fresh: ['revs'],
    valid: [{ canvas: CANVAS, agent: 'helper', effort: null, request: controlRequest(303) }],
    invalid: [{ canvas: CANVAS, agent: 'helper', effort: '--help' }],
  },
  'session.stopTask': {
    fresh: ['revs'],
    by: {
      lead: [
        {
          canvas: CANVAS,
          agent: CONTROL_AGENT,
          task: CONTROL_TASKS[1],
          request: controlRequest(304),
        },
      ],
      'outside-write': [
        {
          canvas: CANVAS,
          agent: CONTROL_AGENT,
          task: CONTROL_TASKS[2],
          request: controlRequest(304),
        },
      ],
    },
    valid: [
      {
        canvas: CANVAS,
        agent: CONTROL_AGENT,
        task: CONTROL_TASKS[0],
        request: controlRequest(304),
      },
    ],
    invalid: [{ canvas: CANVAS, agent: CONTROL_AGENT, task: '--help' }],
  },
  'session.restart': {
    fresh: ['revs'],
    valid: [{ canvas: CANVAS, agent: 'helper', request: controlRequest(305) }],
    invalid: [{ canvas: CANVAS }],
  },
  'session.newConversation': {
    fresh: ['revs'],
    valid: [{ canvas: CANVAS, agent: 'helper', request: controlRequest(306) }],
    invalid: [{ canvas: CANVAS }],
  },
  'session.continueIn': {
    fresh: ['revs'],
    valid: [
      {
        canvas: CANVAS,
        agent: CONTROL_AGENT,
        connection: CONTROL.connection.id,
        request: controlRequest(307),
      },
    ],
    invalid: [{ canvas: CANVAS, agent: CONTROL_AGENT, connection: '' }],
  },
  'session.conversations': {
    valid: [{ canvas: CANVAS, agent: RESUMER }],
    invalid: [{ canvas: CANVAS }, { canvas: CANVAS, agent: RESUMER, after: 'x' }],
  },
  // Each resumes one listed to it as the world began; no other caller's list admits it.
  'session.resumeConversation': {
    fresh: ['revs'],
    valid: [],
    by: {
      you: [
        {
          canvas: CANVAS,
          agent: RESUMER,
          conversation: WORLD_KEPT[1].id,
          request: controlRequest(351),
        },
      ],
      'outside-write': [
        {
          canvas: CANVAS,
          agent: RESUMER,
          conversation: WORLD_KEPT[0].id,
          request: controlRequest(352),
        },
      ],
    },
    invalid: [
      { canvas: CANVAS, agent: RESUMER, conversation: '--resume' },
      { canvas: CANVAS, agent: RESUMER },
    ],
  },
  'session.options': {
    valid: [
      { canvas: CANVAS, adapter: CONTROL.adapter.id },
      { canvas: CANVAS, agent: CONTROL_AGENT, adapter: CONTROL.adapter.id },
    ],
    invalid: [
      { canvas: CANVAS, adapter: '' },
      { canvas: CANVAS, adapter: 'not-an-adapter' },
      { canvas: CANVAS, adapter: CONTROL.adapter.id, extra: true },
    ],
  },
  // Your /mcp, typed in its composer: recorded, never sent (yours alone, a view's).
  'session.viewCommand': {
    fresh: ['revs', 'id'],
    valid: [{ canvas: CANVAS, agent: CONTROL_AGENT, text: '/mcp', request: controlRequest(354) }],
    invalid: [
      { canvas: CANVAS, agent: CONTROL_AGENT, text: '' },
      { canvas: CANVAS, agent: CONTROL_AGENT, text: '/not-a-panel' },
      { canvas: CANVAS, agent: 'helper', text: '/mcp' },
    ],
  },
  'session.mcpServers': {
    valid: [{ canvas: CANVAS, agent: CONTROL_AGENT }],
    invalid: [{ canvas: CANVAS }, { canvas: CANVAS, agent: CONTROL_AGENT, server: 'x' }],
  },
  'session.changeMcpServer': {
    fresh: ['revs'],
    valid: [
      {
        canvas: CANVAS,
        agent: CONTROL_AGENT,
        server: CONTROL_SERVER,
        change: 'reconnect',
        request: controlRequest(353),
      },
    ],
    meetsRule: {
      'corral-mcp': {
        canvas: CANVAS,
        agent: CONTROL_AGENT,
        server: 'corrallm-server',
        change: 'disable',
        request: controlRequest(355),
      },
    },
    invalid: [
      { canvas: CANVAS, agent: CONTROL_AGENT, server: CONTROL_SERVER, change: 'delete' },
      { canvas: CANVAS, agent: CONTROL_AGENT, server: '', change: 'reconnect' },
      { canvas: CANVAS, agent: CONTROL_AGENT, server: 'x'.repeat(201), change: 'reconnect' },
    ],
  },
  'session.rewindPreview': {
    valid: [{ canvas: CANVAS, agent: CONTROL_AGENT, message: CONTROL_MESSAGE }],
    invalid: [{ canvas: CANVAS, agent: CONTROL_AGENT, message: '--help' }],
  },
  'session.rewind': {
    valid: [
      {
        canvas: CANVAS,
        agent: CONTROL_AGENT,
        message: CONTROL_MESSAGE,
        restore: 'code',
        request: controlRequest(308),
      },
    ],
    invalid: [
      { canvas: CANVAS, agent: CONTROL_AGENT, message: CONTROL_MESSAGE, restore: 'everything' },
    ],
    meetsRule: {
      'restore-code': {
        canvas: CANVAS,
        agent: CONTROL_AGENT,
        message: CONTROL_MESSAGE,
        restore: 'code',
        request: controlRequest(309),
      },
    },
    fresh: ['proposed', 'revs'],
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
  // B11a C10: whoever reads an agent's session reads its handoff (none kept here: null).
  'session.handoff': {
    valid: [{ canvas: CANVAS, agent: 'peer' }],
    invalid: [{ canvas: CANVAS }, { canvas: CANVAS, agent: '' }, { agent: 'peer', text: 'x' }],
  },
  'session.interrupt': {
    valid: [{ canvas: CANVAS, agent: 'helper', request: request(30) }],
    invalid: [{ canvas: CANVAS }, { canvas: CANVAS, agent: 'helper', extra: true }],
  },
  'run.get': { valid: [{ canvas: CANVAS }], invalid: [{ canvas: 'invalid' }] },
  'run.pause': {
    fresh: ['revs'],
    valid: TARGETS.map((args, i) => ({ ...args, request: request(40 + i) })),
    invalid: [
      { canvas: CANVAS, target: {} },
      { canvas: CANVAS, target: { agent: '' } },
    ],
  },
  'run.kill': {
    fresh: ['revs'],
    valid: TARGETS.map((args, i) => ({ ...args, request: request(50 + i) })),
    invalid: [{ canvas: CANVAS, target: { agent: 'helper', group: 'lead' } }],
  },
  'run.unpause': {
    fresh: ['revs'],
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
      { topic: 'run', canvas: CANVAS, request: controlRequest(310) },
      { topic: 'sessions', canvas: CANVAS, request: controlRequest(311) },
      { topic: 'session', canvas: CANVAS, agent: CONTROL_AGENT, request: controlRequest(312) },
      { topic: 'messages', canvas: CANVAS, request: controlRequest(313) },
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
      { topic: 'run', canvas: CANVAS, request: controlRequest(320) },
      { topic: 'sessions', canvas: CANVAS, request: controlRequest(321) },
      { topic: 'session', canvas: CANVAS, agent: CONTROL_AGENT, request: controlRequest(322) },
      { topic: 'messages', canvas: CANVAS, request: controlRequest(323) },
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
    valid: [{ canvas: CANVAS }],
    // Several core-owned runtimes are open in this world: the canvas cannot be inferred.
    invalid: [{}, { canvas: 'nope' }, { canvas: CANVAS, file: '/etc/passwd' }],
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
  // The run's controls, last: nothing before them starts the canvas's run. A token starts it
  // first, on a run no one began; yours starts it afresh (Run again); once you stopped it (the
  // world's `meeting`), a token's start is refused. Then resume (of a run going, which changes
  // nothing; of yours, after you stopped it), each party's Go on now of its napper, the
  // spender's usage hold (yours alone), and Stop.
  'run.start': {
    fresh: ['revs'],
    valid: [{ canvas: CANVAS, request: controlRequest(330) }],
    by: { 'outside-write': [{ canvas: CANVAS, request: controlRequest(331) }] },
    invalid: [{ canvas: 'nope' }, { canvas: CANVAS, from: 'top' }],
    meetsRule: { sticky: { canvas: CANVAS, request: controlRequest(332) } },
  },
  'run.resume': {
    fresh: ['revs'],
    valid: [{ canvas: CANVAS, request: controlRequest(333) }],
    by: { 'outside-write': [{ canvas: CANVAS, request: controlRequest(334) }] },
    invalid: [{ canvas: 'nope' }, { canvas: CANVAS, restart: true }],
    meetsRule: { sticky: { canvas: CANVAS, request: controlRequest(335) } },
  },
  'run.goOn': {
    fresh: ['revs'],
    valid: [],
    by: Object.fromEntries(
      (['you', 'lead', 'outside-write'] as const).map((party, i) => [
        party,
        [
          {
            canvas: CANVAS,
            agent: `sleeper-${party === 'outside-write' ? 'outside' : party}`,
            item: 'nap',
            request: controlRequest(336 + i),
          },
        ],
      ]),
    ),
    invalid: [
      { canvas: CANVAS, agent: 'sleeper-you' },
      { canvas: CANVAS, agent: 'sleeper-you', item: 'nap', until: -1 },
      { canvas: CANVAS, agent: 'sleeper-you', item: 'nap', until: 'soon' },
    ],
    meetsRule: {
      'human-choice': {
        canvas: CANVAS,
        agent: 'spender',
        item: 'spend',
        request: controlRequest(339),
      },
    },
  },
  'run.stop': {
    fresh: ['revs'],
    valid: [{ canvas: CANVAS, request: controlRequest(340) }],
    invalid: [{ canvas: 'nope' }, { canvas: CANVAS, agent: 'helper' }],
  },
  // Last: it pauses every agent of every canvas the world runs, as you (B14 C3). Main's native
  // menus call it, never a window or a token.
  'run.pauseAll': {
    fresh: ['revs'],
    valid: [{ request: controlRequest(360) }],
    invalid: [{ canvas: CANVAS }, { agent: 'helper' }, 'all', null],
  },
};

/** The agents each agent doesn't reach on the canvas, as far as an op lets it. */
const AGENTS_OUT_OF_REACH: Readonly<Record<string, Partial<Record<Reach, readonly string[]>>>> = {
  // A lead's write reaches its team; its read, its links too.
  lead: {
    team: ['worker', 'apprentice', 'peer', 'shell', 'stranger'],
    linked: ['apprentice', 'stranger'],
  },
  // A worker reaches the agents linked to it, never its own children; or, for its own, itself.
  worker: {
    linked: ['helper', 'apprentice', 'stranger'],
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
  // Worktree removal is human-only; no token has a grant to any workspace record.
  WorktreeId: () => ['1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4aff'],
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
  EntryId: () => ['1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4aff'],
  TaskId: () => ['missing-task'],
  // A conversation no list showed the caller, kept or not (B11 §7).
  ConversationId: () => ['0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3eff', WORLD_KEPT[1].id],
  // A Needs item that isn't there.
  NeedId: () => ['proposal/1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4aff'],
};
