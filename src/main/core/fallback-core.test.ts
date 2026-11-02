import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import type { SessionMode, TurnResult, UserMessage } from '../../shared/session';
import type { Connector, SessionHost } from '../sessions/connector';
import { FakeConnector } from '../sessions/fake';
import type { OutsideCaller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { keepCanvases, readOnDisk } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';
import { legacyDirectories } from './workspaces/test-directories';

/*
 * B11a's fallback through the whole core (C2–C5): a turn that ends on Codex's usage limit, its
 * reset known, holds Codex on disk (B8); its agent's chain then carries its work on with Claude
 * Code, committed by corrallm, a fresh conversation there; whether the run's task held on the limit
 * (§12.5) or a party's message waiting for it; and what a restart finds.
 */

const CANVAS = '5c2a7b3e-9d4f-4e60-8a1b-2c3d4e5f6a7b' as CanvasId;
const ORCHESTRATOR: OutsideCaller = {
  kind: 'outside',
  token: 'write-token',
  name: 'orchestrator',
  access: 'write',
  merge: true,
  canvases: [CANVAS],
};

/** A canvas file (version 3) whose worker runs on Codex, carrying on with Claude Code. */
const FILE = {
  format: 'corrallm',
  version: 3,
  id: CANVAS,
  nodes: [
    {
      id: 'worker',
      kind: 'agent',
      label: 'Worker',
      position: { x: 0, y: 0 },
      adapter: 'codex',
      connection: 'codex.app-server',
      fallback: { to: [{ adapter: 'claude-code', connection: 'claude-code.terminal' }] },
      queue: [{ id: 'hello', message: 'Say hello' }],
    },
  ],
  links: [],
};

let profile: string;
let file: string;
const cores: Core[] = [];

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-fallback-core-'));
  const project = path.join(profile, 'project');
  await mkdir(project);
  file = path.join(profile, 'worker.corral');
  await writeFile(file, JSON.stringify(FILE));
  await keepCanvases(profile, { [CANVAS]: { file, project } });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const core of cores.splice(0)) await core.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
});

/** A connector whose agent takes each message and works on it until the test ends its turn. */
function held(adapter: 'codex' | 'claude-code') {
  const fake = new FakeConnector({ adapter, mode: adapter === 'codex' ? 'auto' : 'acceptEdits' });
  const sent: UserMessage[] = [];
  let host: SessionHost | undefined;
  const connector: Connector<SessionMode> = {
    start: async (spec, given) => {
      host = given;
      const session = await fake.start(spec, given);
      session.send = (message) => {
        sent.push(message);
        given.emit({ type: 'user', id: message.id, text: message.text });
        given.emit({ type: 'status', status: 'working' });
        return Promise.resolve();
      };
      return session;
    },
  };
  /** Ends the turn of the last message sent, as its CLI says. */
  const end = (result: TurnResult) => {
    const last = sent.at(-1);
    if (last === undefined) throw new Error('Nothing was sent.');
    host?.emit({ type: 'end', messages: [last.id], seconds: 1, result });
  };
  return { connector, fake, sent, end };
}

async function start(codex: Connector<SessionMode>, claude: Connector<SessionMode>): Promise<Core> {
  const core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
      sessions: {
        connectors: { 'codex.app-server': codex, 'claude-code.terminal': claude },
        environment: () => Promise.resolve({}),
      },
      watchFolder: () => ({ close: () => undefined }),
    },
    NO_DESKTOP,
  );
  cores.push(core);
  return core;
}

const worker = (core: Core) => {
  const node = core.engines.canvas(CANVAS)?.document.nodes.find(({ id }) => id === 'worker');
  if (node?.type !== 'agent') throw new Error('No worker.');
  return node.data;
};
const revisions = () =>
  readOnDisk(profile, (disk) =>
    disk
      .prepare('SELECT op, by_party FROM revision WHERE canvas_id = ? AND rev > 1 ORDER BY rev')
      .all(CANVAS),
  );
const LIMIT = (resetsAt: number): TurnResult => ({
  status: 'failed',
  reason: 'usage-limit',
  message: 'You have hit your usage limit.',
  resetsAt,
});

describe('the fallback chain through the core', () => {
  it('switches a task held on Codex’s limit, held on disk, to Claude Code, and continues it there (§12.5)', async () => {
    const codex = held('codex');
    const claude = held('claude-code');
    const core = await start(codex.connector, claude.connector);
    const engine = await core.engines.open(CANVAS);
    engine.run.start();
    await vi.waitFor(() => {
      expect(codex.sent).toHaveLength(1);
    });
    const resetsAt = Date.now() + 60 * 60_000;
    codex.end(LIMIT(resetsAt));
    // Codex's limit is on disk before the run hears the end (B8).
    await vi.waitFor(() => {
      // The task, once more: the first send since the switch, carrying the worker's handoff, or
      // saying none was written (B11a C7).
      expect(claude.sent.map(({ text }) => text)).toEqual([
        expect.stringMatching(
          /^\[corrallm\] corrallm switched this agent to Claude Code · Terminal, [^\n]+\n\nSay hello\n\n\[corrallm\] No handoff was written: its context never reached 95%\.$/,
        ),
      ]);
    });
    const usage = JSON.parse(await readFile(path.join(profile, 'usage.json'), 'utf8')) as {
      exhausted: Record<string, { resetsAt: number }>;
    };
    expect(usage.exhausted.codex?.resetsAt).toBe(resetsAt);
    expect(worker(core)).toMatchObject({
      adapter: 'claude-code',
      connection: 'claude-code.terminal',
      fallback: {
        on: {
          step: 0,
          from: { adapter: 'codex', connection: 'codex.app-server' },
          why: 'usage-limit',
        },
      },
    });
    // Committed by corrallm, through the document's own write: no op made it.
    expect(revisions()).toEqual([{ op: 'fallback.switch', by_party: 'corrallm' }]);
    // A fresh conversation: nothing of Codex's crossed.
    expect(claude.fake.started.at(-1)).toMatchObject({ resume: null });
    const attempts = engine.run.snapshot().agents.worker?.attempts?.hello ?? [];
    expect(attempts).toMatchObject([
      { status: 'failed', reason: 'usage-limit' },
      { status: 'running', retryOf: attempts[0]?.id },
    ]);
    // Your Save writes it: corrallm never saves the file, which shows the canvas edited.
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(FILE);
    await vi.waitFor(async () => {
      const listed = await core.call('canvas.list', {}, CALLERS.you);
      expect(listed).toMatchObject({
        ok: true,
        value: { items: [expect.objectContaining({ canvas: CANVAS, edited: true })] },
      });
    });
  });

  it('carries a party’s message waiting for the worker to Claude Code, telling the sender whose turn failed', async () => {
    const codex = held('codex');
    const claude = held('claude-code');
    const core = await start(codex.connector, claude.connector);
    await core.engines.open(CANVAS);
    const first = await core.call(
      'message',
      { canvas: CANVAS, to: 'worker', body: 'Review this' },
      ORCHESTRATOR,
    );
    expect(first.ok).toBe(true);
    await vi.waitFor(() => {
      expect(codex.sent).toHaveLength(1);
    });
    codex.end(LIMIT(Date.now() + 60 * 60_000));
    const messages = await core.engines.messagesOf(CANVAS);
    await vi.waitFor(() => {
      expect(messages.all().some((message) => message.turn?.reason === 'usage-limit')).toBe(true);
    });
    // The next goes to Claude Code, once corrallm switched the worker.
    await core.call('message', { canvas: CANVAS, to: 'worker', body: 'Then this' }, ORCHESTRATOR);
    await vi.waitFor(() => {
      expect(claude.sent).toHaveLength(1);
    });
    // Framed as the party's, after corrallm's switch line, before what it carries (B11a C7).
    expect(claude.sent[0]?.text).toMatch(
      /^\[corrallm\] corrallm switched this agent to [^\n]+\n\n\[corrallm\] Message from "orchestrator" [^\n]+\nThen this\n\n\[corrallm\] No handoff was written: its context never reached 95%\.$/,
    );
    expect(codex.sent).toHaveLength(1);
    const id = first.ok ? (first.value as { id: string }).id : '';
    expect(
      messages
        .all()
        .filter((message) => message.kind === 'notice' && message.replyTo === id)
        .map(({ body }) => body),
    ).toContain('Worker carries on with Claude Code · Terminal; your message wasn’t sent again.');
  });

  it('shows the chain in the session summary, agents and status: where it is, and switching', async () => {
    const codex = held('codex');
    const claude = held('claude-code');
    const core = await start(codex.connector, claude.connector);
    const engine = await core.engines.open(CANVAS);
    const views = async () =>
      Promise.all(
        (['session.get', 'agents', 'status'] as const).map(async (op) => {
          const args =
            op === 'session.get' ? { canvas: CANVAS, agent: 'worker' } : { canvas: CANVAS };
          const result = await core.call(op, args, CALLERS.you);
          if (!result.ok) throw new Error(result.error.sentence);
          const value = result.value as { fallback?: unknown; agents?: { fallback: unknown }[] };
          return value.agents === undefined ? value.fallback : value.agents[0]?.fallback;
        }),
      );
    expect(await views()).toEqual(Array(3).fill({ step: null, steps: 1, back: 'stay' }));
    engine.run.start();
    await vi.waitFor(() => {
      expect(codex.sent).toHaveLength(1);
    });
    // Your own message, typed as the task goes, is the turn its switch waits for.
    await core.call('message', { canvas: CANVAS, to: 'worker', body: 'Mine' }, CALLERS.you);
    codex.end(LIMIT(Date.now() + 60 * 60_000));
    await vi.waitFor(() => {
      expect(codex.sent).toHaveLength(2);
    });
    expect(await views()).toEqual(
      Array(3).fill({ step: null, steps: 1, back: 'stay', switching: true }),
    );
    codex.end({ status: 'completed', reason: 'completed' });
    await vi.waitFor(() => {
      expect(claude.sent).toHaveLength(1);
    });
    expect(await views()).toEqual(
      Array(3).fill({
        step: 0,
        steps: 1,
        from: { adapter: 'codex', connection: 'codex.app-server' },
        back: 'stay',
      }),
    );
  });

  it('keeps the switch across a restart, and switches nothing again: the held task waits for you', async () => {
    const codex = held('codex');
    const claude = held('claude-code');
    let core = await start(codex.connector, claude.connector);
    let engine = await core.engines.open(CANVAS);
    engine.run.start();
    await vi.waitFor(() => {
      expect(codex.sent).toHaveLength(1);
    });
    codex.end(LIMIT(Date.now() + 60 * 60_000));
    await vi.waitFor(() => {
      expect(claude.sent).toHaveLength(1);
    });
    await core.close();
    cores.splice(0);
    const after = held('claude-code');
    core = await start(held('codex').connector, after.connector);
    engine = await core.engines.open(CANVAS);
    expect(worker(core)).toMatchObject({ adapter: 'claude-code', fallback: { on: { step: 0 } } });
    // The continuation was in flight: restored uncertain, never sent again.
    engine.run.resume();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(engine.run.snapshot().agents.worker).toMatchObject({
      status: 'asking',
      problem: { kind: 'uncertain' },
    });
    expect(after.sent).toEqual([]);
    expect(revisions()).toEqual([{ op: 'fallback.switch', by_party: 'corrallm' }]);
  });
});
