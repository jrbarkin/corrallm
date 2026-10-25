import { legacyDirectories } from './workspaces/test-directories';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import type { FilesRewind, SessionMode } from '../../shared/session';
import type { Connector, LiveSession } from '../sessions/connector';
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
  canvases: [CANVAS],
};
const YOU = CALLERS.you;

/** Another canvas, on the same project folder. */
const OTHER = '3f1a2b3c-4d5e-4f60-8a1b-2c3d4e5f6a7b' as CanvasId;

/** Three Claude Code agents on the Agent SDK, sharing the faked project directory. */
function canvasText(): string {
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
    nodes: [agent('a', 'Builder', 0), agent('b', 'Reviewer', 300), agent('c', 'Tester', 600)],
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

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-control-'));
  project = path.join(profile, 'project');
  await mkdir(path.join(project, 'src'), { recursive: true });
  await writeFile(path.join(project, 'src', 'app.ts'), 'export const app = 2;\n');
  holding = undefined;
  rewinds = [];
  restore = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  holding?.resolve(undefined);
  restore?.resolve(undefined);
  for (const core of cores.splice(0)) await core.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
});

/** A connector of fakes whose sessions restore files (the Agent SDK's), each restore recorded. */
function restoring(fake: FakeConnector): Connector<SessionMode> {
  return {
    start: async (spec, host) => {
      const session: LiveSession<SessionMode> = await fake.start(spec, host);
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
  { other = false }: { other?: boolean } = {},
): Promise<{ core: Core; sdk: FakeConnector; terminal: FakeConnector }> {
  const file = path.join(profile, 'team.corral');
  await writeFile(file, canvasText());
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
        connectors: { 'claude-code.sdk': restoring(sdk), 'claude-code.terminal': terminal },
        environment: () => Promise.resolve({}),
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
      { kind: 'agent', canvas: CANVAS, agent: 'a', session: 'a-session' },
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
    const lead = { kind: 'agent', canvas: CANVAS, agent: 'a', session: 'a-session' } as const;
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
