import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PromptEvent } from '../../../../shared/model/prompts';
import type { HostEvent, LiveSession, SessionHost } from '../../connector';
import { SdkConnector } from './connector';
import { Conversations } from './conversations';
import { SUBSCRIPTION_LOGIN } from './login';

/*
 * The connector through the real Agent SDK, which runs a fake `claude` (fake-claude.mjs) that
 * speaks the CLI's stream-json protocol: the options it is given, the control requests
 * (permissions, interrupts, modes) and the messages, as they really go between them.
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
  it.each([undefined, '150000'])(
    'reads the SDK context summary from the fake CLI (%s)',
    async (threshold) => {
      const { session, events } = await start('acceptEdits', {
        ANTHROPIC_API_KEY: 'sk-ant-test',
        ...(threshold === undefined ? {} : { FAKE_CLAUDE_COMPACT_AT: threshold }),
      });
      const id = '00000000-0000-4000-8000-00000000000a';
      await session.send({ id, text: 'Hello' });
      await waitFor(events, (event) => event.type === 'end');
      const beforeEnd = events.slice(
        0,
        events.findIndex((event) => event.type === 'end'),
      );
      expect(beforeEnd.filter((event) => event.type === 'usage').at(-1)).toMatchObject({
        usage: {
          context: {
            used: expect.any(Number) as number,
            window: 200000,
            compactAt: threshold === undefined ? 167000 : 150000,
          },
        },
      });
    },
  );

  it('holds only the selected fake turn until its explicit gate opens, and still honours interruption', async () => {
    const release = path.join(folder, 'release-turn');
    const text = 'controlled first turn';
    const { session, events } = await start('acceptEdits', {
      ANTHROPIC_API_KEY: 'sk-ant-test',
      FAKE_CLAUDE_TURN_GATES: JSON.stringify({ [text]: release }),
    });
    const first = '00000000-0000-4000-8000-00000000000a';
    // An unselected turn remains automatic, even while the gate is closed.
    await session.send({ id: first, text: 'ordinary message' });
    await waitFor(events, (event) => event.type === 'end' && event.messages.includes(first));
    const held = '00000000-0000-4000-8000-00000000000b';
    await session.send({ id: held, text });
    await expect
      .poll(() => readFile(`${release}.waiting`, 'utf8').catch(() => ''), { timeout: 10_000 })
      .toBe('waiting');
    expect(events.filter((event) => event.type === 'end' && event.messages.includes(held))).toEqual(
      [],
    );
    await writeFile(release, 'go');
    await waitFor(events, (event) => event.type === 'end' && event.messages.includes(held));
    expect(
      events.filter((event) => event.type === 'end' && event.messages.includes(held)),
    ).toMatchObject([{ result: { status: 'completed', reason: 'completed' } }]);
    await rm(release);
    const interrupted = '00000000-0000-4000-8000-00000000000c';
    await rm(`${release}.waiting`);
    await session.send({ id: interrupted, text });
    await expect
      .poll(() => readFile(`${release}.waiting`, 'utf8').catch(() => ''), { timeout: 10_000 })
      .toBe('waiting');
    await session.interrupt();
    await waitFor(events, (event) => event.type === 'end' && event.messages.includes(interrupted));
    expect(
      events.filter((event) => event.type === 'end' && event.messages.includes(interrupted)),
    ).toMatchObject([{ result: { status: 'cancelled', reason: 'interrupted' } }]);
  }, 20_000);

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

  it('starts in the user’s own default mode when none was chosen, as the CLI then says', async () => {
    await mkdir(path.join(folder, '.claude'));
    await writeFile(
      path.join(folder, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }),
    );
    const { session, events } = await start(null);
    expect(events[0]).toMatchObject({ type: 'started', mode: 'acceptEdits' });
    // Its turns run in it: an edit is not asked about, and no other mode is reported.
    const id = '00000000-0000-4000-8000-00000000000c';
    await session.send({ id, text: 'please edit it' });
    await waitFor(events, (e) => e.type === 'end');
    expect(events.some((e) => e.type === 'permission' || e.type === 'mode')).toBe(false);
  });

  it('shows the model and effort the user’s settings start it with, before its first turn', async () => {
    await mkdir(path.join(folder, '.claude'));
    const settings = path.join(folder, '.claude', 'settings.json');
    // Their own effort: what the composer shows for each model that takes it, none being chosen.
    await writeFile(settings, JSON.stringify({ effortLevel: 'xhigh' }));
    const first = await start();
    const started = first.events[0];
    if (started?.type !== 'started') throw new Error('it never started');
    expect(started).toMatchObject({ model: 'default', effort: null });
    expect(started.models.find((m) => m.value === 'default')?.defaultEffort).toBe('xhigh');
    // A model that takes no effort has none.
    expect(started.models.find((m) => m.value === 'haiku')?.defaultEffort).toBeUndefined();
    await first.session.close();

    // Their own model, rather than the account's default.
    await writeFile(settings, JSON.stringify({ model: 'haiku' }));
    const second = await start();
    expect(second.events[0]).toMatchObject({ type: 'started', model: 'haiku' });
  });

  it('leaves bypassing permissions out where the project’s settings turn it off, as the CLI does', async () => {
    await mkdir(path.join(folder, '.claude'));
    await writeFile(
      path.join(folder, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { disableBypassPermissionsMode: 'disable' } }),
    );
    const { session, events } = await start();
    expect(events[0]).toMatchObject({
      type: 'started',
      modes: ['manual', 'acceptEdits', 'plan', 'auto'],
    });
    await expect(session.setMode('bypassPermissions')).rejects.toThrow(/disabled by settings/);
    expect(events.at(-1)).toEqual({ type: 'mode', mode: 'manual' });
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

  it.each([
    ['hold', /hold messages from other sessions/],
    ['refuse', /refuse messages from other sessions/],
  ])(
    'never sends another party’s message where the settings %s them, and says why',
    async (inbound, why) => {
      await mkdir(path.join(folder, '.claude'));
      await writeFile(
        path.join(folder, '.claude', 'settings.json'),
        JSON.stringify({ crossSessionInbound: inbound }),
      );
      const { session } = await start();
      await expect(
        session.send({ id: '00000000-0000-4000-8000-00000000001c', text: 'Hello', from: PEER }),
      ).rejects.toThrow(why);
    },
  );

  it('sends another party’s message while it bypasses permissions where the settings accept them', async () => {
    await mkdir(path.join(folder, '.claude'));
    await writeFile(
      path.join(folder, '.claude', 'settings.json'),
      JSON.stringify({ crossSessionInbound: 'accept' }),
    );
    const { session, events } = await start();
    await session.setMode('bypassPermissions');
    const id = '00000000-0000-4000-8000-00000000001d';
    await session.send({ id, text: 'Hello', from: PEER });
    expect(await waitFor(events, (e) => e.type === 'end')).toMatchObject({ messages: [id] });
  });

  it('keeps its conversations where the Agent SDK lists them, and resumes one with its history', async () => {
    const first = await start();
    const id = '00000000-0000-4000-8000-00000000000d';
    await first.session.send({ id, text: 'Remember the shop' });
    await waitFor(first.events, (e) => e.type === 'end');
    await first.session.close();
    session = undefined;
    const [kept] = first.remembered;

    await expect(new Conversations().list(folder)).resolves.toEqual([
      expect.objectContaining({ id: kept, title: 'Remember the shop' }),
    ]);
    const again = await start('manual', undefined, [], kept ?? null);
    const history = again.events.find((e) => e.type === 'history');
    if (history?.type !== 'history') throw new Error('no history');
    expect(history.events).toContainEqual({ type: 'user', id, text: 'Remember the shop' });
    expect(history.events).toContainEqual(
      expect.objectContaining({ type: 'text', text: 'You said: Remember the shop' }),
    );
  });

  it('lists, reconnects and turns off its MCP servers, and asks what one asks for', async () => {
    const { session, events } = await start();
    await expect(session.mcpServers?.()).resolves.toEqual([
      {
        name: 'github',
        status: 'connected',
        scope: 'user',
        server: 'github-mcp 1.2.0',
        tools: 2,
      },
      { name: 'sentry', status: 'failed', scope: 'project', error: 'Connection refused' },
    ]);
    await session.changeMcpServer?.('sentry', 'reconnect');
    await session.changeMcpServer?.('github', 'disable');
    expect((await session.mcpServers?.())?.map((s) => [s.name, s.status])).toEqual([
      ['github', 'disabled'],
      ['sentry', 'connected'],
    ]);
    await expect(session.changeMcpServer?.('linear', 'reconnect')).rejects.toThrow(/not found/);

    const id = '00000000-0000-4000-8000-00000000000e';
    await session.send({ id, text: 'file an issue: fill in a form' });
    const asked = await waitFor(events, (e) => e.type === 'elicitation');
    if (asked.type !== 'elicitation') throw new Error('nothing asked');
    expect(asked).toMatchObject({
      server: 'github',
      message: 'Which repository should the issue go in?',
      fields: [
        { name: 'repo', label: 'Repository', required: true, kind: 'text' },
        { name: 'draft', label: 'Draft', required: false, kind: 'boolean' },
      ],
    });
    session.prompts?.answer((await raised(events)).key, {
      kind: 'form',
      action: 'accept',
      values: { repo: 'acme/shop', draft: true },
    });
    await waitFor(events, (e) => e.type === 'end');
    const replied = events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');
    expect(replied).toBe('github got: accept {"repo":"acme/shop","draft":true}');
  });

  it('raises what the real CLI asked, as recorded: an ask rule and a safety check, in any mode', async () => {
    const { session, events } = await start('acceptEdits');
    await session.send({ id: '00000000-0000-4000-8000-0000000000a1', text: 'read the secret' });
    const rule = await raised(events);
    expect(rule.prompt).toMatchObject({
      kind: 'approval',
      subject: { type: 'tool', tool: 'Read' },
      signals: { askRule: true },
    });
    session.prompts?.answer(rule.key, { kind: 'choice', value: 'allow' });
    await waitFor(events, (e) => e.type === 'end');

    await session.send({ id: '00000000-0000-4000-8000-0000000000a2', text: 'safety first' });
    const safety = await raised(events, 2);
    expect(safety.prompt).toMatchObject({
      kind: 'approval',
      subject: { type: 'tool', tool: 'Write' },
      signals: { safetyCheck: true },
      reason: expect.stringMatching(/but you haven't granted it yet\.$/) as unknown,
    });
    expect(
      safety.prompt.kind === 'approval' && safety.prompt.choices.map(({ value }) => value),
    ).toEqual(['allow', 'deny', 'deny-feedback']);
    // No: the turn stops, as the CLI's No does.
    session.prompts?.answer(safety.key, { kind: 'choice', value: 'deny' });
    await waitFor(
      events,
      (e) => e.type === 'end' && e.messages.includes('00000000-0000-4000-8000-0000000000a2'),
    );
    expect(events.findLast((e) => e.type === 'end')).toMatchObject({
      result: { status: 'cancelled' },
    });
  });

  it('offers always as the CLI suggests it, all at once, and its session mode is kept', async () => {
    const { session, events } = await start();
    await session.send({ id: '00000000-0000-4000-8000-0000000000a3', text: 'touch it' });
    const touch = await raised(events);
    if (touch.prompt.kind !== 'approval') throw new Error('not an approval');
    expect(touch.prompt.choices.find(({ value }) => value === 'always')).toMatchObject({
      hint: 'allow_always',
      effects: {
        rules: [{ behavior: 'allow', rule: 'Bash(touch made.txt)', scope: 'project' }],
        directories: [await realpath(folder)],
        mode: 'acceptEdits',
      },
    });
    session.prompts?.answer(touch.key, { kind: 'choice', value: 'always' });
    await waitFor(events, (e) => e.type === 'end');
    // The CLI kept the session mode it was given: it says so.
    expect(events).toContainEqual({ type: 'mode', mode: 'acceptEdits' });
  });

  it('raises an MCP server’s tool call as its server’s, and the link it asks to open', async () => {
    const { session, events } = await start();
    await session.send({
      id: '00000000-0000-4000-8000-0000000000a4',
      text: 'sign in: open a link',
    });
    const call = await raised(events);
    expect(call.prompt).toMatchObject({
      kind: 'approval',
      subject: { type: 'mcpTool', server: 'tracker', tool: 'mcp__tracker__sign_in' },
      signals: { requiresUser: true },
    });
    session.prompts?.answer(call.key, { kind: 'choice', value: 'allow' });
    const link = await raised(events, 2);
    expect(link.prompt).toEqual({
      kind: 'form',
      title: 'MCP server “tracker” asks you to open a link on tracker.example.com',
      server: 'tracker',
      answerIn: 'api',
      form: { url: 'https://tracker.example.com/sign-in?state=abc123' },
    });
    session.prompts?.answer(link.key, { kind: 'form', action: 'accept' });
    await waitFor(events, (e) => e.type === 'end');
    const replied = events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');
    expect(replied).toBe('tracker got: accept');
  });

  it('approves a plan into the mode chosen, the CLI going into it with its approval', async () => {
    const { session, events } = await start();
    await session.setMode('plan');
    await session.send({ id: '00000000-0000-4000-8000-0000000000a5', text: 'make a plan' });
    const plan = await raised(events);
    expect(plan.prompt).toMatchObject({
      kind: 'plan',
      plan: expect.stringMatching(/^1\. Write/) as unknown,
    });
    expect(plan.prompt).not.toHaveProperty('signals');
    session.prompts?.answer(plan.key, { kind: 'choice', value: 'acceptEdits' });
    await waitFor(events, (e) => e.type === 'end');
    const replied = events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');
    expect(replied).toBe('Approved: carrying it out in acceptEdits.');
    expect(events.findLast((e) => e.type === 'mode')).toEqual({
      type: 'mode',
      mode: 'acceptEdits',
    });
  });

  it('declines what the core declines without stopping the turn, and ends what waits as it closes', async () => {
    const { session, events } = await start();
    await session.send({ id: '00000000-0000-4000-8000-0000000000a6', text: 'touch it' });
    const first = await raised(events);
    session.prompts?.decline(first.key, 'corrallm declined this request: too many wait.');
    await waitFor(events, (e) => e.type === 'end');
    expect(events.findLast((e) => e.type === 'end')).toMatchObject({
      result: { status: 'completed' },
    });
    await session.send({ id: '00000000-0000-4000-8000-0000000000a7', text: 'touch it again' });
    const second = await raised(events, 2);
    await session.close();
    expect(events).toContainEqual({ type: 'prompt-ended', key: second.key, reason: 'withdrawn' });
  });

  it('restores files to before a message, and forks the conversation to before it', async () => {
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

    // Its conversation: a copy up to before that message, which resumes without it.
    const kept = new Conversations();
    const id = remembered.at(-1) ?? '';
    const point = await kept.before(folder, id, second);
    if (point === null) throw new Error('nothing before it');
    const forked = await kept.fork(folder, id, point);
    await live.close();
    session = undefined;
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

  it('does not start the session on a Claude subscription login, and says why', async () => {
    const events: HostEvent[] = [];
    await expect(start('manual', {}, events)).rejects.toThrow(SUBSCRIPTION_LOGIN);
    expect(session).toBeUndefined();
    expect(events).toMatchObject([
      {
        type: 'notice',
        level: 'error',
        text: SUBSCRIPTION_LOGIN,
        switchTo: 'claude-code.terminal',
      },
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

  it('stops a command running in the background, and sets the effort', async () => {
    const { session, events } = await start('acceptEdits');
    await session.setEffort?.('high');
    await session.send({ id: '00000000-0000-4000-8000-00000000000c', text: 'background' });
    const listed = await waitFor(
      events,
      (e) => e.type === 'tasks' && e.tasks.some((task) => task.tool !== undefined),
    );
    if (listed.type !== 'tasks') throw new Error('no tasks');
    expect(listed.tasks).toEqual([
      {
        id: 'b1',
        description: 'npm run dev',
        kind: 'command',
        tool: expect.any(String) as unknown,
      },
    ]);
    await waitFor(events, (e) => e.type === 'end');
    await expect(session.stopTask?.('nope')).rejects.toThrow(/not running/);
    await session.stopTask?.('b1');
    const stopped = await waitFor(
      events,
      (e) => e.type === 'tool' && e.id === listed.tasks[0]?.tool && e.status === 'interrupted',
    );
    expect(stopped).toMatchObject({ tool: 'Bash', summary: 'npm run dev' });
    expect(events.at(-1)).toEqual({ type: 'tasks', tasks: [] });
  });

  it('says when a hook blocks a command, shows a command’s progress, and predicts the next message', async () => {
    const { session, events } = await start('acceptEdits');
    await session.send({ id: '00000000-0000-4000-8000-00000000000d', text: 'hook test suggest' });
    await waitFor(events, (e) => e.type === 'suggestion');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'notice',
        level: 'error',
        text: 'PreToolUse:Bash hook returned blocking error: Use pnpm, not npm.',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool', summary: 'npm test', progress: { seconds: 3 } }),
    );
    expect(events.at(-1)).toEqual({ type: 'suggestion', text: 'Run the tests' });
  });
});
