import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PromptEvent } from '../../../../shared/model/prompts';
import type { HostEvent, LiveSession, SessionHost } from '../../connector';
import { SdkConnector } from './connector';
import { Conversations } from './conversations';

/*
 * The connector through the real Agent SDK, which runs a fake `claude` (fake-claude.mjs) that
 * speaks the CLI's stream-json protocol: the options it is given, the control requests
 * (permissions, interrupts, modes, settings, rewinds) and the messages, as they really go between
 * them. Only what a real child proves is here: that the SDK starts it and carries a turn, a
 * permission, an interrupt and its control requests both ways, that it asks the CLI for its
 * settings, that another party's message is never sent where the CLI would hold it, and that its
 * conversations are where the SDK lists, resumes and forks them. What the connector makes of each
 * message, prompt and setting is in connector.test.ts (on a stand-in query()), raise.test.ts and
 * translate.test.ts (on what the real CLI said, recorded), login.test.ts and conversations.test.ts.
 */

const FAKE = path.join(import.meta.dirname, 'fake-claude.mjs');

let folder: string;
/** Where the fake keeps its transcripts, and the Agent SDK reads them: never the user's ~/.claude. */
let config: string;
let session: LiveSession | undefined;
const configBefore = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'corrallm-sdk-'));
  config = await mkdtemp(path.join(tmpdir(), 'corrallm-config-'));
  process.env.CLAUDE_CONFIG_DIR = config;
});

afterEach(async () => {
  await session?.close();
  session = undefined;
  if (configBefore === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = configBefore;
  await rm(folder, { recursive: true, force: true });
  await rm(config, { recursive: true, force: true });
});

/** What says how the CLI logs in, in this process's environment: left out of the agents'. */
const LOGINS =
  /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_\w+)$/;

/**
 * Starts a session on the fake CLI, with an API key unless `login` gives the agents' environment
 * something else; resolves with it and what it said (in `events`).
 */
async function start(
  mode: 'manual' | 'acceptEdits' | null = 'manual',
  login: Record<string, string> = { ANTHROPIC_API_KEY: 'sk-ant-test' },
  events: HostEvent[] = [],
  resume: string | null = null,
) {
  const remembered: string[] = [];
  const host: SessionHost = {
    emit: (event: HostEvent) => events.push(event),
    remember: (id) => remembered.push(id),
  };
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined && !LOGINS.test(entry[0]),
      ),
    ),
    ...login,
    CLAUDE_CONFIG_DIR: config,
  };
  const connector = new SdkConnector({
    clientApp: 'corrallm/test',
    findClaude: () => Promise.resolve(FAKE),
  });
  session = await connector.start(
    { agentId: 'a', cwd: folder, env, model: null, mode, resume },
    host,
  );
  return { session, events, remembered };
}

/** An outside orchestrator, as the core names one that sends an agent a message. */
const PEER = { party: 'outside:orchestrator', name: 'orchestrator' };

/** Waits until `events` has one that `matches`. */
async function waitFor(events: HostEvent[], matches: (event: HostEvent) => boolean) {
  for (let i = 0; i < 200; i += 1) {
    const found = events.find(matches);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Never came; got: ${events.map((e) => e.type).join(', ')}`);
}

/** Waits for the `count`th prompt raised to the core's owner. */
async function raised(events: HostEvent[], count = 1): Promise<PromptEvent> {
  await waitFor(events, () => events.filter((e) => e.type === 'prompt').length >= count);
  const found = events.filter((e): e is PromptEvent => e.type === 'prompt')[count - 1];
  if (found === undefined) throw new Error('nothing raised');
  return found;
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
    const { key } = await raised(events);
    session.prompts?.answer(key, { kind: 'choice', value: 'allow' });

    const ended = await waitFor(events, (e) => e.type === 'end');
    expect(ended).toMatchObject({
      messages: [id],
      result: { status: 'completed', reason: 'completed' },
    });
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
    expect(ended).toMatchObject({
      messages: [id],
      result: { status: 'cancelled', reason: 'interrupted' },
    });
  });

  it('starts as the CLI’s settings say: the user’s own mode, model and effort, and no bypassing where they turn it off', async () => {
    await mkdir(path.join(folder, '.claude'));
    await writeFile(
      path.join(folder, '.claude', 'settings.json'),
      JSON.stringify({
        model: 'haiku',
        effortLevel: 'xhigh',
        permissions: { defaultMode: 'acceptEdits', disableBypassPermissionsMode: 'disable' },
      }),
    );
    const { session, events } = await start(null);
    const started = events[0];
    if (started?.type !== 'started') throw new Error('it never started');
    expect(started).toMatchObject({
      model: 'haiku',
      mode: 'acceptEdits',
      effort: null,
      modes: ['manual', 'acceptEdits', 'plan', 'auto'],
    });
    expect(started.models.find((m) => m.value === 'default')?.defaultEffort).toBe('xhigh');
    // Its turns run in its mode: an edit is not asked about, and no other mode is reported.
    const id = '00000000-0000-4000-8000-00000000000c';
    await session.send({ id, text: 'please edit it' });
    await waitFor(events, (e) => e.type === 'end');
    expect(events.some((e) => e.type === 'permission' || e.type === 'mode')).toBe(false);
    // The CLI refuses bypassing, and the composer goes back to the mode it was in.
    await expect(session.setMode('bypassPermissions')).rejects.toThrow(/disabled by settings/);
    expect(events.at(-1)).toEqual({ type: 'mode', mode: 'acceptEdits' });
  });

  it('never sends another party’s message the CLI would hold unanswered while it bypasses permissions', async () => {
    const { session, events } = await start();
    await session.setMode('bypassPermissions');
    // The CLI holds a peer's message for its user's review while it bypasses permissions: no
    // result would ever end its turn. It isn't sent, and the send says why.
    await expect(
      session.send({ id: '00000000-0000-4000-8000-00000000001a', text: 'Hello', from: PEER }),
    ).rejects.toThrow(/bypasses permissions/);
    // Yours goes, as its user's.
    const yours = '00000000-0000-4000-8000-00000000001b';
    await session.send({ id: yours, text: 'From you' });
    expect(await waitFor(events, (e) => e.type === 'end')).toMatchObject({ messages: [yours] });
    expect(events.flatMap((e) => (e.type === 'user' ? [e.id] : []))).toEqual([yours]);
  });

  it('keeps its conversations where the Agent SDK lists them, restores files to before a message, and forks and resumes the conversation with its history', async () => {
    const notes = path.join(folder, 'notes.txt');
    await writeFile(notes, 'one\nthree\n');
    const { session: live, events, remembered } = await start('acceptEdits');
    const ended = (count: number) =>
      waitFor(events, () => events.filter((e) => e.type === 'end').length === count);
    const first = '00000000-0000-4000-8000-00000000000f';
    const second = '00000000-0000-4000-8000-000000000010';
    await live.send({ id: first, text: 'Remember the shop' });
    await ended(1);
    await live.send({ id: second, text: 'please edit it' });
    await ended(2);
    expect(await readFile(notes, 'utf8')).toBe('two\nthree\n');
    const id = remembered.at(-1) ?? '';
    const kept = new Conversations();
    await expect(kept.list(folder)).resolves.toEqual([
      expect.objectContaining({ id, title: 'Remember the shop' }),
    ]);

    // Its files: previewed, then restored.
    await expect(live.rewindFiles?.(second, true)).resolves.toEqual({
      possible: true,
      files: ['notes.txt'],
      added: 1,
      removed: 1,
    });
    expect(await readFile(notes, 'utf8')).toBe('two\nthree\n');
    await live.rewindFiles?.(second, false);
    expect(await readFile(notes, 'utf8')).toBe('one\nthree\n');

    await live.close();
    session = undefined;

    // Resumed, it shows its history: each message by the id it was sent with, and the replies.
    const resumed = await start('manual', undefined, [], id);
    const earlier = resumed.events.find((e) => e.type === 'history');
    if (earlier?.type !== 'history') throw new Error('no history');
    expect(earlier.events).toContainEqual({ type: 'user', id: first, text: 'Remember the shop' });
    expect(earlier.events).toContainEqual(
      expect.objectContaining({ type: 'text', text: 'You said: Remember the shop' }),
    );
    await resumed.session.close();
    session = undefined;

    // Its conversation: a copy up to before that message, which resumes without it.
    const point = await kept.before(folder, id, second);
    if (point === null) throw new Error('nothing before it');
    const forked = await kept.fork(folder, id, point);
    const again = await start('manual', undefined, [], forked);
    const history = again.events.find((e) => e.type === 'history');
    if (history?.type !== 'history') throw new Error('no history');
    const said = history.events.flatMap((e) => (e.type === 'user' ? [e.text] : []));
    expect(said).toEqual(['Remember the shop']);
    // A new process has no checkpoints from before the fork.
    await expect(again.session.rewindFiles?.(first, true)).resolves.toMatchObject({
      possible: false,
    });
  });
});
