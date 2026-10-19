import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { SessionEvent, SessionMode } from '../../shared/session';
import { TURN_REASONS } from '../../shared/session';
import { CATALOG } from './adapters';
import { createConnectors } from './connectors';
import type { Connector, LiveSession } from './connector';
import { AppServerConnector } from './codex/app-server/connector';
import { recordedResult } from './codex/app-server/recorded';
import { resumedHistory } from './codex/app-server/session';
import { historyEvents as codexHistory } from './codex/app-server/translate';
import { CodexTerminalConnector } from './codex/terminal/connector';
import { Replay } from './codex/terminal/replay';
import { HookTruster } from './codex/terminal/trust';
import { SdkConnector } from './sdk/connector';
import { historyEvents } from './sdk/history';
import { RECORDED_PLACES, recordedHistory } from './sdk/recorded';
import { TerminalConnector } from './terminal/connector';
import { FakeClaude } from './terminal/fake-claude';

let folder: string;
let sessions: LiveSession<SessionMode>[];
const config = process.env.CLAUDE_CONFIG_DIR;
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'corrallm-end-contract-'));
  sessions = [];
});
afterEach(async () => {
  await Promise.all(sessions.map((session) => session.close()));
  if (config === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = config;
  await rm(folder, { recursive: true, force: true });
});

const TIMING = {
  key: 0,
  enter: 1,
  echo: 300,
  confirm: 500,
  settle: 5,
  startup: 2000,
  batch: 1,
  kill: 200,
};
const fixtures: Record<string, () => Connector<SessionMode>> = {
  'claude-code.terminal': () =>
    new TerminalConnector({
      findClaude: () => Promise.resolve('/fake/claude'),
      spawn: (file, args, options) => Promise.resolve(new FakeClaude(file, args, options, {})),
      tmp: folder,
      timing: TIMING,
    }),
  'claude-code.sdk': () => {
    process.env.CLAUDE_CONFIG_DIR = folder;
    return new SdkConnector({
      clientApp: 'corrallm/test',
      findClaude: () => Promise.resolve(path.join(import.meta.dirname, 'sdk/fake-claude.mjs')),
    });
  },
  'codex.app-server': () =>
    new AppServerConnector({
      clientApp: 'corrallm/test',
      findCodex: () => Promise.resolve('/fake/codex'),
      spawn: (_file, args, options) =>
        spawn(
          process.execPath,
          [path.join(import.meta.dirname, 'codex/fake-codex.mjs'), ...args],
          options,
        ),
    }),
  'codex.terminal': () =>
    new CodexTerminalConnector({
      findCodex: () => Promise.resolve('/fake/codex'),
      version: () => Promise.resolve('0.160.1'),
      truster: new HookTruster({ start: () => Promise.reject(new Error('not here')) }),
      spawn: (_file, args, options) => Promise.resolve(new Replay('turns', args, options)),
      readInstructions: () => Promise.resolve(undefined),
      tmp: folder,
      timing: { ...TIMING, enter: 20, confirm: 400 },
    }),
};

function check(events: readonly SessionEvent[], expected: string[]) {
  const ends = events.filter((event) => event.type === 'end');
  expect(ends.map((event) => event.result.status)).toEqual(expected);
  for (const end of ends) {
    expect(end).not.toHaveProperty('interrupted');
    expect(end).not.toHaveProperty('failed');
    expect(TURN_REASONS).toContain(end.result.reason);
    if (end.result.status === 'completed') expect(end.result.reason).toBe('completed');
    if (end.result.status === 'cancelled') expect(end.result.reason).toBe('interrupted');
  }
}

const connections = CATALOG.adapters.flatMap((adapter) => adapter.connections.map(({ id }) => id));
it('has a real protocol fixture for every connection in the registry', () => {
  expect(Object.keys(fixtures).sort()).toEqual([...connections].sort());
});

it.each(connections)('%s emits results for completed and interrupted turns', async (id) => {
  const events: SessionEvent[] = [];
  const connector = fixtures[id]?.();
  if (!connector) throw new Error(`No protocol fixture for ${id}`);
  const session = await connector.start(
    {
      agentId: 'a',
      cwd: id === 'codex.terminal' ? '/work/smoke/term1' : folder,
      env: {
        PATH: process.env.PATH ?? '',
        ANTHROPIC_API_KEY: 'sk-ant-test',
        CLAUDE_CONFIG_DIR: folder,
        FAKE_CODEX_LOGIN: 'apikey',
      },
      model: null,
      mode: id === 'codex.terminal' ? 'read-only' : null,
      resume: null,
    },
    { emit: (event) => events.push(event), remember: () => undefined },
  );
  sessions.push(session);
  const ends = () => events.filter((event) => event.type === 'end');
  const until = (test: () => void) => vi.waitFor(test, { timeout: 5000, interval: 5 });
  await session.send({
    id: 'first',
    text: id === 'codex.terminal' ? 'Say hi in one word.' : 'Say hi',
  });
  await until(() => {
    expect(ends()).toHaveLength(1);
  });
  if (id === 'codex.terminal') {
    await session.send({
      id: 'second',
      text: 'Create a file named hi.txt containing the word hi.',
    });
    await until(() => {
      expect(events.at(-1)).toMatchObject({ type: 'status', status: 'waiting' });
    });
    session.terminal?.input('y');
    await until(() => {
      expect(ends()).toHaveLength(2);
    });
  }
  const text =
    id === 'codex.terminal'
      ? 'Write the numbers from 1 to 400, one per line, as plain text.'
      : 'slow story';
  await session.send({ id: 'last', text });
  await until(() => {
    expect(events).toContainEqual({ type: 'user', id: 'last', text });
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await session.interrupt();
  await until(() => {
    expect(ends()).toHaveLength(id === 'codex.terminal' ? 3 : 2);
  });
  check(
    events,
    id === 'codex.terminal' ? ['completed', 'completed', 'cancelled'] : ['completed', 'cancelled'],
  );
  if (id === 'claude-code.terminal' || id === 'codex.app-server') {
    await session.send({ id: 'failed', text: 'fail please' });
    await until(() => {
      expect(ends()).toHaveLength(3);
    });
    check(events, ['completed', 'cancelled', 'failed']);
    expect(ends().at(-1)?.result).toMatchObject({ status: 'failed', reason: 'usage-limit' });
  }
});

it.each(connections)('%s’s fake connector emits the same result contract', async (id) => {
  const events: SessionEvent[] = [];
  const connectors = createConnectors({
    fake: true,
    clientApp: 'corrallm/test',
    distribution: 'local',
    consent: () => ({ given: () => Promise.resolve(false), give: () => Promise.resolve() }),
  });
  const connector = connectors[id];
  if (!connector) throw new Error(`No fake connector for ${id}`);
  const session = await connector.start(
    { agentId: 'a', cwd: folder, env: {}, model: null, mode: 'auto', resume: null },
    { emit: (event) => events.push(event), remember: () => undefined },
  );
  sessions.push(session);
  await session.send({ id: 'first', text: 'Hello' });
  await vi.waitFor(() => {
    expect(events.filter((event) => event.type === 'end')).toHaveLength(1);
  });
  await session.send({ id: 'last', text: '/question Wait here' });
  await vi.waitFor(() => {
    expect(events.some((event) => event.type === 'question')).toBe(true);
  });
  await session.interrupt();
  await vi.waitFor(() => {
    expect(events.filter((event) => event.type === 'end')).toHaveLength(2);
  });
  check(events, ['completed', 'cancelled']);
});

it('SDK history carries completed and interrupted results from the recording', () => {
  check(historyEvents(recordedHistory('subagent-and-interrupt'), RECORDED_PLACES), [
    'completed',
    'cancelled',
  ]);
});

it('App Server history carries each recorded turn’s result', () => {
  const history = resumedHistory(recordedResult('resume', 'thread/resume'), {
    cwd: '/work/smoke/one',
    home: '/Users/someone',
  });
  check(history, ['completed']);
});

it('App Server history keeps interrupted and failed outcomes separate from completion', () => {
  const events = codexHistory(
    [
      { id: 'stopped', status: 'interrupted', items: [] },
      {
        id: 'failed',
        status: 'failed',
        error: { message: 'Sign in again', codexErrorInfo: 'unauthorized' },
        items: [],
      },
      { id: 'done', status: 'completed', items: [] },
    ],
    { cwd: folder, home: folder },
  );
  check(events, ['cancelled', 'failed', 'completed']);
  expect(
    events.find((event) => event.type === 'end' && event.result.status === 'failed'),
  ).toMatchObject({ result: { status: 'failed', reason: 'auth' } });
});

it('App Server history does not guess completion for a turn still in progress', () => {
  expect(
    codexHistory([{ id: 'busy', status: 'inProgress', items: [] }], {
      cwd: folder,
      home: folder,
    }).filter((event) => event.type === 'end'),
  ).toEqual([]);
});
