import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type { AdapterId, ConnectionId } from '../../shared/adapter';
import { newCanvasId } from '../../shared/canvas';
import type { CanvasId } from '../../shared/canvas';
import type { FilesRewind, SessionEvent, SessionOptions } from '../../shared/session';
import type { TerminalEvent } from '../../shared/terminal';
import type { Store } from '../core/store/store';
import { openTestStore, readOnDisk } from '../core/store/test-store';
import { CanvasMemory, conversationsIn, PROJECT_WORKSPACE } from '../memory';
import type { ConversationsByAdapter, Remembered } from '../memory';
import type { Connector, LiveSession, SessionHost, SessionSpec } from './connector';
import { unavailable } from './connector';
import { FakeConnector } from './fake';
import { CATALOG } from './adapters';
import { SessionManager, STALLED_INTERRUPT_MS } from './manager';
import type { SessionManagerDeps } from './manager';
import type { Conversations } from './adapter';
import { quotePath } from './terminal/drop';
import { ProjectDirectories } from '../core/workspaces/resolver';
import type { WorkingDirectory } from '../core/workspaces/resolver';
import { mintTrustedPath } from '../core/host';

const OPTIONS: SessionOptions = { connection: 'claude-code.sdk', model: null, mode: null };
/** Conversations Claude Code kept, and one a rewind forked: session ids, as the CLI's are. */
const KEPT_ONE = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e31';
const KEPT_TWO = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e32';
const FORKED = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e33';
/** The conversation a rewinding agent's session remembers. */
const REMEMBERED = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e34';
/** Who lists conversations, and resumes one listed: a window. */
const CALLER = 'window:1';

let dir: string;
let store: Store;
let memory: CanvasMemory;
let fake: FakeConnector;
let terminal: FakeConnector;
/** Each canvas's project folder, as project.ts would know it. */
let projects: Map<CanvasId, string>;
let workspaces: Map<string, WorkingDirectory>;
/** What each canvas's windows heard: agent, connection and event. */
let heard: Map<CanvasId, [string, ConnectionId, SessionEvent][]>;
/** What each canvas's terminal views heard: agent and event. */
let shown: Map<CanvasId, [string, TerminalEvent][]>;
let environment: () => Promise<Record<string, string>>;
type Kept = Required<Conversations>;
let adapters: Map<string, AdapterId>;
/** The conversations Claude Code kept for each folder, as the Agent SDK lists and forks them. */
let listKept: Mock<Kept['list']>;
let before: Mock<Kept['before']>;
let fork: Mock<Kept['fork']>;

function directories() {
  const legacy = new ProjectDirectories({
    of: (canvas) => {
      const folder = projects.get(canvas);
      return folder === undefined ? undefined : mintTrustedPath(folder);
    },
    onAvailability: () => () => undefined,
  });
  return {
    projectRoot: (canvas: CanvasId) => legacy.projectRoot(canvas),
    onAvailability: (canvas: CanvasId, listener: () => void) =>
      legacy.onAvailability(canvas, listener),
    workingDirectory: (canvas: CanvasId, agent: string) =>
      Promise.resolve(workspaces.get(agent)).then(
        (found) => found ?? legacy.workingDirectory(canvas, agent as never),
      ),
  };
}

function manager(
  connectors: Partial<Record<ConnectionId, Connector>> = {},
  conversations: SessionManagerDeps['conversations'] = {
    'claude-code': { list: listKept, before, fork },
  },
  options?: SessionManagerDeps['options'],
  sending?: SessionManagerDeps['sending'],
) {
  return new SessionManager({
    ...(sending === undefined ? {} : { sending }),
    catalog: CATALOG,
    connectors: { 'claude-code.sdk': fake, 'claude-code.terminal': terminal, ...connectors },
    environment: () => environment(),
    conversations,
    ...(options === undefined ? {} : { options }),
    adapterOf: (_canvas, agent) => Promise.resolve(adapters.get(agent) ?? 'claude-code'),
    directories: directories(),
    memory,
    emit: (canvas, agentId, connection, event) => {
      const list = heard.get(canvas) ?? [];
      list.push([agentId, connection, event]);
      heard.set(canvas, list);
    },
    terminal: (canvas, agentId, event) => {
      const list = shown.get(canvas) ?? [];
      list.push([agentId, event]);
      shown.set(canvas, list);
    },
  });
}

/** What `canvas`'s windows heard, as event types (with the agent), for a quick look. */
const types = (canvas: CanvasId) =>
  (heard.get(canvas) ?? []).map(([agent, , event]) => `${agent}:${event.type}`);

/** A canvas whose agents work in /work/app. */
function shownCanvas() {
  const canvas = newCanvasId();
  projects.set(canvas, '/work/app');
  return canvas;
}

/**
 * What the canvas remembers of its agents' conversations in each CLI, run in its project folder
 * (where every agent runs until workspaces are resolved).
 */
const conversations = async (canvas: CanvasId) =>
  conversationsIn(await memory.get(canvas), PROJECT_WORKSPACE);
/** Conversations kept as run in the project folder. */
const inProject = (byAdapter: ConversationsByAdapter): Remembered['conversations'] => ({
  [PROJECT_WORKSPACE]: byAdapter,
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-sessions-'));
  store = await openTestStore(dir);
  memory = new CanvasMemory(store);
  fake = new FakeConnector();
  terminal = new FakeConnector();
  projects = new Map();
  workspaces = new Map();
  adapters = new Map();
  heard = new Map();
  shown = new Map();
  environment = () => Promise.resolve({ PATH: '/usr/bin' });
  before = vi.fn<Kept['before']>().mockResolvedValue('reply-1');
  fork = vi.fn<Kept['fork']>().mockResolvedValue(FORKED);
  listKept = vi.fn(() =>
    Promise.resolve([
      { id: KEPT_TWO, title: 'Add a cart', modified: 2000 },
      { id: KEPT_ONE, title: 'Fix the login bug', modified: 1000 },
    ]),
  );
});
afterEach(async () => {
  await memory.flush();
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

describe('SessionManager', () => {
  it.each([true, false, undefined])(
    'captures the trusted default at each Terminal launch (asks: %s)',
    async (asks) => {
      const read = vi.fn(() =>
        Promise.resolve({
          models: [],
          defaults: {
            model: null,
            mode: null,
            effort: null,
            ...(asks === undefined ? {} : { asks }),
          },
        }),
      );
      const sessions = manager({}, undefined, { 'claude-code': read });
      const canvas = shownCanvas();
      try {
        await sessions.start(canvas, 'a', { ...OPTIONS, connection: 'claude-code.terminal' });
        expect(terminal.started[0]).toMatchObject({ cwd: '/work/app', mode: null });
        if (asks === undefined) expect(terminal.started[0]).not.toHaveProperty('startupAsks');
        else expect(terminal.started[0]).toHaveProperty('startupAsks', asks);
        expect(read).toHaveBeenCalledWith({ cwd: '/work/app', env: { PATH: '/usr/bin' } });
        await sessions.closeEverything();
        await sessions.start(canvas, 'a', { ...OPTIONS, connection: 'claude-code.terminal' });
        expect(read).toHaveBeenCalledTimes(2);
      } finally {
        await sessions.closeEverything();
      }
    },
  );

  it('keeps an explicit Terminal start mode without reading a default', async () => {
    const read = vi.fn(() => Promise.reject(new Error('not read')));
    const sessions = manager({}, undefined, { 'claude-code': read });
    try {
      await sessions.start(shownCanvas(), 'a', {
        ...OPTIONS,
        connection: 'claude-code.terminal',
        mode: 'manual',
      });
      expect(read).not.toHaveBeenCalled();
      expect(terminal.started[0]).toMatchObject({ mode: 'manual' });
      expect(terminal.started[0]).not.toHaveProperty('startupAsks');
    } finally {
      await sessions.closeEverything();
    }
  });

  it.each(['rejects', 'throws'])(
    'starts a Terminal with unknown permissions when its default reader %s',
    async (kind) => {
      const read = () => {
        if (kind === 'throws') throw new Error('unreadable');
        return Promise.reject(new Error('unreadable'));
      };
      const sessions = manager({}, undefined, { 'claude-code': read });
      try {
        await sessions.start(shownCanvas(), 'a', {
          ...OPTIONS,
          connection: 'claude-code.terminal',
        });
        expect(terminal.started[0]).not.toHaveProperty('startupAsks');
      } finally {
        await sessions.closeEverything();
      }
    },
  );

  it('owns a launch while its asynchronous directory lookup is pending, so close waits for it', async () => {
    const sessions = manager();
    const canvas = shownCanvas();
    const directory = Promise.withResolvers<WorkingDirectory>();
    const resolve = vi
      .spyOn(ProjectDirectories.prototype, 'workingDirectory')
      .mockReturnValue(directory.promise);
    const starting = sessions.start(canvas, 'a', OPTIONS);
    let closing: Promise<void> | undefined;
    try {
      await vi.waitFor(() => {
        expect(resolve).toHaveBeenCalledOnce();
      });
      let closed = false;
      closing = sessions.closeEverything().then(() => {
        closed = true;
      });
      await new Promise<void>((done) => setImmediate(done));
      expect(closed).toBe(false);
    } finally {
      directory.resolve({
        state: 'ready',
        cwd: mintTrustedPath('/work/app'),
        workspace: null,
        generation: 0,
        branch: null,
      });
      await starting;
      await closing;
      await sessions.closeEverything();
      resolve.mockRestore();
    }
  });
  it.each([
    ['claude-code.sdk', 'claude-code.terminal', 'claude-code'],
    ['codex.app-server', 'codex.terminal', 'codex'],
  ] as const)(
    'remembers the launched role for %s and shares it across its connections',
    async (connection, other, cli) => {
      const codex = new FakeConnector({ adapter: 'codex' });
      const sessions = manager({ 'codex.app-server': codex, 'codex.terminal': codex });
      const connector = connection === 'claude-code.sdk' ? fake : codex;
      const canvas = shownCanvas();
      const role = 'Review changes';
      const fingerprint = createHash('sha256').update(role).digest('hex');
      await sessions.start(canvas, 'a', { ...OPTIONS, connection, role });
      expect(connector.started.at(-1)).not.toHaveProperty('roleChanged');
      await memory.flush();
      expect((await conversations(canvas))[cli]?.a?.role).toBe(fingerprint);
      // Its fingerprint, never its text.
      const kept = readOnDisk(dir, (disk) => disk.prepare('SELECT * FROM conversation').all());
      expect(JSON.stringify(kept)).toContain(fingerprint);
      expect(JSON.stringify(kept)).not.toContain(role);

      await sessions.start(canvas, 'a', { ...OPTIONS, connection: other, role });
      const next = connection === 'claude-code.sdk' ? terminal : codex;
      expect(next.started.at(-1)).toMatchObject({ resume: connector.ids[0], roleChanged: false });
      await sessions.closeEverything();

      // Load the fingerprint from disk, as after an app restart.
      await store.close();
      store = await openTestStore(dir);
      memory = new CanvasMemory(store);
      const after = manager({ 'codex.app-server': codex });
      for (const [currentRole, changed] of [
        [role, false],
        ['Updated role', true],
        [undefined, true],
        [undefined, false],
      ] as const) {
        await after.start(canvas, 'a', {
          ...OPTIONS,
          connection,
          ...(currentRole === undefined ? {} : { role: currentRole }),
        });
        expect(connector.started.at(-1)).toMatchObject({
          resume: connector.ids[0],
          roleChanged: changed,
        });
        await after.close(canvas, 'a');
      }
      await memory.flush();
      expect((await conversations(canvas))[cli]).toEqual({
        a: { id: connector.ids[0], role: 'none' },
      });
    },
  );

  it.each(['claude-code.sdk', 'codex.app-server'] as const)(
    'treats a %s conversation with no role fingerprint as changed once',
    async (connection) => {
      const id = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11';
      const adapter = connection === 'claude-code.sdk' ? 'claude-code' : 'codex';
      const canvas = shownCanvas();
      await memory.update(canvas, () => ({
        conversations: inProject({ [adapter]: { a: { id } } }),
      }));
      const codex = new FakeConnector({ adapter: 'codex' });
      const sessions = manager({ 'codex.app-server': codex });
      const connector = connection === 'claude-code.sdk' ? fake : codex;
      await sessions.start(canvas, 'a', { ...OPTIONS, connection });
      expect(connector.started.at(-1)).toMatchObject({ resume: id, roleChanged: true });
      await sessions.close(canvas, 'a');
      await sessions.start(canvas, 'a', { ...OPTIONS, connection });
      expect(connector.started.at(-1)).toMatchObject({ resume: id, roleChanged: false });
    },
  );

  it('captures the configured role only on launch and clears it on an exact-ID restart', async () => {
    let host: SessionHost | undefined;
    const sessions = manager({
      'claude-code.sdk': {
        start: (spec, given) => {
          host = given;
          return fake.start(spec, given);
        },
      },
    });
    const canvas = shownCanvas();
    await sessions.start(canvas, 'a', { ...OPTIONS, role: 'Review changes' });
    expect(fake.started.at(-1)).toMatchObject({ role: 'Review changes' });
    await sessions.start(canvas, 'a', { ...OPTIONS, role: 'Pending role' });
    expect(fake.started).toHaveLength(1);
    const cleared = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11';
    host?.remember(cleared);
    await memory.flush();
    expect((await conversations(canvas))['claude-code']).toEqual({
      a: { id: cleared, role: createHash('sha256').update('Review changes').digest('hex') },
    });
    await sessions.close(canvas, 'a');
    await sessions.start(canvas, 'a', { ...OPTIONS, role: 'Updated role' });
    expect(fake.started.at(-1)).toMatchObject({ role: 'Updated role', roleChanged: true });
    const resume = fake.started.at(-1)?.resume;
    expect(resume).not.toBeNull();
    await sessions.close(canvas, 'a');
    await sessions.start(canvas, 'a', OPTIONS);
    expect(fake.started.at(-1)?.resume).toBe(resume);
    expect(fake.started.at(-1)).toHaveProperty('roleChanged', true);
    expect(fake.started.at(-1)).not.toHaveProperty('role');
  });

  it('starts a fresh native conversation only for the chosen CLI, preserving other agents and histories', async () => {
    const codex = new FakeConnector({ adapter: 'codex' });
    const sessions = manager({ 'codex.app-server': codex });
    const canvas = shownCanvas();
    const options = { connection: 'codex.app-server', model: null, mode: 'auto' } as const;
    await sessions.start(canvas, 'a', OPTIONS);
    const claudeId = fake.ids[0];
    await sessions.start(canvas, 'a', options);
    const oldCodexId = codex.ids[0];
    await sessions.start(canvas, 'b', options);
    const otherCodexId = codex.ids[1];
    // Even a different live connection for this agent closes; its ID is retained.
    await sessions.start(canvas, 'a', OPTIONS);
    await sessions.fresh(canvas, 'a', 'codex');
    await expect(sessions.send(canvas, 'a', { id: 'm', text: 'Hello' })).rejects.toThrow(
      /not running/,
    );
    const disk = new CanvasMemory(store);
    expect(conversationsIn(await disk.get(canvas), PROJECT_WORKSPACE)).toEqual({
      'claude-code': { a: { id: claudeId, role: 'none' } },
      codex: { b: { id: otherCodexId, role: 'none' } },
    });
    // No launch or synthetic turn is part of fresh; the explicit next start supplies the new role.
    expect(codex.started).toHaveLength(2);
    await sessions.start(canvas, 'a', { ...options, role: 'Updated review role' });
    expect(codex.started.at(-1)).toMatchObject({ resume: null, role: 'Updated review role' });
    expect(codex.ids.at(-1)).not.toBe(oldCodexId);
    await sessions.start(canvas, 'a', OPTIONS);
    expect(fake.started.at(-1)).toMatchObject({ resume: claudeId, roleChanged: false });
    await sessions.close(canvas, 'b');
    await sessions.start(canvas, 'b', options);
    expect(codex.started.at(-1)).toMatchObject({ resume: otherCodexId, roleChanged: false });
  });

  it('waits for graceful close before forgetting a native conversation, even if it was already closing', async () => {
    let release: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = vi.fn(() => closed);
    const sessions = manager({
      'claude-code.terminal': {
        start: async (spec, host) => {
          const session = await terminal.start(spec, host);
          session.close = close;
          return session;
        },
      },
    });
    const canvas = shownCanvas();
    await sessions.start(canvas, 'a', { ...OPTIONS, connection: 'claude-code.terminal' });
    const id = terminal.ids[0];
    await memory.flush();
    const closing = sessions.close(canvas, 'a');
    const fresh = sessions.fresh(canvas, 'a', 'claude-code');
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledOnce();
    });
    expect((await conversations(canvas))['claude-code']?.a?.id).toBe(id);
    release?.();
    await Promise.all([closing, fresh]);
    expect(
      conversationsIn(await new CanvasMemory(store).get(canvas), PROJECT_WORKSPACE)['claude-code']
        ?.a,
    ).toBeUndefined();
  });

  it('clears only its own canvas’s conversation, whatever another canvas does meanwhile', async () => {
    let release: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = vi.fn(() => closed);
    const sessions = manager({
      'claude-code.terminal': {
        start: async (spec, host) => {
          const session = await terminal.start(spec, host);
          session.close = close;
          return session;
        },
      },
    });
    const canvas = shownCanvas();
    const other = shownCanvas();
    await sessions.start(canvas, 'a', { ...OPTIONS, connection: 'claude-code.terminal' });
    const otherId = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e12';
    await memory.update(other, () => ({
      conversations: inProject({ 'claude-code': { a: { id: otherId } } }),
    }));
    const fresh = sessions.fresh(canvas, 'a', 'claude-code');
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledOnce();
    });
    // The window shows the other canvas now, and its project changes.
    const closing = sessions.closeCanvas(canvas);
    projects.set(other, '/work/other');
    await sessions.start(other, 'b', OPTIONS);
    release?.();
    await Promise.all([fresh, closing]);
    const disk = new CanvasMemory(store);
    expect(
      conversationsIn(await disk.get(canvas), PROJECT_WORKSPACE)['claude-code']?.a,
    ).toBeUndefined();
    expect(conversationsIn(await disk.get(other), PROJECT_WORKSPACE)['claude-code']?.a?.id).toBe(
      otherId,
    );
    await sessions.start(other, 'a', OPTIONS);
    expect(fake.started.at(-1)?.resume).toBe(otherId);
  });

  it('surfaces a failed durable conversation clear before any fresh launch', async () => {
    const sessions = manager();
    const canvas = shownCanvas();
    await sessions.start(canvas, 'a', OPTIONS);
    await memory.flush();
    const flush = vi.spyOn(memory, 'flush').mockRejectedValueOnce(new Error('Disk unavailable'));
    await expect(sessions.fresh(canvas, 'a', 'claude-code')).rejects.toThrow('Disk unavailable');
    expect(fake.started).toHaveLength(1);
    flush.mockRestore();
  });

  it('starts a session in the canvas’s project folder; its events go to that canvas’s windows', async () => {
    const sessions = manager();
    const one = shownCanvas();
    const other = shownCanvas();
    await sessions.start(one, 'a', { ...OPTIONS, model: 'fast', mode: 'acceptEdits' });
    expect(fake.started).toEqual([
      {
        agentId: 'a',
        cwd: '/work/app',
        env: { PATH: '/usr/bin' },
        model: 'fast',
        mode: 'acceptEdits',
        // No effort given: the user's own, else the model's default.
        effort: null,
        resume: null,
      },
    ]);
    expect(heard.get(one)?.[0]).toEqual([
      'a',
      'claude-code.sdk',
      { type: 'started', model: 'fast', mode: 'acceptEdits', models: expect.any(Array) as unknown },
    ]);

    await sessions.send(one, 'a', { id: 'm1', text: 'Hello' });
    await vi.waitFor(() => {
      expect(types(one).at(-1)).toBe('a:end');
    });
    expect(types(one)).toContain('a:user');
    expect(heard.has(other)).toBe(false);
  });

  it('refuses to start without a project folder, and runs no CLI', async () => {
    const sessions = manager();
    await expect(sessions.start(newCanvasId(), 'a', OPTIONS)).rejects.toThrow(
      /Choose a project folder/,
    );
    expect(fake.started).toEqual([]);
  });

  it('says why a connection cannot start, and forgets the attempt', async () => {
    const sessions = manager({ 'claude-code.terminal': unavailable('Claude in a terminal') });
    const canvas = shownCanvas();
    await expect(
      sessions.start(canvas, 'a', { ...OPTIONS, connection: 'claude-code.terminal' }),
    ).rejects.toThrow("corrallm can't run Claude in a terminal yet.");
    await expect(sessions.send(canvas, 'a', { id: 'm', text: 'Hi' })).rejects.toThrow(
      /not running/,
    );
  });

  it('starts an agent once; another connection takes over, resuming the same session', async () => {
    const sessions = manager();
    const canvas = shownCanvas();
    await Promise.all([sessions.start(canvas, 'a', OPTIONS), sessions.start(canvas, 'a', OPTIONS)]);
    expect(fake.started).toHaveLength(1);

    await sessions.start(canvas, 'a', { ...OPTIONS, connection: 'claude-code.terminal' });
    expect(fake.started[0]?.resume).toBeNull();
    expect(terminal.started[0]?.resume).toBe(fake.ids[0]);
    expect(fake.ids).toHaveLength(1);
  });

  it('remembers each agent’s session with the canvas, and resumes it after a restart', async () => {
    const before = manager();
    const canvas = shownCanvas();
    await before.start(canvas, 'a', OPTIONS);
    await before.closeEverything();
    const claude = (await conversations(canvas))['claude-code'];
    expect(Object.keys(claude ?? {})).toEqual(['a']);

    // The app starts again, and the canvas opens.
    const after = manager();
    await after.start(canvas, 'a', OPTIONS);
    expect(fake.started.at(-1)?.resume).toBe(claude?.a?.id);
    // Another agent starts afresh, and so does the agent of another canvas.
    await after.start(canvas, 'b', OPTIONS);
    expect(fake.started.at(-1)?.resume).toBeNull();
    await after.start(shownCanvas(), 'a', OPTIONS);
    expect(fake.started.at(-1)?.resume).toBeNull();
  });

  it('runs two canvases’ sessions independently, each with its own conversations', async () => {
    const sessions = manager();
    const one = shownCanvas();
    const two = shownCanvas();
    projects.set(two, '/work/other');
    await sessions.start(one, 'a', OPTIONS);
    await sessions.start(two, 'a', { ...OPTIONS, mode: 'acceptEdits' });
    // The same agent id on two canvases: two sessions, in each canvas's folder.
    expect(fake.started.map(({ cwd, resume }) => ({ cwd, resume }))).toEqual([
      { cwd: '/work/app', resume: null },
      { cwd: '/work/other', resume: null },
    ]);
    await sessions.send(two, 'a', { id: 'm', text: 'Hi' });
    await vi.waitFor(() => {
      expect(types(two).at(-1)).toBe('a:end');
    });
    expect(types(one)).toEqual(['a:started']);

    // One canvas no longer shown: the other's session goes on.
    await sessions.closeCanvas(one);
    await expect(sessions.send(one, 'a', { id: 'n', text: 'Hi' })).rejects.toThrow(/not running/);
    await sessions.send(two, 'a', { id: 'o', text: 'Again' });
    expect((await conversations(one))['claude-code']?.a?.id).toBe(fake.ids[0]);
    expect((await conversations(two))['claude-code']?.a?.id).toBe(fake.ids[1]);
  });

  it('starts an agent with the settings the renderer gives, else the user’s own', async () => {
    const before = manager();
    const canvas = shownCanvas();
    await before.start(canvas, 'a', { ...OPTIONS, model: 'fast', mode: 'plan', effort: 'high' });
    expect(fake.started.at(-1)).toMatchObject({ model: 'fast', mode: 'plan', effort: 'high' });
    await before.setModel(canvas, 'a', 'slow');
    await before.closeEverything();

    // After a restart: what the renderer gives (its agent's settings, saved in the canvas's
    // file), and nothing main kept. Nothing given: the user's own defaults.
    const after = manager();
    await after.start(canvas, 'a', OPTIONS);
    expect(fake.started.at(-1)).toMatchObject({ model: null, mode: null, effort: null });
    await memory.flush();
    expect(await memory.get(canvas)).toEqual({
      conversations: {
        [PROJECT_WORKSPACE]: { 'claude-code': { a: { id: fake.ids[0], role: 'none' } } },
      },
    });
  });

  it('never starts an agent bypassing permissions because it did before', async () => {
    const sessions = manager();
    const canvas = shownCanvas();
    await sessions.start(canvas, 'a', { ...OPTIONS, mode: 'plan' });
    await sessions.setMode(canvas, 'a', 'bypassPermissions');
    await sessions.close(canvas, 'a');
    await sessions.start(canvas, 'a', OPTIONS);
    expect(fake.started.at(-1)?.mode).toBeNull();
  });

  it('keeps an agent’s Codex thread apart from its Claude Code session, each resumed in turn', async () => {
    const codex = new FakeConnector({ adapter: 'codex' });
    const sessions = manager({ 'codex.app-server': codex, 'codex.terminal': codex });
    const canvas = shownCanvas();
    await sessions.start(canvas, 'a', OPTIONS);
    // A Claude Code session's id means nothing to Codex: its thread starts afresh.
    await sessions.start(canvas, 'a', {
      connection: 'codex.app-server',
      model: null,
      mode: 'auto',
    });
    expect(codex.started[0]).toMatchObject({ resume: null, mode: 'auto' });
    // Codex in a terminal resumes the same thread; Claude Code its own session.
    await sessions.start(canvas, 'a', {
      connection: 'codex.terminal',
      model: null,
      mode: 'auto',
    });
    expect(codex.started[1]?.resume).toBe(codex.ids[0]);
    await sessions.start(canvas, 'a', OPTIONS);
    expect(fake.started[1]?.resume).toBe(fake.ids[0]);
    await sessions.closeEverything();
    await memory.flush();
    expect(await conversations(canvas)).toEqual({
      'claude-code': { a: { id: fake.ids[0], role: 'none' } },
      codex: { a: { id: codex.ids[0], role: 'none' } },
    });

    // After a restart, each is resumed by its own CLI.
    const after = manager({ 'codex.app-server': codex });
    await after.start(canvas, 'a', { connection: 'codex.app-server', model: null, mode: 'plan' });
    expect(codex.started.at(-1)?.resume).toBe(codex.ids[0]);
  });

  it('starts and switches a session only in modes of its CLI', async () => {
    const codex = new FakeConnector({ adapter: 'codex' });
    const sessions = manager({ 'codex.app-server': codex });
    const canvas = shownCanvas();
    await expect(
      sessions.start(canvas, 'a', { connection: 'codex.app-server', model: null, mode: 'manual' }),
    ).rejects.toThrow(/mode/);
    await sessions.start(canvas, 'a', {
      connection: 'codex.app-server',
      model: null,
      mode: 'auto',
    });
    await sessions.setMode(canvas, 'a', 'full-access');
    expect(types(canvas)).toContain('a:mode');
    await expect(sessions.setMode(canvas, 'a', 'acceptEdits')).rejects.toThrow(/mode/);
  });

  it('says a connection corrallm cannot run', async () => {
    const sessions = manager();
    await expect(
      sessions.start(shownCanvas(), 'a', {
        connection: 'codex.app-server',
        model: null,
        mode: 'auto',
      }),
    ).rejects.toThrow(/can't run/);
  });

  it('passes the user’s requests on to the session, and rejects them for an agent without one', async () => {
    const live = {
      send: vi.fn<LiveSession['send']>().mockResolvedValue(undefined),
      answer: vi.fn<LiveSession['answer']>().mockResolvedValue(undefined),
      interrupt: vi.fn<LiveSession['interrupt']>().mockResolvedValue(undefined),
      setMode: vi.fn<LiveSession['setMode']>().mockResolvedValue(undefined),
      setModel: vi.fn<LiveSession['setModel']>().mockResolvedValue(undefined),
      close: vi.fn<LiveSession['close']>().mockResolvedValue(undefined),
    };
    const sessions = manager({ 'claude-code.sdk': { start: () => Promise.resolve(live) } });
    const canvas = shownCanvas();
    await expect(sessions.interrupt(canvas, 'a')).rejects.toThrow(/not running/);
    await sessions.start(canvas, 'a', OPTIONS);
    await sessions.send(canvas, 'a', { id: 'm', text: 'Hi' });
    await sessions.answer(canvas, 'a', 'p', { kind: 'permission', answer: 'once' });
    await sessions.interrupt(canvas, 'a');
    await sessions.setMode(canvas, 'a', 'plan');
    await sessions.setModel(canvas, 'a', 'opus');
    expect(live.send).toHaveBeenCalledWith({ id: 'm', text: 'Hi' });
    expect(live.answer).toHaveBeenCalledWith('p', { kind: 'permission', answer: 'once' });
    expect(live.interrupt).toHaveBeenCalled();
    expect(live.setMode).toHaveBeenCalledWith('plan');
    expect(live.setModel).toHaveBeenCalledWith('opus');
    await sessions.close(canvas, 'a');
    expect(live.close).toHaveBeenCalled();
    await expect(sessions.send(canvas, 'a', { id: 'n', text: 'Again' })).rejects.toThrow(
      /not running/,
    );
  });

  it('never sends what an interrupt stopped on its way to the CLI, ending its turn taken back', async () => {
    const live = {
      send: vi.fn<LiveSession['send']>().mockResolvedValue(undefined),
      answer: () => Promise.resolve(),
      interrupt: vi.fn<LiveSession['interrupt']>().mockResolvedValue(undefined),
      setMode: () => Promise.resolve(),
      setModel: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    // As a withdrawal note's own turn holds the command it goes before (core/delivery/withdrawals.ts).
    const gates: (() => void)[] = [];
    const sending: NonNullable<SessionManagerDeps['sending']> = async (
      _canvas,
      _agent,
      message,
      send,
      stopped,
    ) => {
      await new Promise<void>((resolve) => gates.push(resolve));
      if (stopped()) return false;
      await send(message);
      return true;
    };
    const sessions = manager(
      { 'claude-code.sdk': { start: () => Promise.resolve(live) } },
      undefined,
      undefined,
      sending,
    );
    const canvas = shownCanvas();
    await sessions.start(canvas, 'a', OPTIONS);
    const ends = () =>
      (heard.get(canvas) ?? []).flatMap(([, , event]) => (event.type === 'end' ? [event] : []));
    const sent = async (id: string, interrupt?: () => Promise<unknown>) => {
      const sending = sessions.send(canvas, 'a', { id, text: '/review' });
      await vi.waitFor(() => {
        expect(gates).toHaveLength(Number(id));
      });
      await interrupt?.();
      gates.at(-1)?.();
      await sending;
    };
    // An interrupt before a send stops none of it, nor one whose turn was no longer current, nor a
    // stalled turn's interrupted to be resent: what it held goes as that turn ends.
    await sessions.interrupt(canvas, 'a');
    await sent('1');
    await sent('2', () => sessions.interruptIf(canvas, 'a', () => false));
    await sent('3', () => sessions.interruptIf(canvas, 'a', () => true, true));
    expect(live.send.mock.calls).toEqual(['1', '2', '3'].map((id) => [{ id, text: '/review' }]));
    expect(ends()).toEqual([]);
    // One while it is on its way, a Stop's or a stalled turn's: never sent, its turn ended.
    await sent('4', () => sessions.interrupt(canvas, 'a'));
    await sent('5', () => sessions.interruptIf(canvas, 'a', () => true));
    expect(live.send).toHaveBeenCalledTimes(3);
    expect(live.interrupt).toHaveBeenCalledTimes(4);
    expect(ends()).toEqual(
      ['4', '5'].map((id) => ({
        type: 'end',
        messages: [id],
        seconds: expect.any(Number) as number,
        result: { status: 'cancelled', reason: 'taken-back' },
      })),
    );
  });

  it('shows and changes a session’s MCP servers, where its connection shows them', async () => {
    const servers = [{ name: 'github', status: 'connected' as const }];
    const live = {
      send: () => Promise.resolve(),
      answer: () => Promise.resolve(),
      interrupt: () => Promise.resolve(),
      setMode: () => Promise.resolve(),
      setModel: () => Promise.resolve(),
      close: () => Promise.resolve(),
      mcpServers: vi.fn<NonNullable<LiveSession['mcpServers']>>().mockResolvedValue(servers),
      changeMcpServer: vi
        .fn<NonNullable<LiveSession['changeMcpServer']>>()
        .mockResolvedValue(undefined),
    };
    const sessions = manager({ 'claude-code.sdk': { start: () => Promise.resolve(live) } });
    const canvas = shownCanvas();
    await expect(sessions.mcpServers(canvas, 'a')).rejects.toThrow(/not running/);
    await sessions.start(canvas, 'a', OPTIONS);
    await expect(sessions.mcpServers(canvas, 'a')).resolves.toEqual(servers);
    // A change answers with how they all are then.
    await expect(sessions.changeMcpServer(canvas, 'a', 'github', 'disable')).resolves.toEqual(
      servers,
    );
    expect(live.changeMcpServer).toHaveBeenCalledWith('github', 'disable');
    // A Terminal session's are its terminal's.
    await sessions.start(canvas, 'b', { ...OPTIONS, connection: 'claude-code.terminal' });
    await expect(sessions.mcpServers(canvas, 'b')).rejects.toThrow(/run \/mcp in its terminal/);
  });

  it('sets the effort and stops background tasks of a session that takes them, and of no other', async () => {
    // A Terminal session has neither: its terminal sets them.
    const terminal: LiveSession = {
      send: () => Promise.resolve(),
      answer: () => Promise.resolve(),
      interrupt: () => Promise.resolve(),
      setMode: () => Promise.resolve(),
      setModel: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    const live = {
      ...terminal,
      setEffort: vi.fn<NonNullable<LiveSession['setEffort']>>().mockResolvedValue(undefined),
      stopTask: vi.fn<NonNullable<LiveSession['stopTask']>>().mockResolvedValue(undefined),
    };
    const sessions = manager({
      'claude-code.sdk': { start: () => Promise.resolve(live) },
      'claude-code.terminal': { start: () => Promise.resolve(terminal) },
    });
    const canvas = shownCanvas();
    await sessions.start(canvas, 'a', OPTIONS);
    await sessions.setEffort(canvas, 'a', 'max');
    await sessions.stopTask(canvas, 'a', 'b1');
    expect(live.setEffort).toHaveBeenCalledWith('max');
    expect(live.stopTask).toHaveBeenCalledWith('b1');

    await sessions.start(canvas, 'b', { ...OPTIONS, connection: 'claude-code.terminal' });
    await expect(sessions.setEffort(canvas, 'b', 'low')).rejects.toThrow(/in its terminal/);
    await expect(sessions.stopTask(canvas, 'b', 'b1')).rejects.toThrow(/in its terminal/);
  });

  it('starts a session at the effort it is given', async () => {
    const setEffort = vi.fn<NonNullable<LiveSession['setEffort']>>().mockResolvedValue(undefined);
    const specs: SessionSpec[] = [];
    const plain: LiveSession = {
      send: () => Promise.resolve(),
      answer: () => Promise.resolve(),
      interrupt: () => Promise.resolve(),
      setMode: () => Promise.resolve(),
      setModel: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    const start = (spec: SessionSpec) => {
      specs.push(spec);
      return Promise.resolve({ ...plain, setEffort });
    };
    const sessions = manager({ 'claude-code.sdk': { start } });
    const canvas = shownCanvas();
    await sessions.start(canvas, 'a', { ...OPTIONS, effort: 'high' });
    expect(specs.at(-1)?.effort).toBe('high');
    await sessions.setEffort(canvas, 'a', 'low');
    expect(setEffort).toHaveBeenCalledWith('low');
  });

  it('reads what each CLI’s agents can be set to in the project folder, for the agents’ environment', async () => {
    const claude = vi.fn(() =>
      Promise.resolve({ models: [], defaults: { model: 'opus', effort: null, mode: null } }),
    );
    const sessions = new SessionManager({
      catalog: CATALOG,
      connectors: {},
      environment: () => Promise.resolve({ PATH: '/usr/bin', HOME: '/home/me' }),
      directories: directories(),
      adapterOf: () => Promise.resolve('claude-code'),
      memory,
      emit: () => undefined,
      options: { 'claude-code': claude },
    });
    const canvas = shownCanvas();
    expect((await sessions.settingsOptions(canvas, 'claude-code')).defaults.model).toBe('opus');
    expect(claude).toHaveBeenLastCalledWith({
      cwd: '/work/app',
      env: { PATH: '/usr/bin', HOME: '/home/me' },
    });
    // No project folder yet: the user's own settings, read from their home folder.
    await sessions.settingsOptions(newCanvasId(), 'claude-code');
    expect(claude).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: '/home/me' }));
    await expect(sessions.settingsOptions(canvas, 'codex')).rejects.toThrow(/can’t read/);
  });

  it('asks the working-directory resolver before a conversation rewind', async () => {
    const sessions = manager({
      'claude-code.sdk': {
        start: async (spec, host) => {
          const session = await fake.start(spec, host);
          host.remember(REMEMBERED);
          return Object.assign(session, { rewindFiles: () => Promise.resolve({ possible: true }) });
        },
      },
    });
    const canvas = shownCanvas();
    await sessions.start(canvas, 'a', OPTIONS);
    const resolve = vi.spyOn(ProjectDirectories.prototype, 'workingDirectory').mockResolvedValue({
      state: 'held',
      reason: 'no-project',
      sentence: 'Pick a folder first.',
    });
    try {
      // Refused with why, before anything is read or forked.
      await expect(sessions.rewind(canvas, 'a', 'message', 'conversation')).rejects.toThrow(
        'Pick a folder first.',
      );
      expect(resolve).toHaveBeenCalledWith(canvas, 'a');
      expect(before).not.toHaveBeenCalled();
      expect(fork).not.toHaveBeenCalled();
    } finally {
      resolve.mockRestore();
      await sessions.closeEverything();
    }
  });

  it('ends a canvas’s sessions once no window shows it, keeping its conversations', async () => {
    const sessions = manager();
    const canvas = shownCanvas();
    await sessions.start(canvas, 'a', OPTIONS);
    await sessions.closeCanvas(canvas);
    await expect(sessions.interrupt(canvas, 'a')).rejects.toThrow(/not running/);
    // Shown again: it resumes what it had.
    await sessions.start(canvas, 'a', OPTIONS);
    expect(fake.started.at(-1)?.resume).toBe(fake.ids[0]);
  });

  it('forgets the sessions when the project folder changes: they start afresh in the new one', async () => {
    const sessions = manager();
    const canvas = shownCanvas();
    await sessions.start(canvas, 'a', OPTIONS);
    projects.set(canvas, '/work/other');
    await sessions.projectChanged(canvas);
    expect(types(canvas).at(-1)).toBe('a:closed');
    expect(await memory.get(canvas)).toEqual({ conversations: {} });
    await sessions.start(canvas, 'a', OPTIONS);
    expect(fake.started.at(-1)).toMatchObject({ cwd: '/work/other', resume: null });
  });

  it('forgets a session that stops by itself, and drops what a replaced session says', async () => {
    let host: SessionHost | undefined;
    const live: LiveSession = {
      send: () => Promise.resolve(),
      answer: () => Promise.resolve(),
      interrupt: () => Promise.resolve(),
      setMode: () => Promise.resolve(),
      setModel: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    const sessions = manager({
      'claude-code.sdk': {
        start: (_spec, given) => {
          host = given;
          return Promise.resolve(live);
        },
      },
    });
    const canvas = shownCanvas();
    await sessions.start(canvas, 'a', OPTIONS);
    const first = host;
    first?.emit({ type: 'closed', error: 'It crashed' });
    expect(types(canvas)).toEqual(['a:closed']);
    await expect(sessions.send(canvas, 'a', { id: 'm', text: 'Hi' })).rejects.toThrow(
      /not running/,
    );

    // Started again: the first session's late words are not heard.
    await sessions.start(canvas, 'a', OPTIONS);
    first?.emit({ type: 'notice', id: 'n', level: 'info', text: 'Late' });
    expect(types(canvas)).toEqual(['a:closed']);
  });

  it('ends only a closed canvas’s sessions, and every session when the app quits', async () => {
    const closed: string[] = [];
    const connector: Connector = {
      start: (spec) =>
        Promise.resolve({
          send: () => Promise.resolve(),
          answer: () => Promise.resolve(),
          interrupt: () => Promise.resolve(),
          setMode: () => Promise.resolve(),
          setModel: () => Promise.resolve(),
          close: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            closed.push(spec.agentId);
          },
        }),
    };
    const sessions = manager({ 'claude-code.sdk': connector });
    const gone = shownCanvas();
    const staying = shownCanvas();
    await sessions.start(gone, 'a', OPTIONS);
    await sessions.start(staying, 'b', OPTIONS);
    await sessions.start(staying, 'c', OPTIONS);
    await sessions.closeCanvas(gone);
    expect(closed).toEqual(['a']);
    await sessions.closeEverything();
    expect(closed.sort()).toEqual(['a', 'b', 'c']);
  });

  it('joins a canvas’s teardown already started when the app then closes everything', async () => {
    let release: (() => void) | undefined;
    const closing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = vi.fn(() => closing);
    const live: LiveSession = {
      send: () => Promise.resolve(),
      answer: () => Promise.resolve(),
      interrupt: () => Promise.resolve(),
      setMode: () => Promise.resolve(),
      setModel: () => Promise.resolve(),
      close,
    };
    const sessions = manager({ 'claude-code.terminal': { start: () => Promise.resolve(live) } });
    const canvas = shownCanvas();
    await sessions.start(canvas, 'a', { ...OPTIONS, connection: 'claude-code.terminal' });
    const gone = sessions.closeCanvas(canvas);
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledOnce();
    });

    let settled = false;
    const all = sessions.closeEverything().then(() => {
      settled = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);
    } finally {
      release?.();
      await Promise.all([all, gone]);
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it('waits for an old native session to close before starting its exact-ID replacement', async () => {
    let release: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const id = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11';
    const started: (string | null)[] = [];
    const close = vi.fn(() => closed);
    const sessions = manager({
      'claude-code.terminal': {
        start: (spec, host) => {
          started.push(spec.resume);
          host.remember(spec.resume ?? id);
          return Promise.resolve({
            send: () => Promise.resolve(),
            answer: () => Promise.resolve(),
            interrupt: () => Promise.resolve(),
            setMode: () => Promise.resolve(),
            setModel: () => Promise.resolve(),
            close,
          });
        },
      },
    });
    const canvas = shownCanvas();
    await sessions.start(canvas, 'a', { ...OPTIONS, connection: 'claude-code.terminal' });
    const closing = sessions.close(canvas, 'a');
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledOnce();
    });
    const replacement = sessions.start(canvas, 'a', {
      ...OPTIONS,
      connection: 'claude-code.terminal',
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(started).toEqual([null]);
    } finally {
      release?.();
      await Promise.all([closing, replacement]);
    }
    expect(started).toEqual([null, id]);
  });

  describe('terminal views', () => {
    /** A Terminal session faked: its screen says which run it is, and records what it is told. */
    function terminals() {
      const runs: { input: string[]; sizes: number[][]; pastes: string[]; shown: number }[] = [];
      const connector: Connector = {
        start: () => {
          const run = {
            input: [] as string[],
            sizes: [] as number[][],
            pastes: [] as string[],
            shown: 0,
          };
          runs.push(run);
          const screen = `run ${String(runs.length)}`;
          return Promise.resolve({
            send: () => Promise.resolve(),
            answer: () => Promise.resolve(),
            interrupt: () => Promise.resolve(),
            setMode: () => Promise.resolve(),
            setModel: () => Promise.resolve(),
            close: () => Promise.resolve(),
            terminal: {
              show: (view) => {
                run.shown += 1;
                view({ type: 'screen', data: screen, cols: 80, rows: 24 });
                return () => {
                  run.shown -= 1;
                };
              },
              input: (data) => run.input.push(data),
              resize: (cols, rows) => run.sizes.push([cols, rows]),
              paste: (text) => run.pastes.push(text),
            },
          });
        },
      };
      return { runs, connector };
    }
    const TERMINAL: SessionOptions = { ...OPTIONS, connection: 'claude-code.terminal' };
    const screens = (canvas: CanvasId) =>
      (shown.get(canvas) ?? []).map(([agent, event]) =>
        event.type === 'screen' ? `${agent}:${event.data}` : `${agent}:${event.type}`,
      );

    it('shows an agent’s terminal in its view: the session running, and each one started after', async () => {
      const { runs, connector } = terminals();
      const sessions = manager({ 'claude-code.terminal': connector });
      const canvas = shownCanvas();
      // The view opens before the session starts: it is shown once it runs.
      sessions.attachTerminal(canvas, 'a');
      await sessions.start(canvas, 'a', TERMINAL);
      await vi.waitFor(() => {
        expect(screens(canvas)).toEqual(['a:run 1']);
      });
      // Opened again: shown afresh, once.
      sessions.attachTerminal(canvas, 'a');
      await vi.waitFor(() => {
        expect(screens(canvas)).toEqual(['a:run 1', 'a:run 1']);
      });
      expect(runs[0]?.shown).toBe(1);

      // Another run of it (after it stopped, and the next message started it again).
      await sessions.close(canvas, 'a');
      await sessions.start(canvas, 'a', TERMINAL);
      await vi.waitFor(() => {
        expect(screens(canvas).at(-1)).toBe('a:run 2');
      });

      sessions.detachTerminal(canvas, 'a');
      expect(runs[1]?.shown).toBe(0);
      await sessions.close(canvas, 'a');
      await sessions.start(canvas, 'a', TERMINAL);
      expect(screens(canvas)).toHaveLength(3);
    });

    it('passes keystrokes and sizes to the running session’s terminal, and to nothing without one', async () => {
      const { runs, connector } = terminals();
      const sessions = manager({ 'claude-code.terminal': connector });
      const canvas = shownCanvas();
      await sessions.inputTerminal(canvas, 'a', 'lost');
      await sessions.start(canvas, 'a', TERMINAL);
      await sessions.inputTerminal(canvas, 'a', 'hi\r');
      await sessions.resizeTerminal(canvas, 'a', 120, 40);
      expect(runs[0]).toMatchObject({ input: ['hi\r'], sizes: [[120, 40]] });
      // An SDK session has no terminal.
      await sessions.start(canvas, 'b', OPTIONS);
      sessions.attachTerminal(canvas, 'b');
      await sessions.inputTerminal(canvas, 'b', 'x');
      expect(screens(canvas)).toEqual([]);
    });

    it('pastes the files dropped on a view into its terminal: those that are there, quoted', async () => {
      const { runs, connector } = terminals();
      const sessions = manager({ 'claude-code.terminal': connector });
      const canvas = shownCanvas();
      const dir = await mkdtemp(path.join(tmpdir(), 'corrallm-drop-'));
      try {
        const shot = path.join(dir, 'Screen Shot.png');
        await writeFile(shot, 'png');
        await sessions.start(canvas, 'a', TERMINAL);
        await sessions.dropOnTerminal(canvas, 'a', [shot, path.join(dir, 'gone.png')]);
        await sessions.dropOnTerminal(canvas, 'a', [path.join(dir, 'gone.png')]);
        expect(runs[0]?.pastes).toEqual([`${quotePath(shot)} `]);
        // Nothing runs for another agent: nothing is pasted.
        await sessions.dropOnTerminal(canvas, 'b', [shot]);
        expect(runs).toHaveLength(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('SessionManager and kept conversations', () => {
  it('starts afresh after refusing an unsafe saved id, saying why', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const canvas = shownCanvas();
    const sessions = manager();
    await memory.update(canvas, () => ({
      conversations: inProject({ 'claude-code': { a: { id: '--resume' } } }),
    }));
    try {
      await sessions.start(canvas, 'a', OPTIONS);
      expect(fake.started[0]?.resume).toBeNull();
      expect(said.mock.calls.flat().join(' ')).toContain('will not be resumed');
      await sessions.close(canvas, 'a');
    } finally {
      said.mockRestore();
    }
  });
  it.each(CATALOG.adapters.map(({ id }) => id))(
    'lists valid %s conversations around malformed ids, but still refuses to resume a malformed id',
    async (adapter) => {
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const sessions = manager({}, { [adapter]: { list: listKept } });
      const canvas = shownCanvas();
      adapters.set('a', adapter);
      await memory.update(canvas, () => ({
        conversations: inProject({ [adapter]: { a: { id: KEPT_ONE } } }),
      }));
      listKept.mockResolvedValue([
        { id: KEPT_TWO, title: 'Recent', modified: 2000 },
        { id: 'future:thread', title: 'Unknown shape', modified: 1500 },
        { id: '--resume', title: 'Unsafe', modified: 1200 },
        { id: KEPT_ONE, title: 'Own', modified: 1000 },
      ]);
      try {
        await expect(sessions.listSessions(canvas, 'a', CALLER)).resolves.toEqual([
          { id: KEPT_TWO, title: 'Recent', modified: 2000, current: false },
          { id: KEPT_ONE, title: 'Own', modified: 1000, current: true },
        ]);
        expect(warning).toHaveBeenCalledOnce();
        expect(warning.mock.calls[0]?.[0]).toContain('2');
        for (const id of ['--resume', 'future:thread']) {
          await expect(sessions.resumeSession(canvas, 'a', id, CALLER)).rejects.toThrow(
            /conversation.*id/i,
          );
        }
        expect((await conversations(canvas))[adapter]?.a?.id).toBe(KEPT_ONE);
        await sessions.resumeSession(canvas, 'a', KEPT_TWO, CALLER);
        expect((await conversations(canvas))[adapter]?.a?.id).toBe(KEPT_TWO);
      } finally {
        warning.mockRestore();
      }
    },
  );
  it('lists and resumes a Codex agent’s own threads without reading or changing Claude’s ids', async () => {
    const codex = new FakeConnector({ adapter: 'codex' });
    const list = vi
      .fn<Conversations['list']>()
      .mockResolvedValue([{ id: KEPT_TWO, title: 'Codex thread', modified: 2000 }]);
    const sessions = manager(
      { 'codex.app-server': codex },
      { 'claude-code': { list: listKept, before, fork }, codex: { list } },
    );
    const canvas = shownCanvas();
    adapters.set('a', 'codex');
    await memory.update(canvas, () => ({
      conversations: inProject({
        'claude-code': { a: { id: KEPT_ONE } },
        codex: { a: { id: KEPT_TWO } },
      }),
    }));
    await expect(sessions.listSessions(canvas, 'a', CALLER)).resolves.toEqual([
      { id: KEPT_TWO, title: 'Codex thread', modified: 2000, current: true },
    ]);
    expect(listKept).not.toHaveBeenCalled();
    await sessions.resumeSession(canvas, 'a', KEPT_TWO, CALLER);
    expect((await conversations(canvas))['claude-code']?.a?.id).toBe(KEPT_ONE);
    await sessions.start(canvas, 'a', { ...OPTIONS, connection: 'codex.app-server' });
    expect(codex.started.at(-1)?.resume).toBe(KEPT_TWO);
    await expect(sessions.rewind(canvas, 'a', 'message', 'conversation')).rejects.toThrow(
      /rewind/i,
    );
    expect(before).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
    await sessions.close(canvas, 'a');
  });

  it('does not reuse a list from another adapter, agent or a switched agent', async () => {
    const sessions = manager();
    const canvas = shownCanvas();
    await sessions.listSessions(canvas, 'a', CALLER);
    await expect(sessions.resumeSession(canvas, 'b', KEPT_ONE, CALLER)).rejects.toThrow(/not one/);
    adapters.set('a', 'codex');
    await expect(sessions.resumeSession(canvas, 'a', KEPT_ONE, CALLER)).rejects.toThrow(/not one/);
  });
  it('lists the project folder’s conversations for /resume, saying which is the agent’s own', async () => {
    const sessions = manager();
    const canvas = shownCanvas();
    await sessions.start(canvas, 'a', OPTIONS);
    const own = fake.ids[0] ?? '';
    listKept.mockResolvedValue([
      { id: own, title: 'This one', modified: 3000 },
      { id: KEPT_ONE, title: 'Fix the login bug', modified: 1000 },
    ]);
    await expect(sessions.listSessions(canvas, 'a', CALLER)).resolves.toEqual([
      { id: own, title: 'This one', modified: 3000, current: true },
      { id: KEPT_ONE, title: 'Fix the login bug', modified: 1000, current: false },
    ]);
    expect(listKept).toHaveBeenCalledWith('/work/app', { PATH: '/usr/bin' });
    // Without a project folder there is nothing to list.
    await expect(sessions.listSessions(newCanvasId(), 'a', CALLER)).rejects.toThrow(
      /Choose a project folder/,
    );
  });

  it('opens a conversation it listed in an agent: its session ends, and resumes that one', async () => {
    const sessions = manager();
    const canvas = shownCanvas();
    await sessions.start(canvas, 'a', OPTIONS);
    await sessions.listSessions(canvas, 'a', CALLER);
    await sessions.resumeSession(canvas, 'a', KEPT_ONE, CALLER);
    await memory.flush();
    expect((await conversations(canvas))['claude-code']?.a).toEqual({ id: KEPT_ONE });
    await expect(sessions.send(canvas, 'a', { id: 'm', text: 'Hi' })).rejects.toThrow(
      /not running/,
    );
    await sessions.start(canvas, 'a', OPTIONS);
    expect(fake.started.at(-1)).toMatchObject({ resume: KEPT_ONE, roleChanged: true });
    // And after a restart.
    await memory.flush();
    expect((await conversations(canvas))['claude-code']).toEqual({
      a: { id: KEPT_ONE, role: 'none' },
    });
  });

  it('opens no conversation it did not list for this folder', async () => {
    const sessions = manager();
    const canvas = shownCanvas();
    // Never listed.
    await expect(sessions.resumeSession(canvas, 'a', KEPT_ONE, CALLER)).rejects.toThrow(
      /not one of this project folder’s conversations/,
    );
    await sessions.listSessions(canvas, 'a', CALLER);
    await expect(sessions.resumeSession(canvas, 'a', REMEMBERED, CALLER)).rejects.toThrow(
      /not one of this project folder’s conversations/,
    );
    // Listed for another folder.
    projects.set(canvas, '/work/other');
    await expect(sessions.resumeSession(canvas, 'a', KEPT_ONE, CALLER)).rejects.toThrow(
      /not one of this project folder’s conversations/,
    );
    await sessions.start(canvas, 'a', OPTIONS);
    expect(fake.started.at(-1)?.resume).toBeNull();
  });
});

describe('SessionManager rewinding a session', () => {
  /** A session that rewinds files as `rewound` says, recording what it was asked. */
  function rewinding(
    rewound: FilesRewind = { possible: true, files: ['notes.txt'], added: 1, removed: 1 },
  ) {
    const rewindFiles = vi.fn<NonNullable<LiveSession['rewindFiles']>>().mockResolvedValue(rewound);
    const close = vi.fn<LiveSession['close']>().mockResolvedValue(undefined);
    const connector: Connector = {
      start: (spec, host) => {
        host.remember(spec.resume ?? REMEMBERED);
        return Promise.resolve({
          send: () => Promise.resolve(),
          answer: () => Promise.resolve(),
          interrupt: () => Promise.resolve(),
          setMode: () => Promise.resolve(),
          setModel: () => Promise.resolve(),
          close,
          rewindFiles,
        });
      },
    };
    const started: (string | null)[] = [];
    const specs: SessionSpec[] = [];
    const sdk: Connector = {
      start: (spec, host) => {
        started.push(spec.resume);
        specs.push(spec);
        return connector.start(spec, host);
      },
    };
    return { sessions: manager({ 'claude-code.sdk': sdk }), rewindFiles, close, started, specs };
  }

  it('previews and restores the files alone, leaving the conversation as it is', async () => {
    const { sessions, rewindFiles, close } = rewinding();
    const canvas = shownCanvas();
    await sessions.start(canvas, 'a', OPTIONS);
    await expect(sessions.previewRewind(canvas, 'a', 'u2')).resolves.toMatchObject({
      files: ['notes.txt'],
    });
    expect(rewindFiles).toHaveBeenLastCalledWith('u2', true);
    await expect(sessions.rewind(canvas, 'a', 'u2', 'code')).resolves.toEqual({
      files: { possible: true, files: ['notes.txt'], added: 1, removed: 1 },
      conversation: false,
    });
    expect(rewindFiles).toHaveBeenLastCalledWith('u2', false);
    expect(fork).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('rewinds the conversation to a copy up to before the message, which it resumes next', async () => {
    const { sessions, close, started, specs } = rewinding();
    const canvas = shownCanvas();
    await sessions.start(canvas, 'a', OPTIONS);
    await expect(sessions.rewind(canvas, 'a', 'u2', 'both')).resolves.toMatchObject({
      conversation: true,
      files: { files: ['notes.txt'] },
    });
    expect(before).toHaveBeenCalledWith('/work/app', REMEMBERED, 'u2');
    expect(fork).toHaveBeenCalledWith('/work/app', REMEMBERED, 'reply-1');
    expect(close).toHaveBeenCalled();
    await memory.flush();
    expect((await conversations(canvas))['claude-code']?.a).toEqual({ id: FORKED });
    await sessions.start(canvas, 'a', OPTIONS);
    expect(started).toEqual([null, FORKED]);
    expect(specs.at(-1)).toHaveProperty('roleChanged', true);
    await memory.flush();
    expect((await conversations(canvas))['claude-code']).toEqual({
      a: { id: FORKED, role: 'none' },
    });
  });

  it('starts afresh when rewound to its first message, with nothing before it', async () => {
    const { sessions, started } = rewinding();
    const canvas = shownCanvas();
    await sessions.start(canvas, 'a', OPTIONS);
    before.mockResolvedValueOnce(null);
    await sessions.rewind(canvas, 'a', 'u1', 'conversation');
    expect(fork).not.toHaveBeenCalled();
    await memory.flush();
    expect((await conversations(canvas))['claude-code']?.a).toBeUndefined();
    await sessions.start(canvas, 'a', OPTIONS);
    expect(started).toEqual([null, null]);
  });

  it('changes nothing when the files cannot be restored, or the message is not in it', async () => {
    const { sessions, close } = rewinding({
      possible: false,
      error: 'No checkpoint for that message',
      files: [],
      added: 0,
      removed: 0,
    });
    const canvas = shownCanvas();
    await sessions.start(canvas, 'a', OPTIONS);
    await expect(sessions.rewind(canvas, 'a', 'u2', 'both')).rejects.toThrow(
      'No checkpoint for that message',
    );
    before.mockRejectedValueOnce(new Error('That message is not in this conversation.'));
    await expect(sessions.rewind(canvas, 'a', 'gone', 'conversation')).rejects.toThrow(
      /not in this conversation/,
    );
    expect(fork).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('leaves rewinding a Terminal session to its terminal', async () => {
    const sessions = manager();
    const canvas = shownCanvas();
    await sessions.start(canvas, 'a', { ...OPTIONS, connection: 'claude-code.terminal' });
    await expect(sessions.previewRewind(canvas, 'a', 'u1')).rejects.toThrow(/Esc twice/);
    await expect(sessions.rewind(canvas, 'a', 'u1', 'conversation')).rejects.toThrow(/Esc twice/);
  });
});

it('keeps native conversations in the active workspace, including late reports during a pending move', async () => {
  const canvas = shownCanvas();
  const tree = '11111111-1111-4111-8111-111111111111';
  workspaces.set('a', {
    state: 'ready',
    cwd: mintTrustedPath('/work/tree-a'),
    workspace: tree,
    generation: 1,
    branch: 'corrallm/a',
  });
  let host: SessionHost | undefined;
  const sessions = manager({
    'claude-code.sdk': {
      start: (spec, one) => {
        host = one;
        return fake.start(spec, one);
      },
    },
  });
  try {
    await sessions.start(canvas, 'a', OPTIONS);
    await memory.flush();
    expect(conversationsIn(await memory.get(canvas), tree)['claude-code']?.a?.id).toBe(fake.ids[0]);
    expect(
      conversationsIn(await memory.get(canvas), PROJECT_WORKSPACE)['claude-code']?.a,
    ).toBeUndefined();
    workspaces.set('a', { state: 'held', reason: 'pending-change', sentence: 'Switch first.' });
    host?.remember(KEPT_TWO);
    await memory.flush();
    expect(conversationsIn(await memory.get(canvas), tree)['claude-code']?.a?.id).toBe(KEPT_TWO);
    expect(sessions.running(canvas, 'a')).toBe(true);
  } finally {
    await sessions.closeEverything();
  }
});

it('reads agent options in its verified workspace and refuses a held agent', async () => {
  const canvas = shownCanvas();
  const read = vi
    .fn()
    .mockResolvedValue({ models: [], defaults: { model: null, mode: null, effort: null } });
  const sessions = manager({}, undefined, { 'claude-code': read });
  workspaces.set('a', {
    state: 'ready',
    cwd: mintTrustedPath('/work/tree-a'),
    workspace: '11111111-1111-4111-8111-111111111111',
    generation: 1,
    branch: 'corrallm/a',
  });
  await sessions.settingsOptions(canvas, 'claude-code', 'a');
  expect(read).toHaveBeenCalledWith({ cwd: '/work/tree-a', env: { PATH: '/usr/bin' } });
  workspaces.set('a', { state: 'held', reason: 'setup', sentence: 'Skip or run setup first.' });
  await expect(sessions.settingsOptions(canvas, 'claude-code', 'a')).rejects.toThrow(
    'Skip or run setup first.',
  );
});

it('lists conversations from the agent’s verified workspace and never lists while held', async () => {
  const canvas = shownCanvas();
  workspaces.set('a', {
    state: 'ready',
    cwd: mintTrustedPath('/work/tree-a'),
    workspace: '11111111-1111-4111-8111-111111111111',
    generation: 1,
    branch: 'corrallm/a',
  });
  const sessions = manager();
  await sessions.listSessions(canvas, 'a', CALLER);
  expect(listKept).toHaveBeenCalledExactlyOnceWith('/work/tree-a', { PATH: '/usr/bin' });
  workspaces.set('a', { state: 'held', reason: 'pending-change', sentence: 'Switch first.' });
  await expect(sessions.listSessions(canvas, 'a', CALLER)).rejects.toThrow('Switch first.');
  expect(listKept).toHaveBeenCalledTimes(1);
});

it.each(['ended', 'deadline'] as const)(
  'admits a stalled interrupt while session launch waits, without interrupting it after %s',
  async (why) => {
    const launched = Promise.withResolvers<LiveSession>();
    const starting = Promise.withResolvers<undefined>();
    const interrupted = vi.fn<LiveSession['interrupt']>().mockResolvedValue(undefined);
    const live: LiveSession = {
      send: vi.fn().mockResolvedValue(undefined),
      interrupt: interrupted,
      answer: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      setMode: vi.fn().mockResolvedValue(undefined),
      setModel: vi.fn().mockResolvedValue(undefined),
    };
    const sessions = manager({
      [OPTIONS.connection]: {
        start: () => {
          starting.resolve(undefined);
          return launched.promise;
        },
      },
    });
    const canvas = shownCanvas();
    let current = true;
    const opening = sessions.start(canvas, 'a', OPTIONS);
    await starting.promise;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let admitted: Awaited<ReturnType<SessionManager['interruptIf']>>;
    const requesting = sessions
      .interruptIf(canvas, 'a', () => current)
      .then((value) => {
        admitted = value;
        return value;
      });
    try {
      await vi.waitFor(() => {
        expect(admitted).toMatchObject({ answered: expect.any(Promise) as Promise<void> });
      });
      const requested = await requesting;
      if (!requested) throw new Error('The live turn should admit an interrupt.');
      if (why === 'deadline') {
        const failed = expect(requested.answered).rejects.toThrow('did not answer');
        await vi.advanceTimersByTimeAsync(STALLED_INTERRUPT_MS);
        await failed;
      } else current = false;
      launched.resolve(live);
      await opening;
      if (why === 'ended') await requested.answered;
      expect(interrupted).not.toHaveBeenCalled();
    } finally {
      current = false;
      launched.resolve(live);
      await opening;
      const requested = await requesting;
      await requested?.answered.catch(() => undefined);
      await sessions.closeEverything();
      vi.useRealTimers();
    }
  },
);
