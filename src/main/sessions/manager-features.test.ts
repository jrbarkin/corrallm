import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Catalog, ConnectionDescriptor } from '../../shared/adapter';
import { newCanvasId } from '../../shared/canvas';
import type { CanvasId } from '../../shared/canvas';
import type { SessionEvent, SessionMode, SessionOptions } from '../../shared/session';
import { MADE_UP } from '../../shared/test-made-up';
import type { Store } from '../core/store/store';
import { openTestStore } from '../core/store/test-store';
import { ProjectDirectories } from '../core/workspaces/resolver';
import { mintTrustedPath } from '../core/host';
import { CanvasMemory, PROJECT_WORKSPACE } from '../memory';
import type { Conversations } from './adapter';
import { ConversationClaims } from './claims';
import type { Connector, HostEvent, LiveSession, SessionHost, SessionSpec } from './connector';
import { SessionManager } from './manager';

/*
 * B16 C1 and C4 in the manager: each generation's effective features, reported with `started` and
 * never more than its adapter declares, projected once it is installed and gone with it; the
 * controls it enforces from them; and the lifecycle of a connection that can't continue a
 * conversation, or apply a role. Every adapter here is made up: nothing reads a CLI's name.
 */

const [ZED] = MADE_UP.adapters as [Catalog['adapters'][number]];
const [ACP] = ZED.connections as [ConnectionDescriptor];
/** A made-up adapter that continues and lists conversations, with every panel and control. */
const RESUMING: Catalog = {
  adapters: [
    {
      ...ZED,
      role: 'append-new',
      resume: true,
      list: true,
      connections: [
        {
          ...ACP,
          live: { effort: true, stopTask: true },
          panels: {
            resume: true,
            mcp: { changes: ['reconnect', 'enable'] },
            rewind: { restores: ['both', 'conversation', 'code'] },
          },
        },
      ],
    },
  ],
  usageBackends: MADE_UP.usageBackends,
};
const OPTIONS: SessionOptions = { connection: 'zed.acp', model: null, mode: null };
const REMEMBERED = '6f1d2c3b-4a5e-4f60-8a1b-2c3d4e5f6a70';
const NEW_ONE = '6f1d2c3b-4a5e-4f60-8a1b-2c3d4e5f6a71';
const FORKED = '6f1d2c3b-4a5e-4f60-8a1b-2c3d4e5f6a72';

let dir: string;
let store: Store;
let memory: CanvasMemory;
let claims: ConversationClaims;
let heard: [string, SessionEvent][];
let changed: string[];
let kept: Required<Conversations>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-features-'));
  store = await openTestStore(dir);
  memory = new CanvasMemory(store);
  claims = new ConversationClaims();
  heard = [];
  changed = [];
  kept = {
    list: vi.fn(() => Promise.resolve([])),
    before: vi.fn(() => Promise.resolve('point')),
    fork: vi.fn(() => Promise.resolve(FORKED)),
  };
});

afterEach(async () => {
  await memory.flush();
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

/** What a test connector does: its report, the methods its sessions have, and what it remembers. */
interface Made {
  report?: unknown;
  methods?: Partial<LiveSession<SessionMode>>;
  remember?: string;
  /** Reports `started` only after its start resolved. */
  late?: boolean;
}

/** A connector whose sessions report `made.report` as they start, keeping each spec and host. */
function connector(made: Made = {}) {
  const specs: SessionSpec<SessionMode>[] = [];
  const hosts: SessionHost[] = [];
  const started = (): HostEvent =>
    ({
      type: 'started',
      model: null,
      mode: null,
      models: [],
      ...(made.report === undefined ? { role: 'append', resume: true, list: true } : made.report),
    }) as unknown as HostEvent;
  const one: Connector<SessionMode> = {
    start: (spec, host) => {
      specs.push(spec);
      hosts.push(host);
      if (made.remember !== undefined) host.remember(made.remember);
      if (made.late !== true) host.emit(started());
      const session: LiveSession<SessionMode> = {
        send: () => Promise.resolve(),
        interrupt: () => Promise.resolve(),
        setMode: () => Promise.resolve(),
        setModel: () => Promise.resolve(),
        close: () => Promise.resolve(),
        ...made.methods,
      };
      if (made.late === true)
        setTimeout(() => {
          host.emit(started());
        }, 0);
      return Promise.resolve(session);
    },
  };
  return { one, specs, hosts, started };
}

function manager(catalog: Catalog, one: Connector<SessionMode>, projects = new Set<CanvasId>()) {
  const directories = new ProjectDirectories({
    of: (canvas) => (projects.has(canvas) ? mintTrustedPath('/work/app') : undefined),
    onAvailability: () => () => undefined,
  });
  return new SessionManager({
    catalog,
    connectors: { 'zed.acp': one },
    environment: () => Promise.resolve({}),
    conversations: { zed: kept },
    adapterOf: () => Promise.resolve('zed'),
    directories: {
      projectRoot: (canvas) => directories.projectRoot(canvas),
      onAvailability: (canvas, listener) => directories.onAvailability(canvas, listener),
      workingDirectory: (canvas, agent) => directories.workingDirectory(canvas, agent),
    },
    memory,
    claims,
    emit: (_canvas, agent, _connection, event) => {
      heard.push([agent, event]);
    },
    featuresChanged: (_canvas, agent) => {
      changed.push(agent);
    },
  });
}

/** A canvas whose agents work in /work/app, with its manager. */
function shown(catalog: Catalog, one: Connector<SessionMode>) {
  const canvas = newCanvasId();
  return { canvas, sessions: manager(catalog, one, new Set([canvas])) };
}

const notices = () => heard.flatMap(([, event]) => (event.type === 'notice' ? [event.text] : []));

async function remembered(canvas: CanvasId, id = REMEMBERED) {
  await memory.update(canvas, () => ({
    conversations: { [PROJECT_WORKSPACE]: { zed: { a: { id } } } },
  }));
}

describe('a generation’s features (B16 C1)', () => {
  it('projects none before it runs, its report and the methods it has once it runs, and none once it closes', async () => {
    const made = connector({
      report: { role: 'append-new', resume: true, list: true },
      methods: { setEffort: () => Promise.resolve(), mcpServers: () => Promise.resolve([]) },
    });
    const { canvas, sessions } = shown(RESUMING, made.one);
    expect(sessions.features(canvas, 'a')).toBeNull();
    await sessions.start(canvas, 'a', OPTIONS);
    expect(sessions.features(canvas, 'a')).toEqual({
      role: 'append-new',
      resume: true,
      list: true,
      live: { effort: true, stopTask: false },
      panels: {
        resume: true,
        mcp: { changes: [] },
        rewind: { restores: ['conversation'] },
      },
    });
    expect(changed).toEqual(['a']);
    // What the core hears of `started` says what they came to.
    expect(heard.find(([, event]) => event.type === 'started')?.[1]).toMatchObject({
      role: 'append-new',
      resume: true,
      list: true,
    });

    await sessions.close(canvas, 'a');
    expect(sessions.features(canvas, 'a')).toBeNull();
    expect(changed).toEqual(['a', 'a']);
  });

  it('is ready only once both its report and its installed session are', async () => {
    const made = connector({ late: true });
    const { canvas, sessions } = shown(RESUMING, made.one);
    await sessions.start(canvas, 'a', OPTIONS);
    expect(sessions.features(canvas, 'a')).toBeNull();
    await vi.waitFor(() => {
      expect(sessions.features(canvas, 'a')).toMatchObject({ role: 'append-new', resume: true });
    });
    await sessions.closeEverything();
  });

  it('narrows a report to what its adapter declares', async () => {
    const made = connector({ report: { role: 'append', resume: true, list: true } });
    const { canvas, sessions } = shown(MADE_UP, made.one);
    await sessions.start(canvas, 'a', OPTIONS);
    expect(sessions.features(canvas, 'a')).toEqual({
      role: 'none',
      resume: false,
      list: false,
      live: { effort: false, stopTask: false },
      panels: {},
    });
    expect(heard.find(([, event]) => event.type === 'started')?.[1]).toMatchObject({
      role: 'none',
      resume: false,
      list: false,
    });
    await sessions.closeEverything();
  });

  it('refuses a malformed report: none of its features, and one fixed notice without its values', async () => {
    const made = connector({
      report: { role: 'everything', resume: 'yes', list: true },
      methods: {
        rewindFiles: () => Promise.resolve({ possible: true, files: [], added: 0, removed: 0 }),
      },
    });
    const { canvas, sessions } = shown(RESUMING, made.one);
    await sessions.start(canvas, 'a', OPTIONS);
    expect(sessions.features(canvas, 'a')).toEqual({
      role: 'none',
      resume: false,
      list: false,
      live: { effort: false, stopTask: false },
      panels: { rewind: { restores: ['code'] } },
    });
    expect(notices()).toEqual([
      'Zed Agent · ACP didn’t say what it supports, so corrallm offers none of its conversation features in this session.',
    ]);
    expect(notices().join()).not.toMatch(/everything|yes/);
    await sessions.closeEverything();
  });

  it('never lets a later report widen what the generation reported first', async () => {
    const made = connector({ report: { role: 'none', resume: false, list: false } });
    const { canvas, sessions } = shown(RESUMING, made.one);
    await sessions.start(canvas, 'a', OPTIONS);
    made.hosts[0]?.emit({
      type: 'started',
      model: null,
      mode: null,
      models: [],
      role: 'append-new',
      resume: true,
      list: true,
    });
    expect(sessions.features(canvas, 'a')).toMatchObject({ role: 'none', resume: false });
    await sessions.closeEverything();
  });

  it('ignores a closed generation’s late report', async () => {
    const made = connector();
    const { canvas, sessions } = shown(RESUMING, made.one);
    await sessions.start(canvas, 'a', OPTIONS);
    const old = made.hosts[0];
    await sessions.close(canvas, 'a');
    old?.emit(made.started());
    expect(sessions.features(canvas, 'a')).toBeNull();
  });
});

describe('controls a generation can’t use (B16 C1)', () => {
  it('refuses a live effort its connection doesn’t declare, though its session has the method', async () => {
    const setEffort = vi.fn(() => Promise.resolve());
    const made = connector({ methods: { setEffort } });
    const { canvas, sessions } = shown(MADE_UP, made.one);
    await sessions.start(canvas, 'a', OPTIONS);
    await expect(sessions.setEffort(canvas, 'a', 'high')).rejects.toThrow(/effort/);
    expect(setEffort).not.toHaveBeenCalled();
    await sessions.closeEverything();
  });

  it('refuses an MCP change its connection doesn’t offer, calling nothing', async () => {
    const changeMcpServer = vi.fn(() => Promise.resolve());
    const made = connector({
      methods: { mcpServers: () => Promise.resolve([]), changeMcpServer },
    });
    const { canvas, sessions } = shown(RESUMING, made.one);
    await sessions.start(canvas, 'a', OPTIONS);
    await expect(sessions.changeMcpServer(canvas, 'a', 'github', 'disable')).rejects.toThrow();
    expect(changeMcpServer).not.toHaveBeenCalled();
    await sessions.changeMcpServer(canvas, 'a', 'github', 'enable');
    expect(changeMcpServer).toHaveBeenCalledOnce();
    await sessions.closeEverything();
  });

  it('rewinds a conversation without a file method, and refuses a code restore it can’t make', async () => {
    const made = connector({ report: { role: 'append-new', resume: true, list: true } });
    const { canvas, sessions } = shown(RESUMING, made.one);
    await remembered(canvas);
    await sessions.start(canvas, 'a', OPTIONS);
    await expect(sessions.rewind(canvas, 'a', 'm1', 'code')).rejects.toThrow(/rewind/);
    await expect(sessions.rewind(canvas, 'a', 'm1', 'both')).rejects.toThrow(/rewind/);
    expect(kept.fork).not.toHaveBeenCalled();
    expect(await sessions.rewind(canvas, 'a', 'm1', 'conversation')).toEqual({
      conversation: true,
    });
    expect(kept.fork).toHaveBeenCalledWith('/work/app', REMEMBERED, 'point');
    expect(await sessions.conversationOf(canvas, 'a', 'zed')).toBe(FORKED);
  });
});

describe('a connection that can’t continue a conversation (B16 C4)', () => {
  it('is never handed its remembered conversation, which stays unclaimed', async () => {
    const made = connector({ report: { role: 'none', resume: false, list: false } });
    const { canvas, sessions } = shown(MADE_UP, made.one);
    await remembered(canvas);
    await sessions.start(canvas, 'a', OPTIONS);
    expect(made.specs[0]?.resume).toBeNull();
    expect(claims.holder('zed', REMEMBERED)).toBeUndefined();
    expect(notices()).toEqual([]);
    await sessions.closeEverything();
  });

  it('starts a new conversation, lets the old one go and says so once, when its session can’t continue it', async () => {
    const made = connector({
      report: { role: 'append-new', resume: false, list: false },
      remember: NEW_ONE,
    });
    const { canvas, sessions } = shown(RESUMING, made.one);
    await remembered(canvas);
    await sessions.start(canvas, 'a', OPTIONS);
    expect(made.specs[0]?.resume).toBe(REMEMBERED);
    expect(claims.holder('zed', REMEMBERED)).toBeUndefined();
    expect(claims.holder('zed', NEW_ONE)).toMatchObject({ agent: 'a' });
    expect(notices()).toEqual([
      'Zed Agent · ACP cannot continue its earlier conversation, so it started a new one.',
    ]);
    expect(sessions.features(canvas, 'a')).toMatchObject({ resume: false, list: false });
    await sessions.closeEverything();
  });

  it('releases the conversation it was given even when it remembers none', async () => {
    const made = connector({ report: { role: 'append-new', resume: false, list: false } });
    const { canvas, sessions } = shown(RESUMING, made.one);
    await remembered(canvas);
    await sessions.start(canvas, 'a', OPTIONS);
    expect(claims.holder('zed', REMEMBERED)).toBeUndefined();
    await sessions.closeEverything();
  });
});

describe('a role the connection can’t apply (B16 C4)', () => {
  it('starts without it, saying so once, never sending it', async () => {
    const made = connector({ report: { role: 'none', resume: false, list: false } });
    const { canvas, sessions } = shown(MADE_UP, made.one);
    await sessions.start(canvas, 'a', { ...OPTIONS, role: 'Review every change.' });
    expect(made.specs[0]).not.toHaveProperty('role');
    expect(notices()).toEqual([
      'Zed Agent · ACP can’t apply this agent’s role, so it runs without it. The role stays saved with the agent.',
    ]);
    expect(heard.some(([, event]) => event.type === 'user')).toBe(false);
    await sessions.closeEverything();
  });

  it('says nothing for an agent with no role', async () => {
    const made = connector({ report: { role: 'none', resume: false, list: false } });
    const { canvas, sessions } = shown(MADE_UP, made.one);
    await sessions.start(canvas, 'a', OPTIONS);
    expect(notices()).toEqual([]);
    await sessions.closeEverything();
  });

  it('says so too when a session reports it can’t apply the role it was given', async () => {
    const made = connector({ report: { role: 'none', resume: true, list: true } });
    const { canvas, sessions } = shown(RESUMING, made.one);
    await sessions.start(canvas, 'a', { ...OPTIONS, role: 'Review every change.' });
    expect(made.specs[0]?.role).toBe('Review every change.');
    expect(notices()).toEqual([
      'Zed Agent · ACP can’t apply this agent’s role, so it runs without it. The role stays saved with the agent.',
    ]);
    await sessions.closeEverything();
  });
});
