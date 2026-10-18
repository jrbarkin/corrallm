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
import { createCore } from '../core';
import type { Core } from '../core';
import { CALLERS, CANVAS, NO_DESKTOP } from '../test-registry';

/*
 * A message's record reaches the disk before it is sent (API Spec §5.3): the core journals it
 * delivering, with the id it will send under, forces that to disk, and only then sends. A fake fs
 * records each fsync, and the agent's session each message it is sent, in one list.
 */

const events = vi.hoisted(() => [] as string[]);

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        events.push(`fsync ${path.basename(String(args[0]))}`);
      };
      return handle;
    },
  };
});

let profile: string;
let core: Core | undefined;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-fsync-'));
  events.length = 0;
});

afterEach(async () => {
  await core?.close();
  core = undefined;
  await rm(profile, { recursive: true, force: true });
});

it('sends a message only once its delivering record is on disk', async () => {
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
  const log = path.join(profile, 'runs', CANVAS, 'messages.jsonl');
  /** What the log on disk said of each message as it was sent. */
  const journaled: (Message | undefined)[] = [];
  const codex = new FakeConnector({ adapter: 'codex' });
  const watched: Connector<SessionMode> = {
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
  };
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      sessions: {
        connectors: { 'codex.app-server': watched },
        environment: () => Promise.resolve({}),
      },
    },
    NO_DESKTOP,
  );
  await core.engines.open(CANVAS);
  const result = await core.call(
    'message',
    { canvas: CANVAS, to: 'builder', body: 'Say hello' },
    CALLERS['outside-write'],
  );
  if (!result.ok) throw new Error(result.error.sentence);
  await vi.waitFor(() => {
    expect(events.some((event) => event.startsWith('send '))).toBe(true);
  });
  const sendAt = events.findIndex((event) => event.startsWith('send '));
  expect(events.slice(0, sendAt)).toContain('fsync messages.jsonl');
  expect(journaled).toEqual([
    expect.objectContaining({ id: result.value.id, state: 'delivering' }),
  ]);
});
