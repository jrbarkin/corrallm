import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionEvent } from '../../../shared/session';
import type { LiveSession, SessionHost } from '../connector';
import { SdkConnector } from './connector';
import { SUBSCRIPTION_LOGIN } from './login';

/*
 * The connector through the real Agent SDK, which runs a fake `claude` (fake-claude.mjs) that
 * speaks the CLI's stream-json protocol: the options it is given, the control requests
 * (permissions, interrupts, modes) and the messages, as they really go between them.
 */

const FAKE = path.join(import.meta.dirname, 'fake-claude.mjs');

let folder: string;
let session: LiveSession | undefined;

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'corrallm-sdk-'));
});

afterEach(async () => {
  await session?.close();
  session = undefined;
  await rm(folder, { recursive: true, force: true });
});

/** What says how the CLI logs in, in this process's environment: left out of the agents'. */
const LOGINS =
  /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_\w+)$/;

/**
 * Starts a session on the fake CLI, with an API key unless `login` gives the agents' environment
 * something else; resolves with it and what it said (in `events`).
 */
async function start(
  mode: 'manual' | 'acceptEdits' = 'manual',
  login: Record<string, string> = { ANTHROPIC_API_KEY: 'sk-ant-test' },
  events: SessionEvent[] = [],
) {
  const remembered: string[] = [];
  const host: SessionHost = {
    emit: (event) => events.push(event),
    remember: (id) => remembered.push(id),
  };
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined && !LOGINS.test(entry[0]),
      ),
    ),
    ...login,
  };
  const connector = new SdkConnector({
    clientApp: 'corrallm/test',
    findClaude: () => Promise.resolve(FAKE),
  });
  session = await connector.start(
    { agentId: 'a', cwd: folder, env, model: null, mode, resume: null },
    host,
  );
  return { session, events, remembered };
}

/** Waits until `events` has one that `matches`. */
async function waitFor(events: SessionEvent[], matches: (event: SessionEvent) => boolean) {
  for (let i = 0; i < 200; i += 1) {
    const found = events.find(matches);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Never came; got: ${events.map((e) => e.type).join(', ')}`);
}

describe('SdkConnector through the Agent SDK', () => {
  it('starts the CLI, plays a turn with a permission prompt, and ends it', async () => {
    const { session, events, remembered } = await start();
    expect(events[0]).toMatchObject({ type: 'started', model: 'default', mode: 'manual' });
    expect(events[1]).toMatchObject({ type: 'commands' });

    const id = '00000000-0000-4000-8000-00000000000a';
    await session.send({ id, text: 'please run it' });
    const asked = await waitFor(events, (e) => e.type === 'permission');
    expect(asked).toMatchObject({
      tool: 'Bash',
      summary: 'echo hello',
      always: "Yes, and don't ask again for `echo` commands in " + path.basename(folder),
    });
    if (asked.type !== 'permission') throw new Error('no prompt');
    await session.answer(asked.id, { kind: 'permission', answer: 'once' });

    const ended = await waitFor(events, (e) => e.type === 'end');
    expect(ended).toMatchObject({ messages: [id], interrupted: false, failed: false });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool',
        tool: 'Bash',
        status: 'done',
        detail: { kind: 'output', text: 'hello' },
      }),
    );
    const replied = events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');
    expect(replied).toBe('You said: please run it');
    expect(remembered).toHaveLength(1);
  });

  it('interrupts a turn, and switches mode and model', async () => {
    const { session, events } = await start('acceptEdits');
    // The CLI takes them (it would refuse a mode or model it does not know).
    await session.setMode('plan');
    await session.setModel('haiku');
    expect(events).toContainEqual({ type: 'model', model: 'haiku' });

    const id = '00000000-0000-4000-8000-00000000000b';
    await session.send({ id, text: 'slow story' });
    await waitFor(events, (e) => e.type === 'text');
    await session.interrupt();
    const ended = await waitFor(events, (e) => e.type === 'end');
    expect(ended).toMatchObject({ messages: [id], interrupted: true, failed: false });
  });

  it('does not start the session on a Claude subscription login, and says why', async () => {
    const events: SessionEvent[] = [];
    await expect(start('manual', {}, events)).rejects.toThrow(SUBSCRIPTION_LOGIN);
    expect(session).toBeUndefined();
    expect(events).toMatchObject([
      { type: 'notice', level: 'error', text: SUBSCRIPTION_LOGIN, switchTo: 'terminal' },
    ]);
  });

  it('starts with an apiKeyHelper in the project’s settings, or a cloud provider', async () => {
    await mkdir(path.join(folder, '.claude'));
    await writeFile(
      path.join(folder, '.claude', 'settings.local.json'),
      JSON.stringify({ apiKeyHelper: 'echo key' }),
    );
    const { events } = await start('manual', {});
    expect(events[0]).toMatchObject({ type: 'started' });
    await session?.close();
    session = undefined;

    await rm(path.join(folder, '.claude'), { recursive: true });
    const bedrock = await start('manual', { CLAUDE_CODE_USE_BEDROCK: '1' });
    expect(bedrock.events[0]).toMatchObject({ type: 'started' });
  });
});
