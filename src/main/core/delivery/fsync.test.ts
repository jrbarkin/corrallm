import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Message } from '../../../shared/model/messages';
import type { SessionMode } from '../../../shared/session';
import type { Connector } from '../../sessions/connector';
import { FakeConnector } from '../../sessions/fake';
import type { Caller, OutsideCaller } from '../caller';
import { createCore } from '../core';
import type { Core } from '../core';
import { CALLERS, CANVAS, NO_DESKTOP } from '../test-registry';

/*
 * A message's record reaches the disk before it is sent (API Spec §5.3): the core journals it
 * delivering, with the id it will send under, forces that to disk, and only then sends. A fake fs
 * records each fsync, and the agent's session each message it is sent, in one list; and holds
 * every fsync while a test holds its gate.
 */

const events = vi.hoisted(() => [] as string[]);
const gate = vi.hoisted(() => ({ held: undefined as Promise<void> | undefined }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await gate.held;
        await sync();
        events.push(`fsync ${path.basename(String(args[0]))}`);
      };
      return handle;
    },
  };
});

const OUTSIDE = CALLERS['outside-write'] as OutsideCaller;

let profile: string;
let core: Core | undefined;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-fsync-'));
  events.length = 0;
});

afterEach(async () => {
  gate.held = undefined;
  await core?.close();
  core = undefined;
  await rm(profile, { recursive: true, force: true });
});

/** Starts the core over a profile keeping a canvas of Builder, on Codex's App Server: `connector`. */
async function start(connector: Connector<SessionMode>): Promise<Core> {
  const project = path.join(profile, 'project');
  await mkdir(project);
  const file = path.join(profile, 'canvas.corral');
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: CANVAS,
      nodes: [
        {
          id: 'builder',
          kind: 'agent',
          label: 'Builder',
          position: { x: 0, y: 0 },
          adapter: 'codex',
          connection: 'codex.app-server',
        },
      ],
      links: [],
    }),
  );
  await writeFile(
    path.join(profile, 'canvases.json'),
    JSON.stringify({ version: 2, canvases: { [CANVAS]: { file, project, conversations: {} } } }),
  );
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      sessions: {
        connectors: { 'codex.app-server': connector },
        environment: () => Promise.resolve({}),
      },
    },
    NO_DESKTOP,
  );
  await core.engines.open(CANVAS);
  return core;
}

/** Calls `name` on the canvas as `caller`, expecting it to work: its result. */
async function ok<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
  caller: Caller = OUTSIDE,
): Promise<T> {
  const result = await core?.call(name as never, { canvas: CANVAS, ...args }, caller);
  if (!result?.ok) throw new Error(`${name} failed: ${JSON.stringify(result)}`);
  return result.value;
}

it('sends a message only once its delivering record is on disk', async () => {
  const log = path.join(profile, 'runs', CANVAS, 'messages.jsonl');
  /** What the log on disk said of each message as it was sent. */
  const journaled: (Message | undefined)[] = [];
  const codex = new FakeConnector({ adapter: 'codex' });
  await start({
    start: async (spec, host) => {
      const session = await codex.start(spec, host);
      const send = session.send.bind(session);
      session.send = (message) => {
        events.push(`send ${message.id}`);
        const lines = readFileSync(log, 'utf8').trim().split('\n');
        const records = lines.map((line) => (JSON.parse(line) as { message: Message }).message);
        journaled.push(records.findLast((record) => record.delivery?.as === message.id));
        return send(message);
      };
      return session;
    },
  });
  const { id } = await ok<{ id: string }>('message', { to: 'builder', body: 'Say hello' });
  await vi.waitFor(() => {
    expect(events.some((event) => event.startsWith('send '))).toBe(true);
  });
  const sendAt = events.findIndex((event) => event.startsWith('send '));
  expect(events.slice(0, sendAt)).toContain('fsync messages.jsonl');
  expect(journaled).toEqual([expect.objectContaining({ id, state: 'delivering' })]);
});

it('delivers the next message once one taken back while it was journaled is withdrawn', async () => {
  const codex = new FakeConnector({ adapter: 'codex' });
  const messages = (await start(codex)).engines.canvas(CANVAS)?.messages;
  await ok('run.pause', { target: { agent: 'builder' } }, CALLERS.you);
  const first = await ok<{ id: string }>('message', { to: 'builder', body: 'First' });
  const other: OutsideCaller = { ...OUTSIDE, token: 'other-token', name: 'other' };
  const second = await ok<{ id: string }>('message', { to: 'builder', body: 'Second' }, other);
  // The first's delivering record is held on its way to disk, and taken back meanwhile.
  const held = Promise.withResolvers<undefined>();
  gate.held = held.promise;
  await ok('run.unpause', { target: { agent: 'builder' } }, CALLERS.you);
  await vi.waitFor(() => {
    expect(messages?.get(first.id)?.state).toBe('delivering');
  });
  await ok('withdraw', { id: first.id });
  gate.held = undefined;
  held.resolve(undefined);
  await vi.waitFor(() => {
    expect(messages?.get(second.id)?.state).toBe('replied');
  });
  expect(messages?.get(first.id)?.state).toBe('withdrawn');
  expect(codex.sessions.flatMap((session) => session.sent.map(({ text }) => text))).toEqual([
    expect.stringMatching(/Second$/) as string,
  ]);
});
