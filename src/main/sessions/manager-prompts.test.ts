import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionId } from '../../shared/adapter';
import { newCanvasId } from '../../shared/canvas';
import type { CanvasId } from '../../shared/canvas';
import type { PromptAnswer } from '../../shared/model/prompts';
import type { SessionEvent, SessionMode, SessionOptions } from '../../shared/session';
import { mintTrustedPath } from '../core/host';
import type { Store } from '../core/store/store';
import { openTestStore } from '../core/store/test-store';
import type { DirectoryResolver } from '../core/workspaces/resolver';
import { CanvasMemory } from '../memory';
import { CATALOG } from './adapters';
import type { Connector, LiveSession, PromptAnswers, SessionHost } from './connector';
import { FakeConnector } from './fake';
import { SessionManager } from './manager';
import type { PromptOrigin, PromptSink } from './manager';

/*
 * The session manager's side of B13 C3: each prompt a session raises or ends goes to the core's
 * prompt owner with the generation that raised it, the mode that generation started in (captured
 * once) and its own session's answers, bound as it was raised; every generation's end, however it
 * comes, ends its prompts; and with no owner to hear them, what a session raises is declined.
 */

const KEY = '0f6b1e2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const PROMPT = {
  kind: 'approval',
  title: 'Run it?',
  answerIn: 'api',
  choices: [
    { value: 'yes', label: 'Yes', hint: 'allow_once', effects: {} },
    { value: 'no', label: 'No', hint: 'reject_once', effects: {} },
  ],
};

let dir: string;
let store: Store;
let memory: CanvasMemory;
let heard: [string, SessionEvent][];
let raised: [PromptOrigin, unknown][];
let ended: [PromptOrigin, unknown][];
let gone: [string, number][];
let activity: number;

const sink: PromptSink = {
  raised: (at, event) => {
    raised.push([at, event]);
  },
  ended: (at, event) => {
    ended.push([at, event]);
  },
  gone: (_canvas, agent, generation) => {
    gone.push([agent, generation]);
  },
};

const directories: DirectoryResolver = {
  workingDirectory: () =>
    Promise.resolve({
      state: 'ready',
      cwd: mintTrustedPath('/work/app'),
      workspace: null,
      generation: 0,
      branch: null,
    }),
  onAvailability: () => () => undefined,
  projectRoot: () => mintTrustedPath('/work/app'),
};

function manager(
  connectors: Partial<Record<ConnectionId, Connector>>,
  owner = true,
): SessionManager {
  return new SessionManager({
    catalog: CATALOG,
    connectors,
    environment: () => Promise.resolve({}),
    adapterOf: () => Promise.resolve('claude-code'),
    directories,
    memory,
    closeMs: 20,
    emit: (_canvas, agent, _connection, event) => {
      heard.push([agent, event]);
    },
    activity: () => {
      activity += 1;
    },
    ...(owner ? { prompts: sink } : {}),
  });
}

/** A session that raises prompts as the test says, recording what it is answered and declined. */
interface Raising extends LiveSession<SessionMode> {
  host: SessionHost;
  answered: [string, PromptAnswer][];
  declined: [string, string][];
}

/**
 * A connector whose sessions answer prompts on their own `prompts`; `starting`, when given, runs
 * as its session starts, before the start resolves (a raise as a session starts).
 */
function raising(starting?: (host: SessionHost) => Promise<void> | void) {
  const fake = new FakeConnector({ mode: 'plan' });
  const sessions: Raising[] = [];
  const connector: Connector<SessionMode> = {
    start: async (spec, host) => {
      await starting?.(host);
      const session = (await fake.start(spec, host)) as Raising;
      const answers: PromptAnswers = {
        answer: (key, answer) => {
          session.answered.push([key, answer]);
        },
        decline: (key, why) => {
          session.declined.push([key, why]);
        },
      };
      Object.assign(session, { host, answered: [], declined: [], prompts: answers });
      sessions.push(session);
      return session;
    },
  };
  return { connector, sessions };
}

const SDK: SessionOptions = { connection: 'claude-code.sdk', model: null, mode: null };
const TERMINAL: SessionOptions = { connection: 'claude-code.terminal', model: null, mode: null };

function at(index: number, list: Raising[]): Raising {
  const found = list[index];
  if (found === undefined) throw new Error(`no session ${String(index)}`);
  return found;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-manager-prompts-'));
  store = await openTestStore(dir);
  memory = new CanvasMemory(store);
  heard = [];
  raised = [];
  ended = [];
  gone = [];
  activity = 0;
});

afterEach(async () => {
  await memory.flush();
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

describe('prompts a session raises', () => {
  it('go to the owner with their generation, connection and start mode (captured once), never to a window', async () => {
    const { connector, sessions } = raising();
    const sessionManager = manager({ 'claude-code.sdk': connector });
    const canvas: CanvasId = newCanvasId();
    await sessionManager.start(canvas, 'b', SDK);
    const session = at(0, sessions);
    const generation = sessionManager.generationOf(canvas, 'b');
    // Its mode changes as it runs, and it says it started again: its start mode stays the first.
    session.host.emit({ type: 'mode', mode: 'acceptEdits' });
    session.host.emit({ type: 'started', model: 'default', mode: 'bypassPermissions', models: [] });
    const event = { type: 'prompt' as const, key: KEY, prompt: PROMPT as never };
    session.host.emit(event);
    session.host.emit({ type: 'prompt-ended', key: KEY, reason: 'withdrawn' });
    expect(raised).toEqual([
      [
        expect.objectContaining({
          canvas,
          agent: 'b',
          connection: 'claude-code.sdk',
          generation,
          live: true,
          startMode: 'plan',
        }),
        event,
      ],
    ]);
    expect(ended).toEqual([
      [
        expect.objectContaining({ generation }),
        { type: 'prompt-ended', key: KEY, reason: 'withdrawn' },
      ],
    ]);
    expect(heard.map(([, one]) => one.type)).not.toContain('prompt');
    expect(heard.map(([, one]) => one.type)).not.toContain('prompt-ended');
    // A raise is the CLI's activity, for the silent-turn watchdog.
    expect(activity).toBeGreaterThan(0);
    await sessionManager.closeCanvas(canvas);
  });

  it('are answered on the session that raised them, never a later one', async () => {
    const { connector, sessions } = raising();
    const sessionManager = manager({ 'claude-code.sdk': connector });
    const canvas = newCanvasId();
    await sessionManager.start(canvas, 'b', SDK);
    at(0, sessions).host.emit({ type: 'prompt', key: KEY, prompt: PROMPT as never });
    const [first] = raised[0] ?? [];
    // The agent's session starts again: another generation, another session.
    await sessionManager.close(canvas, 'b');
    await sessionManager.start(canvas, 'b', SDK);
    at(1, sessions).host.emit({ type: 'prompt', key: KEY, prompt: PROMPT as never });
    const [second] = raised[1] ?? [];
    first?.answers.answer(KEY, { kind: 'choice', value: 'yes' });
    expect(at(0, sessions).answered).toEqual([[KEY, { kind: 'choice', value: 'yes' }]]);
    expect(at(1, sessions).answered).toEqual([]);
    second?.answers.answer(KEY, { kind: 'choice', value: 'no' });
    expect(at(1, sessions).answered).toEqual([[KEY, { kind: 'choice', value: 'no' }]]);
    expect(first?.generation).not.toBe(second?.generation);
    await sessionManager.closeCanvas(canvas);
  });

  it('end with their generation, however it ends', async () => {
    const { connector, sessions } = raising();
    const terminal = raising();
    const failing: Connector<SessionMode> = {
      start: () => Promise.reject(new Error('It won’t start here.')),
    };
    const sessionManager = manager({
      'claude-code.sdk': connector,
      'claude-code.terminal': terminal.connector,
      'codex.app-server': failing,
    });
    const canvas = newCanvasId();
    // Closed.
    await sessionManager.start(canvas, 'b', SDK);
    const closedGeneration = sessionManager.generationOf(canvas, 'b') ?? -1;
    await sessionManager.close(canvas, 'b');
    expect(gone).toContainEqual(['b', closedGeneration]);
    // Stopped by itself.
    await sessionManager.start(canvas, 'b', SDK);
    const stopped = sessionManager.generationOf(canvas, 'b') ?? -1;
    at(1, sessions).host.emit({ type: 'closed' });
    expect(gone).toContainEqual(['b', stopped]);
    // Replaced by another connection.
    await sessionManager.start(canvas, 'b', SDK);
    const replaced = sessionManager.generationOf(canvas, 'b') ?? -1;
    await sessionManager.start(canvas, 'b', TERMINAL);
    expect(gone).toContainEqual(['b', replaced]);
    // Never started.
    const before = gone.length;
    await expect(
      sessionManager.start(canvas, 'c', {
        connection: 'codex.app-server',
        model: null,
        mode: null,
      }),
    ).rejects.toThrow(/won’t start/);
    expect(gone.slice(before)).toEqual([['c', expect.any(Number)]]);
    // The window going ends the rest.
    const terminalGeneration = sessionManager.generationOf(canvas, 'b') ?? -1;
    await sessionManager.closeCanvas(canvas);
    expect(gone).toContainEqual(['b', terminalGeneration]);
  });

  it('are marked unheard once their generation is no longer the agent’s', async () => {
    const { connector, sessions } = raising();
    const sessionManager = manager({ 'claude-code.sdk': connector });
    const canvas = newCanvasId();
    await sessionManager.start(canvas, 'b', SDK);
    await sessionManager.close(canvas, 'b');
    at(0, sessions).host.emit({ type: 'prompt', key: KEY, prompt: PROMPT as never });
    expect(raised).toEqual([[expect.objectContaining({ live: false }), expect.anything()]]);
  });

  it('are declined when no owner hears them', async () => {
    const { connector, sessions } = raising();
    const sessionManager = manager({ 'claude-code.sdk': connector }, false);
    const canvas = newCanvasId();
    await sessionManager.start(canvas, 'b', SDK);
    at(0, sessions).host.emit({ type: 'prompt', key: KEY, prompt: PROMPT as never });
    expect(at(0, sessions).declined).toEqual([[KEY, expect.any(String)]]);
    // A terminal's observation is never declined: corrallm answers nothing there.
    at(0, sessions).host.emit({
      type: 'prompt',
      key: crypto.randomUUID(),
      prompt: { kind: 'approval', title: 'Waiting', answerIn: 'terminal', choices: [] },
    });
    expect(at(0, sessions).declined).toHaveLength(1);
    await sessionManager.closeCanvas(canvas);
  });

  it('raised as a session starts are declined once it has started, and not answered before', async () => {
    let origin: PromptOrigin | undefined;
    const { connector, sessions } = raising((host) => {
      host.emit({ type: 'prompt', key: KEY, prompt: PROMPT as never });
      origin = raised[0]?.[0];
      expect(() => origin?.answers.answer(KEY, { kind: 'choice', value: 'yes' })).toThrow(
        /starting/,
      );
      origin?.answers.decline(KEY, 'corrallm declined this request.');
    });
    const sessionManager = manager({ 'claude-code.sdk': connector });
    const canvas = newCanvasId();
    await sessionManager.start(canvas, 'b', SDK);
    await vi.waitFor(() => {
      expect(at(0, sessions).declined).toEqual([[KEY, 'corrallm declined this request.']]);
    });
    expect(at(0, sessions).answered).toEqual([]);
    await sessionManager.closeCanvas(canvas);
  });
});
