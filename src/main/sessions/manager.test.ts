import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type { Connection, FilesRewind, SessionEvent, SessionOptions } from '../../shared/session';
import type { TerminalEvent } from '../../shared/terminal';
import { CanvasMemory } from '../memory';
import type { Connector, LiveSession, SessionHost } from './connector';
import { unavailable } from './connector';
import { FakeConnector } from './fake';
import { SessionManager } from './manager';
import type { SessionManagerDeps } from './manager';
import { quotePath } from './terminal/drop';

/** A stand-in for a renderer's web contents: the manager keys sessions by it, and hears it go. */
const renderer = () => new EventEmitter() as unknown as Electron.WebContents;

const OPTIONS: SessionOptions = { connection: 'sdk', model: null, mode: null };

let dir: string;
let memory: CanvasMemory;
let fake: FakeConnector;
let terminal: FakeConnector;
/** Each renderer's project folder and canvas file, as project.ts and canvas.ts would know them. */
let projects: Map<Electron.WebContents, string>;
let canvases: Map<Electron.WebContents, string>;
/** What each renderer heard: agent, connection and event. */
let heard: Map<Electron.WebContents, [string, Connection, SessionEvent][]>;
/** What each renderer's terminal views heard: agent and event. */
let shown: Map<Electron.WebContents, [string, TerminalEvent][]>;
let environment: () => Promise<Record<string, string>>;
type Kept = NonNullable<SessionManagerDeps['conversations']>;
/** The conversations Claude Code kept for each folder, as the Agent SDK lists and forks them. */
let listKept: Mock<Kept['list']>;
let before: Mock<Kept['before']>;
let fork: Mock<Kept['fork']>;

function manager(connectors: Partial<Record<Connection, Connector>> = {}) {
  return new SessionManager({
    connectors: { sdk: fake, terminal, ...connectors },
    environment: () => environment(),
    conversations: { list: listKept, before, fork },
    projectOf: (contents) => projects.get(contents),
    canvasOf: (contents) => canvases.get(contents),
    memory,
    emit: (contents, agentId, connection, event) => {
      const list = heard.get(contents) ?? [];
      list.push([agentId, connection, event]);
      heard.set(contents, list);
    },
    terminal: (contents, agentId, event) => {
      const list = shown.get(contents) ?? [];
      list.push([agentId, event]);
      shown.set(contents, list);
    },
  });
}

/** What `contents` heard, as event types (with the agent), for a quick look. */
const types = (contents: Electron.WebContents) =>
  (heard.get(contents) ?? []).map(([agent, , event]) => `${agent}:${event.type}`);

/** A renderer with the canvas file `file` (if any), its agents working in /work/app. */
function window(file?: string) {
  const contents = renderer();
  projects.set(contents, '/work/app');
  if (file !== undefined) canvases.set(contents, file);
  return contents;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-sessions-'));
  memory = new CanvasMemory(path.join(dir, 'canvases.json'));
  fake = new FakeConnector();
  terminal = new FakeConnector();
  projects = new Map();
  canvases = new Map();
  heard = new Map();
  shown = new Map();
  environment = () => Promise.resolve({ PATH: '/usr/bin' });
  before = vi.fn<Kept['before']>().mockResolvedValue('reply-1');
  fork = vi.fn<Kept['fork']>().mockResolvedValue('forked');
  listKept = vi.fn(() =>
    Promise.resolve([
      { id: 'kept-2', title: 'Add a cart', modified: 2000 },
      { id: 'kept-1', title: 'Fix the login bug', modified: 1000 },
    ]),
  );
});
afterEach(async () => {
  await memory.flush();
  await rm(dir, { recursive: true, force: true });
});

describe('SessionManager', () => {
  it('starts a session in the canvas’s project folder; its events go to the renderer that started it', async () => {
    const sessions = manager();
    const one = window();
    const other = window();
    await sessions.start(one, 'a', { ...OPTIONS, model: 'fast', mode: 'acceptEdits' });
    expect(fake.started).toEqual([
      {
        agentId: 'a',
        cwd: '/work/app',
        env: { PATH: '/usr/bin' },
        model: 'fast',
        mode: 'acceptEdits',
        resume: null,
      },
    ]);
    expect(heard.get(one)?.[0]).toEqual([
      'a',
      'sdk',
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
    await expect(sessions.start(renderer(), 'a', OPTIONS)).rejects.toThrow(
      /Choose a project folder/,
    );
    expect(fake.started).toEqual([]);
  });

  it('says why a connection cannot start, and forgets the attempt', async () => {
    const sessions = manager({ terminal: unavailable('Claude in a terminal') });
    const contents = window();
    await expect(
      sessions.start(contents, 'a', { ...OPTIONS, connection: 'terminal' }),
    ).rejects.toThrow("corrallm can't run Claude in a terminal yet.");
    await expect(sessions.send(contents, 'a', { id: 'm', text: 'Hi' })).rejects.toThrow(
      /not running/,
    );
  });

  it('starts an agent once; another connection takes over, resuming the same session', async () => {
    const sessions = manager();
    const contents = window();
    await Promise.all([
      sessions.start(contents, 'a', OPTIONS),
      sessions.start(contents, 'a', OPTIONS),
    ]);
    expect(fake.started).toHaveLength(1);

    await sessions.start(contents, 'a', { ...OPTIONS, connection: 'terminal' });
    expect(fake.started[0]?.resume).toBeNull();
    expect(terminal.started[0]?.resume).toBe(fake.ids[0]);
    expect(fake.ids).toHaveLength(1);
  });

  it('remembers each agent’s session with the canvas’s file, and resumes it after a restart', async () => {
    const before = manager();
    const contents = window('/work/team.corral');
    await before.start(contents, 'a', OPTIONS);
    await before.closeEverything();
    const { sessions: ids } = await memory.get('/work/team.corral');
    expect(Object.keys(ids)).toEqual(['a']);

    // The app starts again, and the canvas opens.
    const after = manager();
    const reopened = window('/work/team.corral');
    await after.canvasOpened(reopened);
    await after.start(reopened, 'a', OPTIONS);
    expect(fake.started.at(-1)?.resume).toBe(ids.a);
    // Another agent starts afresh.
    await after.start(reopened, 'b', OPTIONS);
    expect(fake.started.at(-1)?.resume).toBeNull();
  });

  it('starts an agent with the model and mode it was last given, after a restart too', async () => {
    const before = manager();
    const contents = window('/work/team.corral');
    // Nothing chosen: the CLI's default model, and the user's own default mode.
    await before.start(contents, 'a', OPTIONS);
    expect(fake.started.at(-1)).toMatchObject({ model: null, mode: null });
    await before.setModel(contents, 'a', 'fast');
    await before.setMode(contents, 'a', 'plan');
    // Chosen before it started: given at the start.
    await before.start(contents, 'b', { ...OPTIONS, mode: 'acceptEdits' });
    await before.closeEverything();

    const after = manager();
    const reopened = window('/work/team.corral');
    await after.canvasOpened(reopened);
    await after.start(reopened, 'a', OPTIONS);
    expect(fake.started.at(-1)).toMatchObject({ agentId: 'a', model: 'fast', mode: 'plan' });
    await after.start(reopened, 'b', { ...OPTIONS, connection: 'terminal' });
    expect(terminal.started.at(-1)).toMatchObject({
      agentId: 'b',
      model: null,
      mode: 'acceptEdits',
    });
    // What the renderer chose now wins, and is what is remembered next.
    await after.close(reopened, 'a');
    await after.start(reopened, 'a', { ...OPTIONS, model: 'default' });
    expect(fake.started.at(-1)).toMatchObject({ model: 'default', mode: 'plan' });
    await memory.flush();
    expect((await memory.get('/work/team.corral')).chosen?.a).toEqual({
      model: 'default',
      mode: 'plan',
    });
  });

  it('never starts an agent bypassing permissions because it did before', async () => {
    const sessions = manager();
    const contents = window('/work/team.corral');
    await sessions.start(contents, 'a', { ...OPTIONS, mode: 'plan' });
    await sessions.setMode(contents, 'a', 'bypassPermissions');
    await sessions.close(contents, 'a');
    await sessions.start(contents, 'a', OPTIONS);
    expect(fake.started.at(-1)?.mode).toBeNull();
    await memory.flush();
    expect((await memory.get('/work/team.corral')).chosen?.a).toBeUndefined();
  });

  it('forgets the model and mode chosen when the canvas is replaced by a new one', async () => {
    const sessions = manager();
    const contents = window();
    await sessions.start(contents, 'a', { ...OPTIONS, mode: 'plan' });
    await sessions.canvasForgotten(contents);
    await sessions.start(contents, 'a', OPTIONS);
    expect(fake.started.at(-1)?.mode).toBeNull();
  });

  it('remembers the sessions of a canvas first saved after they started', async () => {
    const sessions = manager();
    const contents = window();
    await sessions.start(contents, 'a', OPTIONS);
    canvases.set(contents, '/work/saved.corral');
    await sessions.canvasSaved(contents);
    expect(Object.keys((await memory.get('/work/saved.corral')).sessions)).toEqual(['a']);
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
    const sessions = manager({ sdk: { start: () => Promise.resolve(live) } });
    const contents = window();
    await expect(sessions.interrupt(contents, 'a')).rejects.toThrow(/not running/);
    await sessions.start(contents, 'a', OPTIONS);
    await sessions.send(contents, 'a', { id: 'm', text: 'Hi' });
    await sessions.answer(contents, 'a', 'p', { kind: 'permission', answer: 'once' });
    await sessions.interrupt(contents, 'a');
    await sessions.setMode(contents, 'a', 'plan');
    await sessions.setModel(contents, 'a', 'opus');
    expect(live.send).toHaveBeenCalledWith({ id: 'm', text: 'Hi' });
    expect(live.answer).toHaveBeenCalledWith('p', { kind: 'permission', answer: 'once' });
    expect(live.interrupt).toHaveBeenCalled();
    expect(live.setMode).toHaveBeenCalledWith('plan');
    expect(live.setModel).toHaveBeenCalledWith('opus');
    await sessions.close(contents, 'a');
    expect(live.close).toHaveBeenCalled();
    await expect(sessions.send(contents, 'a', { id: 'n', text: 'Again' })).rejects.toThrow(
      /not running/,
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
    const sessions = manager({ sdk: { start: () => Promise.resolve(live) } });
    const contents = window();
    await expect(sessions.mcpServers(contents, 'a')).rejects.toThrow(/not running/);
    await sessions.start(contents, 'a', OPTIONS);
    await expect(sessions.mcpServers(contents, 'a')).resolves.toEqual(servers);
    // A change answers with how they all are then.
    await expect(sessions.changeMcpServer(contents, 'a', 'github', 'disable')).resolves.toEqual(
      servers,
    );
    expect(live.changeMcpServer).toHaveBeenCalledWith('github', 'disable');
    // A Terminal session's are its terminal's.
    await sessions.start(contents, 'b', { ...OPTIONS, connection: 'terminal' });
    await expect(sessions.mcpServers(contents, 'b')).rejects.toThrow(/run \/mcp in its terminal/);
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
      sdk: { start: () => Promise.resolve(live) },
      terminal: { start: () => Promise.resolve(terminal) },
    });
    const contents = window();
    await sessions.start(contents, 'a', OPTIONS);
    await sessions.setEffort(contents, 'a', 'max');
    await sessions.stopTask(contents, 'a', 'b1');
    expect(live.setEffort).toHaveBeenCalledWith('max');
    expect(live.stopTask).toHaveBeenCalledWith('b1');

    await sessions.start(contents, 'b', { ...OPTIONS, connection: 'terminal' });
    await expect(sessions.setEffort(contents, 'b', 'low')).rejects.toThrow(/in its terminal/);
    await expect(sessions.stopTask(contents, 'b', 'b1')).rejects.toThrow(/in its terminal/);
  });

  it('ends a renderer’s sessions when its canvas changes, telling it', async () => {
    const sessions = manager();
    const contents = window('/work/team.corral');
    await sessions.start(contents, 'a', OPTIONS);
    await sessions.canvasForgotten(contents);
    expect(types(contents).at(-1)).toBe('a:closed');
    await expect(sessions.interrupt(contents, 'a')).rejects.toThrow(/not running/);
  });

  it('forgets the sessions when the project folder changes: they start afresh in the new one', async () => {
    const sessions = manager();
    const contents = window('/work/team.corral');
    await sessions.start(contents, 'a', OPTIONS);
    projects.set(contents, '/work/other');
    await sessions.projectChanged(contents);
    expect(types(contents).at(-1)).toBe('a:closed');
    expect((await memory.get('/work/team.corral')).sessions).toEqual({});
    await sessions.start(contents, 'a', OPTIONS);
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
      sdk: {
        start: (_spec, given) => {
          host = given;
          return Promise.resolve(live);
        },
      },
    });
    const contents = window();
    await sessions.start(contents, 'a', OPTIONS);
    const first = host;
    first?.emit({ type: 'closed', error: 'It crashed' });
    expect(types(contents)).toEqual(['a:closed']);
    await expect(sessions.send(contents, 'a', { id: 'm', text: 'Hi' })).rejects.toThrow(
      /not running/,
    );

    // Started again: the first session's late words are not heard.
    await sessions.start(contents, 'a', OPTIONS);
    first?.emit({ type: 'notice', id: 'n', level: 'info', text: 'Late' });
    expect(types(contents)).toEqual(['a:closed']);
  });

  it('ends a renderer’s sessions when it goes, and every session when the app quits', async () => {
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
    const sessions = manager({ sdk: connector });
    const gone = window();
    const staying = window();
    await sessions.start(gone, 'a', OPTIONS);
    await sessions.start(staying, 'b', OPTIONS);
    await sessions.start(staying, 'c', OPTIONS);
    (gone as unknown as EventEmitter).emit('destroyed');
    await vi.waitFor(() => {
      expect(closed).toEqual(['a']);
    });
    await sessions.closeEverything();
    expect(closed.sort()).toEqual(['a', 'b', 'c']);
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
    const TERMINAL: SessionOptions = { ...OPTIONS, connection: 'terminal' };
    const screens = (contents: Electron.WebContents) =>
      (shown.get(contents) ?? []).map(([agent, event]) =>
        event.type === 'screen' ? `${agent}:${event.data}` : `${agent}:${event.type}`,
      );

    it('shows an agent’s terminal in its view: the session running, and each one started after', async () => {
      const { runs, connector } = terminals();
      const sessions = manager({ terminal: connector });
      const contents = window();
      // The view opens before the session starts: it is shown once it runs.
      sessions.attachTerminal(contents, 'a');
      await sessions.start(contents, 'a', TERMINAL);
      await vi.waitFor(() => {
        expect(screens(contents)).toEqual(['a:run 1']);
      });
      // Opened again: shown afresh, once.
      sessions.attachTerminal(contents, 'a');
      await vi.waitFor(() => {
        expect(screens(contents)).toEqual(['a:run 1', 'a:run 1']);
      });
      expect(runs[0]?.shown).toBe(1);

      // Another run of it (after it stopped, and the next message started it again).
      await sessions.close(contents, 'a');
      await sessions.start(contents, 'a', TERMINAL);
      await vi.waitFor(() => {
        expect(screens(contents).at(-1)).toBe('a:run 2');
      });

      sessions.detachTerminal(contents, 'a');
      expect(runs[1]?.shown).toBe(0);
      await sessions.close(contents, 'a');
      await sessions.start(contents, 'a', TERMINAL);
      expect(screens(contents)).toHaveLength(3);
    });

    it('passes keystrokes and sizes to the running session’s terminal, and to nothing without one', async () => {
      const { runs, connector } = terminals();
      const sessions = manager({ terminal: connector });
      const contents = window();
      await sessions.inputTerminal(contents, 'a', 'lost');
      await sessions.start(contents, 'a', TERMINAL);
      await sessions.inputTerminal(contents, 'a', 'hi\r');
      await sessions.resizeTerminal(contents, 'a', 120, 40);
      expect(runs[0]).toMatchObject({ input: ['hi\r'], sizes: [[120, 40]] });
      // An SDK session has no terminal.
      await sessions.start(contents, 'b', OPTIONS);
      sessions.attachTerminal(contents, 'b');
      await sessions.inputTerminal(contents, 'b', 'x');
      expect(screens(contents)).toEqual([]);
    });

    it('pastes the files dropped on a view into its terminal: those that are there, quoted', async () => {
      const { runs, connector } = terminals();
      const sessions = manager({ terminal: connector });
      const contents = window();
      const dir = await mkdtemp(path.join(tmpdir(), 'corrallm-drop-'));
      try {
        const shot = path.join(dir, 'Screen Shot.png');
        await writeFile(shot, 'png');
        await sessions.start(contents, 'a', TERMINAL);
        await sessions.dropOnTerminal(contents, 'a', [shot, path.join(dir, 'gone.png')]);
        await sessions.dropOnTerminal(contents, 'a', [path.join(dir, 'gone.png')]);
        expect(runs[0]?.pastes).toEqual([`${quotePath(shot)} `]);
        // Nothing runs for another agent: nothing is pasted.
        await sessions.dropOnTerminal(contents, 'b', [shot]);
        expect(runs).toHaveLength(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('SessionManager and kept conversations', () => {
  it('lists the project folder’s conversations for /resume, saying which is the agent’s own', async () => {
    const sessions = manager();
    const contents = window('/work/team.corral');
    await sessions.start(contents, 'a', OPTIONS);
    const own = fake.ids[0] ?? '';
    listKept.mockResolvedValue([
      { id: own, title: 'This one', modified: 3000 },
      { id: 'kept-1', title: 'Fix the login bug', modified: 1000 },
    ]);
    await expect(sessions.listSessions(contents, 'a')).resolves.toEqual([
      { id: own, title: 'This one', modified: 3000, current: true },
      { id: 'kept-1', title: 'Fix the login bug', modified: 1000, current: false },
    ]);
    expect(listKept).toHaveBeenCalledWith('/work/app');
    // Without a project folder there is nothing to list.
    await expect(sessions.listSessions(renderer(), 'a')).rejects.toThrow(/Choose a project folder/);
  });

  it('opens a conversation it listed in an agent: its session ends, and resumes that one', async () => {
    const sessions = manager();
    const contents = window('/work/team.corral');
    await sessions.start(contents, 'a', OPTIONS);
    await sessions.listSessions(contents, 'a');
    await sessions.resumeSession(contents, 'a', 'kept-1');
    await expect(sessions.send(contents, 'a', { id: 'm', text: 'Hi' })).rejects.toThrow(
      /not running/,
    );
    await sessions.start(contents, 'a', OPTIONS);
    expect(fake.started.at(-1)?.resume).toBe('kept-1');
    // And after a restart.
    await memory.flush();
    expect((await memory.get('/work/team.corral')).sessions).toEqual({ a: 'kept-1' });
  });

  it('opens no conversation it did not list for this folder', async () => {
    const sessions = manager();
    const contents = window();
    // Never listed.
    await expect(sessions.resumeSession(contents, 'a', 'kept-1')).rejects.toThrow(
      /not one of this project folder’s conversations/,
    );
    await sessions.listSessions(contents, 'a');
    await expect(sessions.resumeSession(contents, 'a', 'elsewhere')).rejects.toThrow(
      /not one of this project folder’s conversations/,
    );
    // Listed for another folder.
    projects.set(contents, '/work/other');
    await expect(sessions.resumeSession(contents, 'a', 'kept-1')).rejects.toThrow(
      /not one of this project folder’s conversations/,
    );
    await sessions.start(contents, 'a', OPTIONS);
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
        host.remember(spec.resume ?? 'conversation');
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
    const sdk: Connector = {
      start: (spec, host) => {
        started.push(spec.resume);
        return connector.start(spec, host);
      },
    };
    return { sessions: manager({ sdk }), rewindFiles, close, started };
  }

  it('previews and restores the files alone, leaving the conversation as it is', async () => {
    const { sessions, rewindFiles, close } = rewinding();
    const contents = window('/work/team.corral');
    await sessions.start(contents, 'a', OPTIONS);
    await expect(sessions.previewRewind(contents, 'a', 'u2')).resolves.toMatchObject({
      files: ['notes.txt'],
    });
    expect(rewindFiles).toHaveBeenLastCalledWith('u2', true);
    await expect(sessions.rewind(contents, 'a', 'u2', 'code')).resolves.toEqual({
      files: { possible: true, files: ['notes.txt'], added: 1, removed: 1 },
      conversation: false,
    });
    expect(rewindFiles).toHaveBeenLastCalledWith('u2', false);
    expect(fork).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('rewinds the conversation to a copy up to before the message, which it resumes next', async () => {
    const { sessions, close, started } = rewinding();
    const contents = window('/work/team.corral');
    await sessions.start(contents, 'a', OPTIONS);
    await expect(sessions.rewind(contents, 'a', 'u2', 'both')).resolves.toMatchObject({
      conversation: true,
      files: { files: ['notes.txt'] },
    });
    expect(before).toHaveBeenCalledWith('/work/app', 'conversation', 'u2');
    expect(fork).toHaveBeenCalledWith('/work/app', 'conversation', 'reply-1');
    expect(close).toHaveBeenCalled();
    await sessions.start(contents, 'a', OPTIONS);
    expect(started).toEqual([null, 'forked']);
    await memory.flush();
    expect((await memory.get('/work/team.corral')).sessions).toEqual({ a: 'forked' });
  });

  it('starts afresh when rewound to its first message, with nothing before it', async () => {
    const { sessions, started } = rewinding();
    const contents = window('/work/team.corral');
    await sessions.start(contents, 'a', OPTIONS);
    before.mockResolvedValueOnce(null);
    await sessions.rewind(contents, 'a', 'u1', 'conversation');
    expect(fork).not.toHaveBeenCalled();
    await memory.flush();
    expect((await memory.get('/work/team.corral')).sessions).toEqual({});
    await sessions.start(contents, 'a', OPTIONS);
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
    const contents = window();
    await sessions.start(contents, 'a', OPTIONS);
    await expect(sessions.rewind(contents, 'a', 'u2', 'both')).rejects.toThrow(
      'No checkpoint for that message',
    );
    before.mockRejectedValueOnce(new Error('That message is not in this conversation.'));
    await expect(sessions.rewind(contents, 'a', 'gone', 'conversation')).rejects.toThrow(
      /not in this conversation/,
    );
    expect(fork).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('leaves rewinding a Terminal session to its terminal', async () => {
    const sessions = manager();
    const contents = window();
    await sessions.start(contents, 'a', { ...OPTIONS, connection: 'terminal' });
    await expect(sessions.previewRewind(contents, 'a', 'u1')).rejects.toThrow(/Esc twice/);
    await expect(sessions.rewind(contents, 'a', 'u1', 'conversation')).rejects.toThrow(/Esc twice/);
  });
});
