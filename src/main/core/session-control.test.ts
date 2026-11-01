import { legacyDirectories } from './workspaces/test-directories';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_MESSAGE_BYTES } from '../../shared/api/limits';
import { RULES } from '../../shared/api/rules';
import type { CanvasId } from '../../shared/canvas';
import type { FilesRewind, McpChange, McpServer, SessionMode } from '../../shared/session';
import { MAX_MESSAGE_LENGTH } from '../../shared/session';
import type { KeptConversation } from '../sessions/adapter';
import type { Connector, LiveSession, SessionHost } from '../sessions/connector';
import { FakeConnector } from '../sessions/fake';
import { SessionManager } from '../sessions/manager';
import type { OutsideCaller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { keepCanvases } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';

/*
 * B11 C6's session services through core.call (registered normally): live and
 * saved settings, Continue in Terminal, restart and a new conversation, and rewind, with R5's
 * proposal and its stale guard, and the workspace mutation gate protecting every agent of a tree.
 */

const CANVAS = '7c2e9a41-3b5d-4f6e-8a1c-2d3e4f5a6b7c' as CanvasId;
/** A conversation remembered for the builder, and for another agent too (a copied file, say). */
const KEPT = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e31';
const ORCHESTRATOR: OutsideCaller = {
  kind: 'outside',
  token: 'write-token',
  name: 'orchestrator',
  access: 'write',
  merge: true,
  canvases: [CANVAS],
};
const YOU = CALLERS.you;

/** Another canvas, on the same project folder. */
const OTHER = '3f1a2b3c-4d5e-4f60-8a1b-2c3d4e5f6a7b' as CanvasId;

/** Three Claude Code agents on the Agent SDK, sharing the faked project directory. */
function canvasText(team = false): string {
  const agent = (id: string, label: string, x: number) => ({
    id,
    kind: 'agent',
    label,
    position: { x, y: 0 },
    adapter: 'claude-code',
    connection: 'claude-code.sdk',
  });
  return JSON.stringify({
    format: 'corrallm',
    version: 2,
    id: CANVAS,
    nodes: [
      agent('a', 'Builder', 0),
      { ...agent('b', 'Reviewer', 300), ...(team ? { parent: 'a' } : {}) },
      agent('c', 'Tester', 600),
    ],
    links: [],
  });
}

let profile: string;
let project: string;
const cores: Core[] = [];
/** Whether the fake's turns are held where they are (a turn going on), until released. */
let holding: PromiseWithResolvers<undefined> | undefined;
/** Each file restore asked of an agent's session: dry runs too. */
let rewinds: { agent: string; message: string; dryRun: boolean }[];
/** Whether a file restore (not a dry run) is held where it is, until released. */
let restore: PromiseWithResolvers<undefined> | undefined;
/** The conversations Claude Code keeps for the project folder, as its reader lists them. */
let kept: KeptConversation[];
/** Each MCP server change asked of an agent's session. */
let mcpChanges: { agent: string; name: string; change: McpChange }[];
let extraServers: McpServer[];
/** What each agent's session last told the core through: to emit what its CLI says. */
const hosts = new Map<string, SessionHost>();

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-control-'));
  project = path.join(profile, 'project');
  await mkdir(path.join(project, 'src'), { recursive: true });
  await writeFile(path.join(project, 'src', 'app.ts'), 'export const app = 2;\n');
  holding = undefined;
  rewinds = [];
  restore = undefined;
  kept = [];
  mcpChanges = [];
  extraServers = [];
  hosts.clear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  holding?.resolve(undefined);
  restore?.resolve(undefined);
  for (const core of cores.splice(0)) await core.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
});

/**
 * A connector of fakes whose sessions restore files (the Agent SDK's), each restore recorded, and
 * have two MCP servers, sentry failing until it is reconnected, each change recorded.
 */
function restoring(fake: FakeConnector): Connector<SessionMode> {
  return {
    start: async (spec, host) => {
      const session: LiveSession<SessionMode> = await fake.start(spec, host);
      hosts.set(spec.agentId, host);
      let servers: McpServer[] = [
        { name: 'github', status: 'connected', scope: 'user', tools: 2 },
        { name: 'sentry', status: 'failed', scope: 'project', error: 'Connection refused' },
        ...extraServers,
      ];
      session.mcpServers = () => Promise.resolve(servers.map((one) => ({ ...one })));
      session.changeMcpServer = (name, change) => {
        mcpChanges.push({ agent: spec.agentId, name, change });
        servers = servers.map((one) =>
          one.name !== name
            ? one
            : change === 'disable'
              ? { name, status: 'disabled' }
              : { name, status: 'connected', scope: one.scope ?? 'project', tools: 2 },
        );
        return Promise.resolve();
      };
      session.rewindFiles = async (message, dryRun): Promise<FilesRewind> => {
        rewinds.push({ agent: spec.agentId, message, dryRun });
        if (!dryRun) {
          await restore?.promise;
          await writeFile(path.join(spec.cwd, 'src', 'app.ts'), 'export const app = 1;\n');
        }
        return { possible: true, files: ['src/app.ts'], added: 1, removed: 1 };
      };
      return session;
    },
  };
}

async function start(
  conversations: Record<string, { id: string }> = {},
  { other = false, team = false }: { other?: boolean; team?: boolean } = {},
): Promise<{ core: Core; sdk: FakeConnector; terminal: FakeConnector }> {
  const file = path.join(profile, 'team.corral');
  await writeFile(file, canvasText(team));
  // With `other`: a canvas of its own whose agent x (Writer) works in the same project folder.
  const second = path.join(profile, 'other.corral');
  if (other) {
    const text = JSON.parse(canvasText()) as { id: string; nodes: { id: string; label: string }[] };
    text.id = OTHER;
    text.nodes = [{ ...text.nodes[0], id: 'x', label: 'Writer' }];
    await writeFile(second, JSON.stringify(text));
  }
  await keepCanvases(profile, {
    [CANVAS]: { file, project, conversations: { 'claude-code': conversations } },
    ...(other ? { [OTHER]: { file: second, project } } : {}),
  });
  // A turn holds where it is while the test holds it: a turn going on.
  const step = () => holding?.promise ?? Promise.resolve();
  // In a mode that doesn't ask: its turns run to their end.
  const sdk = new FakeConnector({ step, mode: 'acceptEdits' });
  const terminal = new FakeConnector({ step, mode: 'acceptEdits' });
  const core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
      // The builder leads (B24's leads, as tests say them): it may call what a lead may.
      leads: (_canvas, agent) => agent === 'a',
      sessions: {
        // Its agent callers are made up: no session authority issued them.
        callers: () => true,
        connectors: { 'claude-code.sdk': restoring(sdk), 'claude-code.terminal': terminal },
        environment: () => Promise.resolve({}),
        // Never the user's own: what the test says Claude Code keeps for the folder.
        conversations: { 'claude-code': { list: () => Promise.resolve(kept) } },
      },
      watchFolder: () => ({ close: () => undefined }),
    },
    NO_DESKTOP,
  );
  cores.push(core);
  await core.engines.open(CANVAS);
  if (other) await core.engines.open(OTHER);
  return { core, sdk, terminal };
}

/** Calls `op` as `caller`, expecting success: its value. */
async function ok(core: Core, op: string, args: object, caller = YOU): Promise<unknown> {
  const result = await core.call(op as never, { canvas: CANVAS, ...args }, caller);
  if (!result.ok) throw new Error(`${op}: ${result.error.code}: ${result.error.sentence}`);
  return result.value;
}

/** Calls `op` as `caller`, expecting a failure: its code and sentence. */
async function fails(core: Core, op: string, args: object, caller = YOU) {
  const result = await core.call(op as never, { canvas: CANVAS, ...args }, caller);
  if (result.ok) throw new Error(`${op} succeeded`);
  return result.error;
}

/** Sends agent `to` a message as you, and waits for its turn to end: its user entry's id. */
async function turn(core: Core, to: string, body: string): Promise<string> {
  const { id } = (await ok(core, 'message', { to, body })) as { id: string };
  const open = core.engines.canvas(CANVAS);
  await vi.waitFor(() => {
    expect(open?.messages.get(id)?.state).toBe('replied');
  });
  const entry = open?.messages.get(id)?.delivery?.as;
  if (entry === undefined) throw new Error('Never delivered');
  return entry;
}

const appText = () => readFile(path.join(project, 'src', 'app.ts'), 'utf8');

describe('rewind and R5', () => {
  it('makes a token’s code rewind a proposal, restoring nothing; Allow applies it only while what it would restore is as proposed', async () => {
    const { core } = await start();
    const message = await turn(core, 'a', 'Write the app');
    // A token's code restore applies nothing: it is yours to decide.
    const proposed = (await ok(
      core,
      'session.rewind',
      { agent: 'a', message, restore: 'code' },
      ORCHESTRATOR,
    )) as { proposed: string };
    expect(proposed.proposed).toMatch(/^proposal\//);
    expect(rewinds.filter(({ dryRun }) => !dryRun)).toEqual([]);
    const { items } = (await ok(core, 'needs', {})) as { items: { id: string; title: string }[] };
    expect(items.find(({ id }) => id === proposed.proposed)?.title).toMatch(
      /orchestrator.*asks to restore Builder’s files.*1 file/,
    );

    // Newer work lands in a file it would restore: Allow settles it stale, restoring nothing.
    await writeFile(path.join(project, 'src', 'app.ts'), 'export const app = 3;\n');
    expect(
      await ok(core, 'reply', { to: proposed.proposed, answer: { choice: 'allow' } }),
    ).toMatchObject({
      outcome: 'stale',
    });
    expect(rewinds.filter(({ dryRun }) => !dryRun)).toEqual([]);
    expect(await appText()).toBe('export const app = 3;\n');

    // Proposed again over what is there now, and allowed with nothing changed: it applies, once.
    const again = (await ok(
      core,
      'session.rewind',
      { agent: 'a', message, restore: 'code' },
      ORCHESTRATOR,
    )) as { proposed: string };
    expect(again.proposed).not.toBe(proposed.proposed);
    expect(
      await ok(core, 'reply', { to: again.proposed, answer: { choice: 'allow' } }),
    ).toMatchObject({
      outcome: 'allowed',
    });
    expect(rewinds.filter(({ dryRun }) => !dryRun)).toEqual([
      { agent: 'a', message, dryRun: false },
    ]);
    expect(await appText()).toBe('export const app = 1;\n');
  });

  it('settles a proposal stale once the session it was proposed in is another, its files untouched', async () => {
    const { core } = await start();
    const message = await turn(core, 'a', 'Write the app');
    const proposed = (await ok(
      core,
      'session.rewind',
      { agent: 'a', message, restore: 'code' },
      ORCHESTRATOR,
    )) as { proposed: string };
    // Its session runs another way since: what it was proposed of isn't what is there now.
    await ok(core, 'session.continueIn', { agent: 'a', connection: 'claude-code.terminal' });
    expect(
      await ok(core, 'reply', { to: proposed.proposed, answer: { choice: 'allow' } }),
    ).toMatchObject({ outcome: 'stale' });
    expect(rewinds.filter(({ dryRun }) => !dryRun)).toEqual([]);
    expect(await appText()).toBe('export const app = 2;\n');
  });

  it('refuses an agent’s rewind of its own session (R6) before R5 could propose it', async () => {
    const { core } = await start();
    const message = await turn(core, 'a', 'Write the app');
    const own = await fails(
      core,
      'session.rewind',
      { agent: 'a', message, restore: 'code' },
      { kind: 'agent', canvas: CANVAS, agent: 'a', generation: 1, session: 'a-session' },
    );
    expect(own.code).toBe('refused');
    expect(own.sentence).toMatch(/on itself/);
    expect(rewinds).toEqual([]);
    const { items } = (await ok(core, 'needs', {})) as { items: { kind: string }[] };
    expect(items.filter(({ kind }) => kind === 'proposal')).toEqual([]);
  });

  it('refuses your code rewind while another agent working in that folder has a turn going on, restoring nothing, and protects it until it is idle', async () => {
    const { core } = await start();
    const message = await turn(core, 'a', 'Write the app');
    // The reviewer works in the same folder: its turn goes on.
    holding = Promise.withResolvers<undefined>();
    const { id: reviewing } = (await ok(core, 'message', { to: 'b', body: 'Review it' })) as {
      id: string;
    };
    const open = core.engines.canvas(CANVAS);
    await vi.waitFor(() => {
      expect(open?.engine.sessions.of('b').status).toBe('working');
    });
    const refused = await fails(core, 'session.rewind', { agent: 'a', message, restore: 'code' });
    expect(refused).toMatchObject({ code: 'unavailable' });
    expect(refused.sentence).toMatch(/Reviewer has a turn going on/);
    expect(rewinds.filter(({ dryRun }) => !dryRun)).toEqual([]);
    expect(await appText()).toBe('export const app = 2;\n');

    holding.resolve(undefined);
    holding = undefined;
    await vi.waitFor(() => {
      expect(open?.messages.get(reviewing)?.state).toBe('replied');
    });
    expect(
      await ok(core, 'session.rewind', { agent: 'a', message, restore: 'code' }),
    ).toMatchObject({
      conversation: false,
      files: { files: ['src/app.ts'] },
    });
    expect(await appText()).toBe('export const app = 1;\n');
  });
  it('protects an agent of another canvas working in the same folder: refused while its turn goes on, its new work held while it restores', async () => {
    const { core, sdk } = await start({}, { other: true });
    const message = await turn(core, 'a', 'Write the app');
    const other = core.engines.canvas(OTHER);
    // The other canvas's writer works in the same project folder: its turn goes on.
    holding = Promise.withResolvers<undefined>();
    const writing = await core.call('message', { canvas: OTHER, to: 'x', body: 'Edit it' }, YOU);
    if (!writing.ok) throw new Error(writing.error.sentence);
    await vi.waitFor(() => {
      expect(other?.engine.sessions.of('x').status).toBe('working');
    });
    const refused = await fails(core, 'session.rewind', { agent: 'a', message, restore: 'code' });
    expect(refused).toMatchObject({ code: 'unavailable' });
    expect(refused.sentence).toMatch(/an agent on another canvas has a turn going on/);
    expect(rewinds.filter(({ dryRun }) => !dryRun)).toEqual([]);
    expect(await appText()).toBe('export const app = 2;\n');
    holding.resolve(undefined);
    holding = undefined;
    await vi.waitFor(() => {
      expect(other?.engine.sessions.of('x').status).toBe('idle');
    });

    // While it restores, the other canvas's writer's new work waits for it.
    restore = Promise.withResolvers<undefined>();
    const rewinding = ok(core, 'session.rewind', { agent: 'a', message, restore: 'code' });
    await vi.waitFor(() => {
      expect(rewinds.some(({ dryRun }) => !dryRun)).toBe(true);
    });
    other?.engine.sessions.send('x', 'claude-code', 'Edit it again');
    const sentX = () =>
      sdk.sessions
        .filter((_session, at) => sdk.started[at]?.agentId === 'x')
        .flatMap((session) => session.sent.map(({ text }) => text));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sentX()).toEqual(['Edit it']);
    restore.resolve(undefined);
    await rewinding;
    await vi.waitFor(() => {
      expect(sentX()).toEqual(['Edit it', 'Edit it again']);
    });
  });

  it('holds new work for the agent whose files it restores until the restore is done', async () => {
    const { core, sdk } = await start();
    const message = await turn(core, 'a', 'Write the app');
    restore = Promise.withResolvers<undefined>();
    const rewinding = ok(core, 'session.rewind', { agent: 'a', message, restore: 'code' });
    await vi.waitFor(() => {
      expect(rewinds.some(({ dryRun }) => !dryRun)).toBe(true);
    });
    // Its run hands it its next task meanwhile (as once another agent's turn ends): it waits.
    const open = core.engines.canvas(CANVAS);
    open?.engine.sessions.send('a', 'claude-code', 'Next task');
    const sent = () => sdk.sessions.flatMap((session) => session.sent.map(({ text }) => text));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent()).toEqual(['Write the app']);
    restore.resolve(undefined);
    await rewinding;
    expect(await appText()).toBe('export const app = 1;\n');
    await vi.waitFor(() => {
      expect(sent()).toEqual(['Write the app', 'Next task']);
    });
  });
});

describe('reach', () => {
  it('lets a token name only an entry or task of the agent named beside it, on an agent it reaches', async () => {
    const { core } = await start();
    const own = await turn(core, 'a', 'Write the app');
    const others = await turn(core, 'b', 'Review it');
    // The builder leads, reaching itself alone here (nothing is linked to it).
    const lead = {
      kind: 'agent',
      canvas: CANVAS,
      agent: 'a',
      generation: 1,
      session: 'a-session',
    } as const;
    expect(
      await ok(core, 'session.rewindPreview', { agent: 'a', message: own }, lead),
    ).toMatchObject({ possible: true });
    // Another agent's entry, named beside itself, or beside the agent the entry is of: neither.
    for (const [agent, message] of [
      ['a', others],
      ['b', others],
    ] as const) {
      const refused = await fails(core, 'session.rewindPreview', { agent, message }, lead);
      expect(refused.code).toBe('not-found');
    }
    const task = await fails(core, 'session.stopTask', { agent: 'b', task: 'task-1' }, lead);
    expect(task.code).toBe('not-found');
  });
});

describe('Continue in Terminal', () => {
  it('delivers the exact human composer-bound input once through core.call', async () => {
    const { core, terminal } = await start();
    const text = `  !${'é'.repeat(MAX_MESSAGE_LENGTH - 6)}\n  `;
    expect(text).toHaveLength(MAX_MESSAGE_LENGTH);
    const result = (await ok(core, 'session.continueIn', {
      agent: 'a',
      connection: 'claude-code.terminal',
      then: { text },
    })) as { id: string };
    await vi.waitFor(() => {
      expect(terminal.sessions.flatMap(({ sent }) => sent)).toHaveLength(1);
    });
    expect(terminal.sessions[0]?.sent[0]?.text).toBe(text);
    expect(core.engines.canvas(CANVAS)?.messages.get(result.id)?.body).toBe(text);
  });

  it('switches the connection first, then sends the typed input once, to the new session, however often its request repeats', async () => {
    const { core, sdk, terminal } = await start();
    await ok(core, 'session.open', { agent: 'a' });
    expect(sdk.started.map(({ agentId }) => agentId)).toEqual(['a']);
    const request = crypto.randomUUID();
    const order: string[] = [];
    const open = core.engines.canvas(CANVAS);
    const switched = () =>
      open?.document.nodes.find((node) => node.id === 'a')?.type === 'agent' &&
      (open.document.nodes.find((node) => node.id === 'a') as { data: { connection?: string } })
        .data.connection === 'claude-code.terminal';
    vi.spyOn(terminal, 'start').mockImplementation(function (this: FakeConnector, spec, host) {
      order.push(switched() ? 'started after the switch' : 'started before the switch');
      return FakeConnector.prototype.start.call(this, spec, host);
    });
    const first = (await ok(core, 'session.continueIn', {
      agent: 'a',
      connection: 'claude-code.terminal',
      then: { text: '/login' },
      request,
    })) as { id: string };
    expect(first.id).toEqual(expect.any(String));
    expect(order).toEqual(['started after the switch']);
    await vi.waitFor(() => {
      expect(open?.messages.get(first.id)?.state).toBe('replied');
    });
    expect(terminal.sessions.flatMap(({ sent }) => sent.map(({ text }) => text))).toEqual([
      '/login',
    ]);
    expect(sdk.sessions.flatMap(({ sent }) => sent)).toEqual([]);
    // Yours, as you typed it.
    expect(open?.messages.originOf(first.id)).toBe('manual');

    // The same request again (a retry after its answer was lost): nothing sent twice.
    const second = (await ok(core, 'session.continueIn', {
      agent: 'a',
      connection: 'claude-code.terminal',
      then: { text: '/login' },
      request,
    })) as { id: string };
    expect(second.id).toBe(first.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(terminal.sessions.flatMap(({ sent }) => sent)).toHaveLength(1);
  });

  it('is yours alone', async () => {
    const { core } = await start();
    const refused = await fails(
      core,
      'session.continueIn',
      { agent: 'a', connection: 'claude-code.terminal' },
      ORCHESTRATOR,
    );
    expect(refused.code).toBe('human-only');
  });
});

describe('restart and a new conversation', () => {
  it('restarts an idle session on its own conversation, which no other agent takes meanwhile', async () => {
    const { core, sdk } = await start({ a: { id: KEPT }, b: { id: KEPT } });
    await ok(core, 'session.open', { agent: 'a' });
    expect(sdk.started.at(-1)).toMatchObject({ agentId: 'a', resume: KEPT });
    await ok(core, 'session.restart', { agent: 'a' });
    expect(sdk.started.at(-1)).toMatchObject({ agentId: 'a', resume: KEPT });
    // Its conversation stayed its own: another agent remembering it starts a new one.
    await ok(core, 'session.open', { agent: 'b' });
    expect(sdk.started.at(-1)).toMatchObject({ agentId: 'b', resume: null });
  });

  it('refuses a restart or a new conversation while a turn goes on, changing nothing', async () => {
    const { core, sdk } = await start();
    holding = Promise.withResolvers<undefined>();
    await ok(core, 'message', { to: 'a', body: 'Keep working' });
    const open = core.engines.canvas(CANVAS);
    await vi.waitFor(() => {
      expect(open?.engine.sessions.of('a').status).toBe('working');
    });
    for (const op of ['session.restart', 'session.newConversation']) {
      const refused = await fails(core, op, { agent: 'a' });
      expect(refused.code).toBe('refused');
      expect(refused.sentence).toMatch(/Builder has a turn going on/);
    }
    expect(sdk.started).toHaveLength(1);
  });

  it('refuses to close a session its next launch would be held from (a rebind waiting), closing nothing', async () => {
    const { core, sdk } = await start({ a: { id: KEPT } });
    await ok(core, 'session.open', { agent: 'a' });
    const pending =
      'This agent’s workspace changes once you approve it: its new work waits until then.';
    vi.spyOn(SessionManager.prototype, 'availability').mockResolvedValue({
      ready: false,
      reason: 'pending-change',
      sentence: pending,
    });
    const close = vi.spyOn(SessionManager.prototype, 'close');
    for (const op of ['session.restart', 'session.newConversation']) {
      const refused = await fails(core, op, { agent: 'a' });
      expect(refused.code).toBe('unavailable');
      expect(refused.sentence).toContain(pending);
    }
    expect(close).not.toHaveBeenCalled();
    expect(sdk.started).toHaveLength(1);
  });

  it('refuses a new conversation or a restart once a turn started while it checked, never reporting one it didn’t do', async () => {
    const { core, sdk } = await start({ a: { id: KEPT } });
    await ok(core, 'session.open', { agent: 'a' });
    const open = core.engines.canvas(CANVAS);
    // While it reads whether its next launch would be held, its run hands it a task: a turn goes on.
    holding = Promise.withResolvers<undefined>();
    vi.spyOn(SessionManager.prototype, 'availability').mockImplementation(() => {
      if (open?.engine.sessions.of('a').status === 'idle') {
        open.engine.sessions.send('a', 'claude-code', 'Next task');
      }
      return Promise.resolve({ ready: true });
    });
    for (const op of ['session.newConversation', 'session.restart']) {
      const refused = await fails(core, op, { agent: 'a' });
      expect(refused.code).toBe('refused');
      expect(refused.sentence).toMatch(/Builder has a turn going on/);
    }
    // Its session and conversation are as they were: one start, resuming what it remembered.
    expect(sdk.started.map(({ resume }) => resume)).toEqual([KEPT]);
  });

  it('starts a new conversation, forgetting only the remembered one', async () => {
    const { core, sdk } = await start({ a: { id: KEPT } });
    await ok(core, 'session.open', { agent: 'a' });
    await ok(core, 'session.newConversation', { agent: 'a' });
    expect(sdk.started.map(({ resume }) => resume)).toEqual([KEPT, null]);
  });
});

describe('live and saved settings', () => {
  it('changes a running session’s mode and the saved one; a mode that never asks is live only, unsetting the saved one', async () => {
    const { core } = await start();
    await ok(core, 'session.open', { agent: 'a' });
    const open = core.engines.canvas(CANVAS);
    const saved = () =>
      (
        open?.document.nodes.find((node) => node.id === 'a') as {
          data: { settings?: Record<string, { mode?: string }> };
        }
      ).data.settings?.['claude-code']?.mode;
    const changed = await ok(core, 'session.setMode', { agent: 'a', mode: 'plan' });
    expect(changed).toMatchObject({
      revs: {
        [`canvas:${CANVAS}`]: expect.any(Number) as number,
        [`sessions:${CANVAS}`]: expect.any(Number) as number,
      },
    });
    expect(open?.engine.sessions.of('a').mode).toBe('plan');
    expect(saved()).toBe('plan');
    await ok(core, 'session.setMode', { agent: 'a', mode: 'bypassPermissions' });
    expect(open?.engine.sessions.of('a').mode).toBe('bypassPermissions');
    expect(saved()).toBeUndefined();
    // Yours alone (D9).
    expect(
      await fails(core, 'session.setMode', { agent: 'a', mode: 'plan' }, ORCHESTRATOR),
    ).toMatchObject({ code: 'human-only' });
  });

  it('changes nothing saved when the live change fails, and says so', async () => {
    const { core, sdk } = await start();
    await ok(core, 'session.open', { agent: 'a' });
    const [session] = sdk.sessions;
    if (session === undefined) throw new Error('No session');
    const failing = vi
      .spyOn(session, 'setModel')
      .mockRejectedValue(new Error('That model is unavailable.'));
    const refused = await fails(core, 'session.setModel', { agent: 'a', model: 'fast' });
    expect(refused).toMatchObject({ code: 'unavailable' });
    expect(refused.sentence).toMatch(/nothing changed: That model is unavailable/);
    const node = core.engines.canvas(CANVAS)?.document.nodes.find((one) => one.id === 'a') as {
      data: { settings?: unknown };
    };
    expect(node.data.settings).toBeUndefined();
    failing.mockRestore();
    await ok(core, 'session.setModel', { agent: 'a', model: 'fast' });
    expect(core.engines.canvas(CANVAS)?.engine.sessions.of('a').model).toBe('fast');
  });
});

describe('your messages (R22, B11 §16.6)', () => {
  /** One small PNG, base64: what a pasted screenshot is to the API. */
  const IMAGE = { mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' };

  it('admits your long message with its images as yours, once, and keeps it a Message row', async () => {
    const { core, sdk } = await start();
    await ok(core, 'session.open', { agent: 'a' });
    // Longer than a token's 16 KiB, within your composer's 200,000 characters.
    const body = `${'x'.repeat(MAX_MESSAGE_BYTES)} and more`;
    const { id } = (await ok(core, 'message', { to: 'a', body, images: [IMAGE] })) as {
      id: string;
    };
    const open = core.engines.canvas(CANVAS);
    expect(open?.messages.get(id)).toMatchObject({ from: 'you', to: 'agent:a', body });
    expect(open?.messages.originOf(id)).toBe('manual');
    await vi.waitFor(() => {
      expect(sdk.sessions[0]?.sent).toEqual([
        expect.objectContaining({ text: body, images: [IMAGE] }),
      ]);
    });
    // Only text or images make a message.
    expect(await fails(core, 'message', { to: 'a', body: ' ' })).toMatchObject({
      code: 'invalid',
    });
    expect(
      await fails(core, 'message', { to: 'a', body: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) }),
    ).toMatchObject({ code: 'invalid' });
  });

  it('refuses a token’s message over 16 KiB, or with images (human-text), sending nothing', async () => {
    const { core, sdk } = await start();
    await ok(core, 'session.open', { agent: 'a' });
    const long = await fails(
      core,
      'message',
      { to: 'a', body: 'x'.repeat(MAX_MESSAGE_BYTES + 1) },
      ORCHESTRATOR,
    );
    expect(long).toEqual({ code: 'refused', sentence: RULES['human-text'].sentence });
    const pasted = await fails(
      core,
      'message',
      { to: 'a', body: 'Look', images: [IMAGE] },
      ORCHESTRATOR,
    );
    expect(pasted).toEqual({ code: 'refused', sentence: RULES['human-text'].sentence });
    expect(sdk.sessions[0]?.sent ?? []).toEqual([]);
    // Its own 16 KiB is a party's message as it was.
    await ok(core, 'message', { to: 'a', body: 'x'.repeat(MAX_MESSAGE_BYTES) }, ORCHESTRATOR);
  });

  it('refuses images its recipient’s connection takes none of, before anything is kept', async () => {
    const { core } = await start();
    await ok(core, 'session.continueIn', { agent: 'b', connection: 'claude-code.terminal' });
    const before = core.engines.canvas(CANVAS)?.messages.all().length;
    const refused = await fails(core, 'message', { to: 'b', body: 'Look', images: [IMAGE] });
    expect(refused.code).toBe('refused');
    expect(refused.sentence).toMatch(/Reviewer.*takes no images/);
    expect(core.engines.canvas(CANVAS)?.messages.all().length).toBe(before);
  });
});

describe('conversations, resume and options', () => {
  const NEWER = '6e2f8d4b-0c3a-4f7e-9b2d-4a5f6e7d8c9b';
  const AGENT_A = {
    kind: 'agent',
    canvas: CANVAS,
    agent: 'a',
    generation: 1,
    session: 'a-session',
  } as const;

  it('lists the agent’s conversations in its workspace, and resumes one only for a caller it was listed to', async () => {
    kept = [
      { id: NEWER, title: 'Newer work', modified: 2 },
      { id: KEPT, title: 'The builder’s own', modified: 1 },
    ];
    const { core, sdk } = await start({ a: { id: KEPT } });
    await ok(core, 'session.open', { agent: 'a' });
    expect(await ok(core, 'session.conversations', { agent: 'a' })).toEqual({
      items: [
        { id: NEWER, title: 'Newer work', modified: 2, current: false },
        { id: KEPT, title: 'The builder’s own', modified: 1, current: true },
      ],
    });
    // Listed to you: a token that wasn't listed it reaches none of it.
    expect(
      await fails(
        core,
        'session.resumeConversation',
        { agent: 'a', conversation: NEWER },
        ORCHESTRATOR,
      ),
    ).toMatchObject({ code: 'not-found' });
    expect(sdk.started).toHaveLength(1);
    // A token's list contains only this agent's recorded starts, not the person's other work.
    expect(await ok(core, 'session.conversations', { agent: 'a' }, ORCHESTRATOR)).toEqual({
      items: [{ id: KEPT, title: 'The builder’s own', modified: 1, current: true }],
    });
    expect(
      await fails(
        core,
        'session.resumeConversation',
        { agent: 'a', conversation: NEWER },
        ORCHESTRATOR,
      ),
    ).toMatchObject({ code: 'not-found' });
    await ok(core, 'session.resumeConversation', { agent: 'a', conversation: KEPT }, ORCHESTRATOR);
    expect(sdk.started.at(-1)?.resume).toBe(KEPT);
    expect(core.engines.canvas(CANVAS)?.engine.sessions.of('a').status).toBe('idle');
    // Yours too, from your own list; a conversation never listed isn't one to resume.
    await ok(core, 'session.resumeConversation', { agent: 'a', conversation: NEWER });
    expect(sdk.started.at(-1)?.resume).toBe(NEWER);
    expect(
      await fails(core, 'session.resumeConversation', {
        agent: 'a',
        conversation: '7f3a9e5c-1d4b-4a8f-8c3e-5b6a7f8e9d0c',
      }),
    ).toMatchObject({ code: 'not-found' });
    // No agent gets the list (O), nor resumes (W).
    expect(await fails(core, 'session.conversations', { agent: 'b' }, AGENT_A)).toMatchObject({
      code: 'forbidden',
    });
  });

  it('does not treat a remembered id or the GUI’s list as a recorded native start', async () => {
    kept = [{ id: KEPT, title: 'Remembered', modified: 1 }];
    const { core, sdk } = await start({ a: { id: KEPT } });
    expect(await ok(core, 'session.conversations', { agent: 'a' })).toEqual({
      items: [{ ...kept[0], current: true }],
    });
    expect(await ok(core, 'session.conversations', { agent: 'a' }, ORCHESTRATOR)).toEqual({
      items: [],
    });
    expect(
      await fails(
        core,
        'session.resumeConversation',
        { agent: 'a', conversation: KEPT },
        ORCHESTRATOR,
      ),
    ).toMatchObject({ code: 'not-found' });
    expect(sdk.started).toEqual([]);
    await ok(core, 'session.open', { agent: 'a' });
    expect(await ok(core, 'session.conversations', { agent: 'a' }, ORCHESTRATOR)).toEqual({
      items: [{ ...kept[0], current: true }],
    });
  });

  it('keeps a token’s earlier started conversations after Fresh, without admitting another agent’s', async () => {
    const { core, sdk } = await start({ a: { id: KEPT } });
    await ok(core, 'session.open', { agent: 'a' });
    await ok(core, 'session.newConversation', { agent: 'a' });
    const newer = sdk.ids.at(-1);
    if (!newer || newer === KEPT) throw new Error('Fresh did not start a new conversation');
    await ok(core, 'session.open', { agent: 'b' });
    const other = sdk.ids.at(-1);
    if (!other) throw new Error('No other conversation');
    kept = [
      { id: newer, title: 'New', modified: 3 },
      { id: other, title: 'Other agent', modified: 2 },
      { id: KEPT, title: 'Earlier', modified: 1 },
    ];
    expect(await ok(core, 'session.conversations', { agent: 'a' }, ORCHESTRATOR)).toEqual({
      items: [
        { id: newer, title: 'New', modified: 3, current: true },
        { id: KEPT, title: 'Earlier', modified: 1, current: false },
      ],
    });
    await ok(core, 'session.resumeConversation', { agent: 'a', conversation: KEPT }, ORCHESTRATOR);
    expect(sdk.started.at(-1)?.resume).toBe(KEPT);
  });

  it('refuses a resume while a turn goes on, or of a conversation another agent holds, closing nothing', async () => {
    kept = [{ id: NEWER, title: 'The reviewer’s', modified: 2 }];
    const { core, sdk } = await start({ b: { id: NEWER } });
    await ok(core, 'session.open', { agent: 'b' });
    await ok(core, 'session.open', { agent: 'a' });
    await ok(core, 'session.conversations', { agent: 'a' });
    const started = sdk.started.length;
    const held = await fails(core, 'session.resumeConversation', {
      agent: 'a',
      conversation: NEWER,
    });
    expect(held).toEqual({
      code: 'conflict',
      sentence: 'That conversation is open in "Reviewer": two agents never share one conversation.',
    });
    holding = Promise.withResolvers();
    await ok(core, 'message', { to: 'a', body: 'Work' });
    await vi.waitFor(() => {
      expect(core.engines.canvas(CANVAS)?.engine.sessions.of('a').status).toBe('working');
    });
    const busy = await fails(core, 'session.resumeConversation', {
      agent: 'a',
      conversation: NEWER,
    });
    expect(busy).toMatchObject({ code: 'refused' });
    expect(busy.sentence).toMatch(/Builder has a turn going on/);
    expect(sdk.started).toHaveLength(started);
  });

  it('reads an adapter’s options in the agent’s workspace, or the project’s', async () => {
    const { core } = await start();
    const options = (await ok(core, 'session.options', { adapter: 'claude-code' })) as {
      models: unknown[];
      defaults: object;
    };
    expect(options).toEqual({
      models: expect.any(Array) as unknown,
      defaults: expect.any(Object) as unknown,
    });
    expect(await ok(core, 'session.options', { agent: 'a', adapter: 'claude-code' })).toEqual(
      options,
    );
    expect(await fails(core, 'session.options', { adapter: 'nope' })).toMatchObject({
      code: 'invalid',
    });
  });
});

describe('MCP servers (/mcp)', () => {
  const transcriptText = (core: Core, agent: string) =>
    (core.engines.canvas(CANVAS)?.engine.sessions.of(agent).entries ?? []).flatMap((entry) =>
      entry.kind === 'notice' ? [entry.text] : [],
    );

  it('lists a session’s servers, and changes one it reports, answering with them all as they are then', async () => {
    const { core } = await start();
    await ok(core, 'session.open', { agent: 'b' });
    expect(await ok(core, 'session.mcpServers', { agent: 'b' })).toEqual({
      items: [
        { name: 'github', status: 'connected', scope: 'user', tools: 2 },
        { name: 'sentry', status: 'failed', scope: 'project', error: 'Connection refused' },
      ],
    });
    // One operation: the change, and the servers as they are once it is made.
    const changed = (await ok(core, 'session.changeMcpServer', {
      agent: 'b',
      server: 'sentry',
      change: 'reconnect',
    })) as { items: unknown[] };
    expect(changed.items).toEqual([
      { name: 'github', status: 'connected', scope: 'user', tools: 2 },
      { name: 'sentry', status: 'connected', scope: 'project', tools: 2 },
    ]);
    expect(mcpChanges).toEqual([{ agent: 'b', name: 'sentry', change: 'reconnect' }]);
    expect(transcriptText(core, 'b')).toContain('Reconnected the MCP server "sentry".');
    // A token's is said as its.
    await ok(
      core,
      'session.changeMcpServer',
      { agent: 'b', server: 'github', change: 'disable' },
      ORCHESTRATOR,
    );
    expect(transcriptText(core, 'b')).toContain('"orchestrator" disabled the MCP server "github".');
  });

  it.each(['reconnect', 'disable', 'enable'] as const)(
    'keeps corrallm’s own MCP entry yours alone: %s',
    async (change) => {
      extraServers = [
        { name: 'corrallm-server', status: 'connected' },
        { name: 'corrallm', status: 'connected' },
      ];
      const { core } = await start({}, { team: true });
      await ok(core, 'session.open', { agent: 'b' });
      for (const server of ['corrallm-server', 'corrallm'])
        for (const caller of [
          ORCHESTRATOR,
          { kind: 'agent', canvas: CANVAS, agent: 'a', generation: 1, session: 'lead-session' },
        ] as const) {
          const error = await fails(
            core,
            'session.changeMcpServer',
            { agent: 'b', server, change },
            caller,
          );
          expect(error).toMatchObject({ code: 'refused' });
          expect(error.sentence).toContain('corrallm');
        }
      expect(mcpChanges).toEqual([]);
      await ok(core, 'session.changeMcpServer', { agent: 'b', server: 'corrallm-server', change });
      expect(mcpChanges).toEqual([{ agent: 'b', name: 'corrallm-server', change }]);
    },
  );

  it('acts only on a server the session reports, on a connection that shows them, never on its own', async () => {
    const { core } = await start();
    await ok(core, 'session.open', { agent: 'a' });
    expect(
      await fails(core, 'session.changeMcpServer', {
        agent: 'a',
        server: 'nowhere',
        change: 'enable',
      }),
    ).toMatchObject({ code: 'not-found' });
    // An agent never changes its own (R6).
    expect(
      await fails(
        core,
        'session.changeMcpServer',
        { agent: 'a', server: 'sentry', change: 'disable' },
        { kind: 'agent', canvas: CANVAS, agent: 'a', generation: 1, session: 'a-session' },
      ),
    ).toMatchObject({ code: 'refused' });
    // A Terminal's are its terminal's own /mcp.
    await ok(core, 'session.continueIn', { agent: 'c', connection: 'claude-code.terminal' });
    expect(await fails(core, 'session.mcpServers', { agent: 'c' })).toMatchObject({
      code: 'refused',
    });
    expect(mcpChanges).toEqual([]);
  });
});

describe('commands the agent view answers itself', () => {
  it('records your /mcp as your message, settled at once and never sent to the CLI', async () => {
    const { core, sdk } = await start();
    await ok(core, 'session.open', { agent: 'a' });
    const { id } = (await ok(core, 'session.viewCommand', { agent: 'a', text: '/mcp' })) as {
      id: string;
    };
    const open = core.engines.canvas(CANVAS);
    expect(open?.messages.get(id)).toMatchObject({
      from: 'you',
      to: 'agent:a',
      kind: 'text',
      body: '/mcp',
      state: 'replied',
      turn: { status: 'completed', reason: 'completed' },
    });
    expect(open?.messages.originOf(id)).toBe('manual');
    expect(sdk.sessions[0]?.sent).toEqual([]);
    expect(open?.engine.sessions.of('a').status).toBe('idle');
  });

  it('records only a command its connection’s view answers, and only yours', async () => {
    const { core } = await start();
    for (const text of ['/hello', 'mcp', '/mcp/x'])
      expect(await fails(core, 'session.viewCommand', { agent: 'a', text })).toMatchObject({
        code: 'invalid',
      });
    // A Terminal answers its own /mcp in its terminal.
    await ok(core, 'session.continueIn', { agent: 'b', connection: 'claude-code.terminal' });
    expect(await fails(core, 'session.viewCommand', { agent: 'b', text: '/mcp' })).toMatchObject({
      code: 'invalid',
    });
    expect(
      await fails(core, 'session.viewCommand', { agent: 'a', text: '/mcp' }, ORCHESTRATOR),
    ).toMatchObject({ code: 'human-only' });
  });
});

describe('what your session view shows beside its state', () => {
  const ask = {
    kind: 'permission' as const,
    id: 'perm-1',
    tool: 'Bash',
    summary: 'npm test',
  };

  it('gives you the CLI’s suggestion and its terminal’s asks in the summary, and a token neither', async () => {
    const { core } = await start();
    await ok(core, 'session.open', { agent: 'a' });
    hosts.get('a')?.emit({ type: 'suggestion', text: 'Run the tests' });
    hosts.get('a')?.emit({ type: 'asking', asks: [ask] });
    await vi.waitFor(async () => {
      expect(await ok(core, 'session.get', { agent: 'a' })).toMatchObject({
        suggestion: 'Run the tests',
        asking: [ask],
        prompts: 1,
      });
    });
    const theirs = await ok(core, 'session.get', { agent: 'a' }, ORCHESTRATOR);
    expect(theirs).toMatchObject({ prompts: 1 });
    expect(theirs).not.toHaveProperty('suggestion');
    expect(theirs).not.toHaveProperty('asking');
    // So do the topics a window reads, read as each would follow them.
    for (const topic of [`sessions:${CANVAS}`, `session:${CANVAS}:a`] as const) {
      const yours = await core.topics.read(topic, YOU);
      const token = await core.topics.read(topic, ORCHESTRATOR);
      expect(JSON.stringify(yours)).toContain('Run the tests');
      expect(JSON.stringify(yours)).toContain('perm-1');
      expect(token.ok).toBe(true);
      expect(JSON.stringify(token)).not.toContain('Run the tests');
      expect(JSON.stringify(token)).not.toContain('perm-1');
    }
  });
});
