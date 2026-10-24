import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdapterId, ConnectionId } from '../../shared/adapter';
import type { AgentId } from '../../shared/api/ids';
import { newCanvasId } from '../../shared/canvas';
import type { CanvasId } from '../../shared/canvas';
import type { SessionEvent, SessionMode, SessionOptions } from '../../shared/session';
import type { Store } from '../core/store/store';
import { openTestStore } from '../core/store/test-store';
import { mintTrustedPath } from '../core/host';
import type { DirectoryResolver, WorkingDirectory } from '../core/workspaces/resolver';
import { CanvasMemory, conversationsIn, PROJECT_WORKSPACE } from '../memory';
import type { Conversations } from './adapter';
import { ConversationClaims } from './claims';
import type { Connector, LiveSession, SessionHost } from './connector';
import { FakeConnector } from './fake';
import { CATALOG } from './adapters';
import { SessionManager } from './manager';

/*
 * The session manager's live conversation claims, per-caller conversation admission and
 * workspace-generation checks (B11 Design §7, B9a Design §3): no two agents' sessions run one
 * native conversation; a resume is admitted only from a list its caller was given for the agent's
 * directory and generation; a session is reused, and new work dispatched to it, only while the
 * binding it launched in is the active one, and a pending rebind holds new work without ending it.
 */

/** Conversations a CLI kept: native ids, as both shipped adapters' are. */
const KEPT = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e31';
const OTHER = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e32';
const FORKED = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e33';
/** Callers of the manager: two windows, say. */
const WINDOW = 'window:1';
const ANOTHER_WINDOW = 'window:2';
const FOLDER = '/work/app';

/** Each connection of the shipped adapters, with its adapter. */
const CONNECTIONS: readonly [ConnectionId, AdapterId][] = [
  ['claude-code.sdk', 'claude-code'],
  ['claude-code.terminal', 'claude-code'],
  ['codex.app-server', 'codex'],
  ['codex.terminal', 'codex'],
];

let dir: string;
let store: Store;
let memory: CanvasMemory;
/** What each canvas's agents' sessions said, by canvas: agent and event. */
let heard: Map<CanvasId, [string, SessionEvent][]>;
/** The working directory each canvas's agents resolve to, by canvas and agent (else FOLDER, 0). */
let directories: Map<string, WorkingDirectory>;
let listed: Awaited<ReturnType<Conversations['list']>>;
let now: number;

/** A resolver whose answers the test sets, each agent's by canvas and agent: generations and all. */
function resolver(): DirectoryResolver & { calls: number } {
  const resolving = {
    calls: 0,
    workingDirectory: (canvas: CanvasId, agent: AgentId): Promise<WorkingDirectory> => {
      resolving.calls += 1;
      return Promise.resolve(directories.get(`${canvas}\u0000${agent}`) ?? ready(FOLDER, 0));
    },
    onAvailability: () => () => undefined,
    projectRoot: () => mintTrustedPath(FOLDER),
  };
  return resolving;
}

function ready(cwd: string, generation: number, workspace: string | null = null): WorkingDirectory {
  return { state: 'ready', cwd: mintTrustedPath(cwd), workspace, generation, branch: null };
}

const PENDING_SENTENCE =
  'This agent’s workspace changes once you approve it: its new work waits until then.';
const PENDING: WorkingDirectory = {
  state: 'held',
  reason: 'pending-change',
  sentence: PENDING_SENTENCE,
};

function manager(
  connectors: Partial<Record<ConnectionId, Connector>>,
  claims = new ConversationClaims(),
  directory: DirectoryResolver = resolver(),
): SessionManager {
  return new SessionManager({
    catalog: CATALOG,
    connectors,
    environment: () => Promise.resolve({ PATH: '/usr/bin' }),
    conversations: {
      'claude-code': { list: () => Promise.resolve(listed) },
      codex: { list: () => Promise.resolve(listed) },
    },
    adapterOf: (_canvas, agent) =>
      Promise.resolve(agent.startsWith('codex') ? 'codex' : 'claude-code'),
    directories: directory,
    memory,
    claims,
    now: () => now,
    // A close that doesn't finish is waited for this long, not CLOSE_MS.
    closeMs: 20,
    emit: (canvas, agentId, _connection, event) => {
      const list = heard.get(canvas) ?? [];
      list.push([agentId, event]);
      heard.set(canvas, list);
    },
  });
}

/** Remembers `id` as the conversation of `agent` on `canvas`, in `adapter`. */
async function remember(
  canvas: CanvasId,
  agent: string,
  id: string,
  adapter: AdapterId = 'claude-code',
): Promise<void> {
  await memory.update(canvas, (remembered) => ({
    ...remembered,
    conversations: {
      [PROJECT_WORKSPACE]: {
        ...conversationsIn(remembered, PROJECT_WORKSPACE),
        [adapter]: {
          ...conversationsIn(remembered, PROJECT_WORKSPACE)[adapter],
          [agent]: { id },
        },
      },
    },
  }));
}

async function rememberedOf(
  canvas: CanvasId,
  agent: string,
  adapter: AdapterId = 'claude-code',
): Promise<string | undefined> {
  return conversationsIn(await memory.get(canvas), PROJECT_WORKSPACE)[adapter]?.[agent]?.id;
}

/** The notices `agent`'s session said on `canvas`. */
const notices = (canvas: CanvasId, agent: string) =>
  (heard.get(canvas) ?? []).flatMap(([one, event]) =>
    one === agent && event.type === 'notice' ? [event.text] : [],
  );

const options = (connection: ConnectionId = 'claude-code.sdk'): SessionOptions => ({
  connection,
  model: null,
  mode: null,
});

/** A connector over a fake whose sessions' closes are counted, and their hosts kept. */
function counted(adapter: AdapterId = 'claude-code') {
  const fake = new FakeConnector({ adapter });
  const hosts: SessionHost[] = [];
  const closed: number[] = [];
  const connector: Connector<SessionMode> = {
    start: async (spec, host) => {
      hosts.push(host);
      const session = await fake.start(spec, host);
      const index = hosts.length - 1;
      const close = session.close.bind(session);
      session.close = () => {
        closed.push(index);
        return close();
      };
      return session;
    },
  };
  return { fake, connector, hosts, closed };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-claims-'));
  store = await openTestStore(dir);
  memory = new CanvasMemory(store);
  heard = new Map();
  directories = new Map();
  listed = [
    { id: KEPT, title: 'Fix the login bug', modified: 2000 },
    { id: OTHER, title: 'Add a cart', modified: 1000 },
  ];
  now = 1_000_000;
});

afterEach(async () => {
  vi.useRealTimers();
  await memory.flush();
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

describe('conversation claims', () => {
  it.each(CONNECTIONS)(
    'on %s, one of two agents remembering one conversation resumes it; the other starts a new one, saying who holds it',
    async (connection, adapter) => {
      const { fake, connector } = counted(adapter);
      const sessions = manager({ [connection]: connector });
      const canvas = newCanvasId();
      const elsewhere = newCanvasId();
      const holder = adapter === 'codex' ? 'codex "lead"' : '"lead"\nagent';
      const second = adapter === 'codex' ? 'codex-b' : 'b';
      await remember(canvas, holder, KEPT, adapter);
      await remember(elsewhere, second, KEPT, adapter);
      await Promise.all([
        sessions.start(canvas, holder, options(connection)),
        sessions.start(elsewhere, second, options(connection)),
      ]);
      expect(fake.started.map(({ resume }) => resume).sort()).toEqual([KEPT, null].sort());
      const fresh = fake.started.find(({ resume }) => resume === null);
      const [freshCanvas, freshAgent, holderCanvas, holderAgent] =
        fresh?.agentId === second
          ? [elsewhere, second, canvas, holder]
          : [canvas, holder, elsewhere, second];
      // One notice, the holder's name escaped as a name: never a line of its own.
      const said = notices(freshCanvas, freshAgent).filter((text) => text.includes('conversation'));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain(JSON.stringify(holderAgent));
      expect(said[0]).not.toContain('\n');
      // The holder's saved conversation is never cleared; the other agent keeps its new one.
      expect(await rememberedOf(holderCanvas, holderAgent, adapter)).toBe(KEPT);
      await vi.waitFor(async () => {
        expect(await rememberedOf(freshCanvas, freshAgent, adapter)).not.toBe(KEPT);
      });
      await sessions.closeEverything();
    },
  );

  it('refuses an explicit resume of a conversation another agent’s session holds, before closing the caller’s session', async () => {
    const { fake, connector, closed } = counted();
    const sessions = manager({ 'claude-code.sdk': connector });
    const canvas = newCanvasId();
    await remember(canvas, 'a', KEPT);
    await sessions.start(canvas, 'a', options());
    await sessions.start(canvas, 'b', options());
    await sessions.listSessions(canvas, 'b', WINDOW);
    await expect(sessions.resumeSession(canvas, 'b', KEPT, WINDOW)).rejects.toThrow(/open in "a"/);
    expect(closed).toEqual([]);
    await sessions.send(canvas, 'b', { id: 'm', text: 'Still here' });
    expect(fake.sessions[1]?.sent.map(({ text }) => text)).toEqual(['Still here']);
    // One no session holds is resumed, and reserved for the agent's next session meanwhile.
    await sessions.resumeSession(canvas, 'b', OTHER, WINDOW);
    expect(closed).toEqual([1]);
    await remember(canvas, 'c', OTHER);
    await sessions.start(canvas, 'c', options());
    expect(fake.started.at(-1)?.resume).toBeNull();
    await sessions.start(canvas, 'b', options());
    expect(fake.started.at(-1)?.resume).toBe(OTHER);
    await sessions.closeEverything();
  });

  it('releases a conversation only once its session has actually closed, never a successor’s claim', async () => {
    const fake = new FakeConnector();
    const closing = Promise.withResolvers<undefined>();
    let first = true;
    const slow: Connector<SessionMode> = {
      start: async (spec, host) => {
        const session = await fake.start(spec, host);
        if (first) {
          first = false;
          session.close = () => closing.promise;
        }
        return session;
      },
    };
    const sessions = manager({ 'claude-code.sdk': slow });
    const canvas = newCanvasId();
    await remember(canvas, 'a', KEPT);
    await remember(canvas, 'b', KEPT);
    await sessions.start(canvas, 'a', options());
    // Its close doesn't finish: the manager stops waiting after its bound, and the conversation
    // stays the agent's, its next session taking it over.
    await sessions.close(canvas, 'a');
    await sessions.start(canvas, 'b', options());
    expect(fake.started.at(-1)?.resume).toBeNull();
    await sessions.start(canvas, 'a', options());
    expect(fake.started.at(-1)?.resume).toBe(KEPT);
    // The first session closes at last: its successor's claim stays.
    closing.resolve(undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await sessions.close(canvas, 'b');
    await sessions.start(canvas, 'b', options());
    expect(fake.started.at(-1)?.resume).not.toBe(KEPT);
    await sessions.closeEverything();
  });

  it('releases the claim a failed start made, and only that', async () => {
    const fake = new FakeConnector();
    const failing: Connector<SessionMode> = {
      start: (spec, host) =>
        spec.agentId === 'broken'
          ? Promise.reject(new Error('It would not start.'))
          : fake.start(spec, host),
    };
    const sessions = manager({ 'claude-code.sdk': failing });
    const canvas = newCanvasId();
    await remember(canvas, 'broken', KEPT);
    await expect(sessions.start(canvas, 'broken', options())).rejects.toThrow(/would not start/);
    await remember(canvas, 'a', KEPT);
    await sessions.start(canvas, 'a', options());
    expect(fake.started.at(-1)?.resume).toBe(KEPT);
    // Another's start failing never releases the holder's claim.
    await expect(sessions.start(canvas, 'broken', options())).rejects.toThrow(/would not start/);
    await remember(canvas, 'c', KEPT);
    await sessions.start(canvas, 'c', options());
    expect(fake.started.at(-1)?.resume).toBeNull();
    await sessions.closeEverything();
  });

  it('stops a session that reports a conversation another holds, saying why, and never remembers it', async () => {
    const { connector, hosts, closed } = counted();
    const sessions = manager({ 'claude-code.sdk': connector });
    const canvas = newCanvasId();
    await remember(canvas, 'a', KEPT);
    await sessions.start(canvas, 'a', options());
    await sessions.start(canvas, 'b', options());
    const own = await rememberedOf(canvas, 'b');
    // Its terminal's /resume opened the conversation a's session runs.
    hosts[1]?.remember(KEPT);
    await vi.waitFor(() => {
      expect(closed).toEqual([1]);
    });
    expect(notices(canvas, 'b').at(-1)).toMatch(/open in "a".*stopped/);
    expect(
      (heard.get(canvas) ?? []).some(([agent, { type }]) => agent === 'b' && type === 'closed'),
    ).toBe(true);
    await memory.flush();
    expect(await rememberedOf(canvas, 'b')).toBe(own);
    expect(await rememberedOf(canvas, 'a')).toBe(KEPT);
    // A malformed native id is refused at that boundary too: neither claimed nor remembered.
    expect(() => hosts[0]?.remember('--resume')).toThrow(/Invalid claude-code conversation id/);
    expect(await rememberedOf(canvas, 'a')).toBe(KEPT);
    await sessions.closeEverything();
  });

  it('moves a session’s claim to the conversation it reports next, as after /clear', async () => {
    const { connector, hosts } = counted();
    const sessions = manager({ 'claude-code.sdk': connector });
    const canvas = newCanvasId();
    await remember(canvas, 'a', KEPT);
    await sessions.start(canvas, 'a', options());
    hosts[0]?.remember(OTHER);
    await remember(canvas, 'b', KEPT);
    await sessions.start(canvas, 'b', options());
    expect(hosts).toHaveLength(2);
    await remember(canvas, 'c', OTHER);
    await sessions.start(canvas, 'c', options());
    expect(await rememberedOf(canvas, 'b')).toBe(KEPT);
    await vi.waitFor(async () => {
      expect(await rememberedOf(canvas, 'c')).not.toBe(OTHER);
    });
    await sessions.closeEverything();
  });

  it('reserves a rewind’s copy for its agent until its next session resumes it', async () => {
    const fake = new FakeConnector();
    const rewinding: Connector<SessionMode> = {
      start: async (spec, host) => {
        const session: LiveSession<SessionMode> = await fake.start(spec, host);
        session.rewindFiles = () =>
          Promise.resolve({ possible: true, files: [], added: 0, removed: 0 });
        return session;
      },
    };
    const sessions = new SessionManager({
      catalog: CATALOG,
      connectors: { 'claude-code.sdk': rewinding },
      environment: () => Promise.resolve({}),
      conversations: {
        'claude-code': {
          list: () => Promise.resolve(listed),
          before: () => Promise.resolve('reply-1'),
          fork: () => Promise.resolve(FORKED),
        },
      },
      adapterOf: () => Promise.resolve('claude-code'),
      directories: resolver(),
      memory,
      emit: () => undefined,
    });
    const canvas = newCanvasId();
    await remember(canvas, 'a', KEPT);
    await sessions.start(canvas, 'a', options());
    await sessions.rewind(canvas, 'a', 'message', 'conversation');
    await remember(canvas, 'b', FORKED);
    await sessions.start(canvas, 'b', options());
    expect(fake.started.at(-1)?.resume).toBeNull();
    await sessions.start(canvas, 'a', options());
    expect(fake.started.at(-1)?.resume).toBe(FORKED);
    await sessions.closeEverything();
  });

  it('keeps a restart’s conversation its agent’s: another agent’s launch meanwhile starts a new one', async () => {
    const { fake, connector, closed } = counted();
    const sessions = manager({ 'claude-code.sdk': connector });
    const canvas = newCanvasId();
    await remember(canvas, 'a', KEPT);
    await sessions.start(canvas, 'a', options());
    await sessions.restarting(canvas, 'a', 'claude-code');
    expect(closed).toEqual([0]);
    // Closed, but its conversation is reserved for its next session: never another agent's.
    await remember(canvas, 'b', KEPT);
    await sessions.start(canvas, 'b', options());
    expect(fake.started.at(-1)).toMatchObject({ agentId: 'b', resume: null });
    await sessions.start(canvas, 'a', options());
    expect(fake.started.at(-1)).toMatchObject({ agentId: 'a', resume: KEPT });
    expect(await rememberedOf(canvas, 'a')).toBe(KEPT);
    await sessions.closeEverything();
  });

  it('refuses to start a restart over a session that hasn’t finished closing, saying so', async () => {
    const fake = new FakeConnector();
    const closing = Promise.withResolvers<undefined>();
    let first = true;
    const slow: Connector<SessionMode> = {
      start: async (spec, host) => {
        const session = await fake.start(spec, host);
        if (first) {
          first = false;
          session.close = () => closing.promise;
        }
        return session;
      },
    };
    const sessions = manager({ 'claude-code.sdk': slow });
    const canvas = newCanvasId();
    await remember(canvas, 'a', KEPT);
    await sessions.start(canvas, 'a', options());
    expect(sessions.closing(canvas, 'a')).toBe(false);
    await expect(sessions.restarting(canvas, 'a', 'claude-code')).rejects.toThrow(
      /hasn’t finished stopping/,
    );
    // Its CLI may still run: evidence of a writer, until it has closed.
    expect(sessions.closing(canvas, 'a')).toBe(true);
    closing.resolve(undefined);
    await vi.waitFor(() => {
      expect(sessions.closing(canvas, 'a')).toBe(false);
    });
    // The reservation stayed: its next start resumes the same conversation.
    await remember(canvas, 'b', KEPT);
    await sessions.start(canvas, 'b', options());
    expect(fake.started.at(-1)?.resume).toBeNull();
    await sessions.start(canvas, 'a', options());
    expect(fake.started.at(-1)?.resume).toBe(KEPT);
    await sessions.closeEverything();
  });

  it('refuses a restart, closing nothing, while another agent’s session holds its conversation', async () => {
    const { connector, closed } = counted();
    const claims = new ConversationClaims();
    const sessions = manager({ 'claude-code.sdk': connector }, claims);
    const canvas = newCanvasId();
    await sessions.start(canvas, 'a', options());
    await remember(canvas, 'b', KEPT);
    await sessions.start(canvas, 'b', options());
    // a remembers b's conversation (as a file copied from another canvas might say).
    await remember(canvas, 'a', KEPT);
    await expect(sessions.restarting(canvas, 'a', 'claude-code')).rejects.toThrow(/open in "b"/);
    expect(closed).toEqual([]);
    await sessions.closeEverything();
  });

  it('sees no other profile’s claims: two cores may each resume one conversation (no OS-wide lock)', async () => {
    const fake = new FakeConnector();
    const [one, two] = [manager({ 'claude-code.sdk': fake }), manager({ 'claude-code.sdk': fake })];
    const canvas = newCanvasId();
    const other = newCanvasId();
    await remember(canvas, 'a', KEPT);
    await remember(other, 'a', KEPT);
    await one.start(canvas, 'a', options());
    await two.start(other, 'a', options());
    expect(fake.started.map(({ resume }) => resume)).toEqual([KEPT, KEPT]);
    await one.closeEverything();
    await two.closeEverything();
  });
});

describe('conversation admission', () => {
  it('admits a resume only from its own caller’s current list for the agent', async () => {
    const sessions = manager({ 'claude-code.sdk': new FakeConnector() });
    const canvas = newCanvasId();
    await sessions.listSessions(canvas, 'a', WINDOW);
    // Another caller was listed nothing.
    await expect(sessions.resumeSession(canvas, 'a', KEPT, ANOTHER_WINDOW)).rejects.toThrow(
      /not one of/,
    );
    // Its own newer list replaces the one before.
    listed = [{ id: OTHER, title: 'Add a cart', modified: 1000 }];
    await sessions.listSessions(canvas, 'a', WINDOW);
    await expect(sessions.resumeSession(canvas, 'a', KEPT, WINDOW)).rejects.toThrow(/not one of/);
    await sessions.resumeSession(canvas, 'a', OTHER, WINDOW);
    expect(await rememberedOf(canvas, 'a')).toBe(OTHER);
    // Malformed ids are refused before anything, listed or not.
    await expect(sessions.resumeSession(canvas, 'a', '--resume', WINDOW)).rejects.toThrow(
      /Invalid claude-code conversation id/,
    );
  });

  it('expires a list after a while', async () => {
    const sessions = manager({ 'claude-code.sdk': new FakeConnector() });
    const canvas = newCanvasId();
    await sessions.listSessions(canvas, 'a', WINDOW);
    now += 10 * 60 * 1000 + 1;
    await expect(sessions.resumeSession(canvas, 'a', KEPT, WINDOW)).rejects.toThrow(/not one of/);
  });

  it('keeps a list only for the directory and generation it was made in', async () => {
    const sessions = manager({ 'claude-code.sdk': new FakeConnector() });
    const canvas = newCanvasId();
    const key = `${canvas}\u0000a`;
    directories.set(key, ready('/work/tree', 1, 'w1'));
    await sessions.listSessions(canvas, 'a', WINDOW);
    for (const changed of [ready('/work/tree', 2, 'w1'), ready('/work/other', 1, 'w1'), PENDING]) {
      directories.set(key, changed);
      await expect(sessions.resumeSession(canvas, 'a', KEPT, WINDOW)).rejects.toThrow(/not one of/);
    }
    directories.set(key, ready('/work/tree', 1, 'w1'));
    await sessions.resumeSession(canvas, 'a', KEPT, WINDOW);
  });

  it('bounds how many callers’ lists it keeps for an agent', async () => {
    const sessions = manager({ 'claude-code.sdk': new FakeConnector() });
    const canvas = newCanvasId();
    for (let index = 0; index <= 8; index += 1) {
      await sessions.listSessions(canvas, 'a', `window:${String(index)}`);
    }
    // The oldest's list went to make room.
    await expect(sessions.resumeSession(canvas, 'a', KEPT, 'window:0')).rejects.toThrow(
      /not one of/,
    );
    await sessions.resumeSession(canvas, 'a', KEPT, 'window:8');
  });
});

describe('workspace generations', () => {
  it('reuses a session only while its binding is the active one, and replaces it once a new one is installed', async () => {
    const { fake, connector, closed } = counted();
    const sessions = manager({ 'claude-code.sdk': connector });
    const canvas = newCanvasId();
    const key = `${canvas}\u0000a`;
    directories.set(key, ready('/work/tree', 1, 'w1'));
    await sessions.start(canvas, 'a', options());
    await sessions.start(canvas, 'a', options());
    expect(fake.started).toHaveLength(1);
    // A pending rebind keeps the old session, its claim and its events; new work waits.
    directories.set(key, PENDING);
    await sessions.start(canvas, 'a', options());
    expect(fake.started).toHaveLength(1);
    expect(closed).toEqual([]);
    await expect(sessions.availability(canvas, 'a')).resolves.toEqual({
      ready: false,
      reason: 'pending-change',
      sentence: PENDING_SENTENCE,
    });
    await expect(sessions.send(canvas, 'a', { id: 'm', text: 'Not yet' })).rejects.toThrow(
      /approve/,
    );
    expect(fake.sessions[0]?.sent).toEqual([]);
    // Approved: the new binding is the active one, and the old session is replaced.
    directories.set(key, ready('/work/tree-2', 2, 'w2'));
    await expect(sessions.send(canvas, 'a', { id: 'm', text: 'Stale' })).rejects.toThrow(
      /workspace/,
    );
    await sessions.start(canvas, 'a', options());
    expect(closed).toEqual([0]);
    expect(fake.started.map(({ cwd }) => cwd)).toEqual(['/work/tree', '/work/tree-2']);
    await expect(sessions.availability(canvas, 'a')).resolves.toEqual({ ready: true });
    await sessions.send(canvas, 'a', { id: 'm', text: 'Now' });
    expect(fake.sessions[1]?.sent.map(({ text }) => text)).toEqual(['Now']);
    await sessions.closeEverything();
  });

  it('closes a start that completes for a binding no longer active, unheard, and releases its claim', async () => {
    const { fake, connector, closed } = counted();
    const directory = resolver();
    const canvas = newCanvasId();
    const key = `${canvas}\u0000a`;
    directories.set(key, ready('/work/tree', 1, 'w1'));
    const late: Connector<SessionMode> = {
      start: async (spec, host) => {
        const session = await connector.start(spec, host);
        // The binding changes while the CLI starts.
        directories.set(key, ready('/work/tree-2', 2, 'w2'));
        return session;
      },
    };
    const sessions = manager({ 'claude-code.sdk': late }, new ConversationClaims(), directory);
    await remember(canvas, 'a', KEPT);
    await expect(sessions.start(canvas, 'a', options())).rejects.toThrow(/workspace/);
    expect(closed).toEqual([0]);
    await expect(sessions.send(canvas, 'a', { id: 'm', text: 'Hi' })).rejects.toThrow(
      /not running/,
    );
    // Its claim went with it: another agent remembering the conversation resumes it.
    await remember(canvas, 'b', KEPT);
    await sessions.start(canvas, 'b', options());
    expect(fake.started.at(-1)).toMatchObject({ agentId: 'b', resume: KEPT });
    await sessions.closeEverything();
  });

  it('refuses a new session while a rebind is pending, launching nothing', async () => {
    const fake = new FakeConnector();
    const sessions = manager({ 'claude-code.sdk': fake });
    const canvas = newCanvasId();
    directories.set(`${canvas}\u0000a`, PENDING);
    await expect(sessions.start(canvas, 'a', options())).rejects.toThrow(/approve/);
    expect(fake.started).toEqual([]);
  });

  it('says the binding a session runs in, for what checks it before a mutation', async () => {
    const sessions = manager({ 'claude-code.sdk': new FakeConnector() });
    const canvas = newCanvasId();
    const key = `${canvas}\u0000a`;
    directories.set(key, ready('/work/tree', 3, 'w1'));
    expect(sessions.binding(canvas, 'a')).toBeUndefined();
    expect(sessions.running(canvas, 'a')).toBe(false);
    await sessions.start(canvas, 'a', options());
    expect(sessions.running(canvas, 'a')).toBe(true);
    // The binding it launched in, even once a rebind is pending.
    directories.set(key, PENDING);
    expect(sessions.binding(canvas, 'a')).toEqual({
      cwd: '/work/tree',
      workspace: 'w1',
      generation: 3,
    });
    await sessions.close(canvas, 'a');
    expect(sessions.binding(canvas, 'a')).toBeUndefined();
  });

  it('holds a send and a launch while another agent’s mutation of its tree goes on', async () => {
    const fake = new FakeConnector();
    const passing = Promise.withResolvers<undefined>();
    let holding: string | undefined =
      'Its folder is being restored: its new work waits until then.';
    const sessions = new SessionManager({
      catalog: CATALOG,
      connectors: { 'claude-code.sdk': fake },
      environment: () => Promise.resolve({}),
      adapterOf: () => Promise.resolve('claude-code'),
      directories: resolver(),
      memory,
      emit: () => undefined,
      gate: {
        pass: (_canvas, agent) => (agent === 'b' ? passing.promise : Promise.resolve()),
        holding: (_canvas, agent) => Promise.resolve(agent === 'b' ? holding : undefined),
      },
    });
    const canvas = newCanvasId();
    await sessions.start(canvas, 'a', options());
    const launching = sessions.start(canvas, 'b', options());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.started.map(({ agentId }) => agentId)).toEqual(['a']);
    await expect(sessions.availability(canvas, 'b')).resolves.toEqual({
      ready: false,
      reason: 'mutating',
      sentence: holding,
    });
    // Nothing fails meanwhile: it goes once the mutation is done.
    holding = undefined;
    passing.resolve(undefined);
    await launching;
    await sessions.send(canvas, 'b', { id: 'm', text: 'After' });
    expect(fake.sessions[1]?.sent.map(({ text }) => text)).toEqual(['After']);
    await expect(sessions.availability(canvas, 'b')).resolves.toEqual({ ready: true });
    await sessions.closeEverything();
  });
});
