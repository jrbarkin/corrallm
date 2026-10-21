import type {
  CanUseTool,
  McpServerStatus,
  RewindFilesResult,
  Options,
  PermissionMode,
  Query,
  query as sdkQuery,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKUserMessage,
  SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { SessionEvent } from '../../../../shared/session';
import type { SessionHost, SessionSpec } from '../../connector';
import { SdkConnector } from './connector';
import { SUBSCRIPTION_LOGIN } from './login';
import type { AuthStatus } from './login';
import { recorded, recordedHistory, recordedMessages } from './recorded';
import type { Fixture } from './recorded';

/** The models and commands the real CLI gave at start, as recorded. */
const INIT = (() => {
  const found = recorded('tools-and-compact').find((item) => item.kind === 'initializationResult');
  if (!found) throw new Error('no initialization');
  return found.data;
})();

/**
 * Stands in for the Agent SDK's query(): it records how it was called, reads what the session
 * sends, and yields the messages a test gives it, as the CLI would.
 */
class FakeQuery {
  readonly options: Options;
  readonly sent: SDKUserMessage[] = [];
  readonly interrupt = vi
    .fn<(options?: { cancelQueued?: boolean }) => Promise<SDKControlInterruptResponse>>()
    .mockResolvedValue({ still_queued: [] });
  readonly setPermissionMode = vi.fn<(mode: PermissionMode) => Promise<void>>().mockResolvedValue();
  readonly setModel = vi.fn<(model?: string) => Promise<void>>().mockResolvedValue();
  readonly mcpServerStatus = vi.fn<() => Promise<McpServerStatus[]>>().mockResolvedValue([]);
  readonly rewindFiles = vi
    .fn<(id: string, options?: { dryRun?: boolean }) => Promise<RewindFilesResult>>()
    .mockResolvedValue({ canRewind: true, filesChanged: [], insertions: 0, deletions: 0 });
  readonly reconnectMcpServer = vi.fn<(name: string) => Promise<void>>().mockResolvedValue();
  readonly toggleMcpServer = vi
    .fn<(name: string, enabled: boolean) => Promise<void>>()
    .mockResolvedValue();
  readonly stopTask = vi.fn<(taskId: string) => Promise<void>>().mockResolvedValue();
  readonly applyFlagSettings = vi
    .fn<(settings: Record<string, unknown>) => Promise<void>>()
    .mockResolvedValue();
  readonly close = vi.fn(() => {
    this.finish();
  });
  initialization: Promise<unknown> = Promise.resolve(INIT);
  /** The CLI's settings, merged, as get_settings answers (the runtime's getSettings()). */
  settings: unknown = { effective: {} };
  readonly getSettings = vi.fn(() => Promise.resolve(this.settings));
  readonly #messages: (SDKMessage | Error | null)[] = [];
  #wake: (() => void) | undefined;

  constructor(prompt: AsyncIterable<SDKUserMessage>, options: Options) {
    this.options = options;
    void (async () => {
      for await (const message of prompt) this.sent.push(message);
    })();
  }

  initializationResult() {
    return this.initialization;
  }

  /** The CLI says `messages`. */
  say(...messages: SDKMessage[]) {
    this.#messages.push(...messages);
    this.#wake?.();
  }

  /** The CLI exits: cleanly, or with `error`. */
  finish(error?: Error) {
    this.#messages.push(error ?? null);
    this.#wake?.();
  }

  get canUseTool(): CanUseTool {
    const given = this.options.canUseTool;
    if (!given) throw new Error('no canUseTool');
    return given;
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      const next = this.#messages.shift();
      if (next === undefined) {
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
        continue;
      }
      if (next === null) return;
      if (next instanceof Error) throw next;
      yield next;
    }
  }
}

const SPEC: SessionSpec = {
  agentId: 'a',
  cwd: '/home/user/shop',
  env: { PATH: '/usr/bin', HOME: '/home/user' },
  model: null,
  mode: 'manual',
  resume: null,
};

/** Lets the session read what the fake CLI said. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** How the CLI says it is logged in, unless a test says otherwise: with an API key. */
const API_KEY: AuthStatus = { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' };

function connector({
  history = [],
  prepare,
  login = () => Promise.resolve(API_KEY),
}: {
  history?: SessionMessage[];
  prepare?: (query: FakeQuery, call: number) => void;
  login?: () => Promise<AuthStatus>;
} = {}) {
  const queries: FakeQuery[] = [];
  const events: SessionEvent[] = [];
  const remembered: string[] = [];
  const host: SessionHost = {
    emit: (event) => events.push(event),
    remember: (id) => remembered.push(id),
  };
  const getSessionMessages = vi.fn(() => Promise.resolve(history));
  const authStatus = vi.fn(login);
  const sdk = new SdkConnector({
    clientApp: 'corrallm/0.1.0',
    query: ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      const query = new FakeQuery(params.prompt, params.options);
      prepare?.(query, queries.length);
      queries.push(query);
      return query as unknown as Query;
    }) as unknown as typeof sdkQuery,
    getSessionMessages,
    findClaude: () => Promise.resolve('/home/user/.local/bin/claude'),
    authStatus,
    home: '/home/user',
  });
  const query = () => {
    const last = queries.at(-1);
    if (!last) throw new Error('no query');
    return last;
  };
  return { sdk, host, events, remembered, queries, query, getSessionMessages, authStatus };
}

/** A recorded turn's messages, from the message that started it to its result. */
function turn(fixture: Fixture, index: number): SDKMessage[] {
  const messages = recordedMessages(fixture);
  const results = messages.flatMap((m, i) => (m.type === 'result' ? [i] : []));
  const from = index === 0 ? 0 : (results[index - 1] ?? 0) + 1;
  return messages.slice(from, (results[index] ?? 0) + 1);
}

describe('SdkConnector', () => {
  it('reports each incoming SDK message as activity', async () => {
    const { sdk, host, query } = connector();
    const activity = vi.fn();
    host.activity = activity;
    const session = await sdk.start(SPEC, host);
    try {
      const messages = turn('tools-and-compact', 0);
      query().say(...messages);
      await vi.waitFor(() => {
        expect(activity).toHaveBeenCalledTimes(messages.length);
      });
    } finally {
      await session.close();
    }
  });
  it('appends changed roles to the native preset on exact-ID resume, with snapshotting off and no synthetic turn', async () => {
    const { sdk, host, query } = connector();
    const resume = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11';
    const initial = '--dangerously-skip-permissions\nReview "quoted" paths\t$(echo literal)';
    for (const role of [initial, 'Updated review role', undefined]) {
      const session = await sdk.start(
        { ...SPEC, resume, roleChanged: true, ...(role === undefined ? {} : { role }) },
        host,
      );
      expect(query().options.systemPrompt).toEqual({
        type: 'preset',
        preset: 'claude_code',
        ...(role === undefined ? {} : { append: role }),
        snapshot: false,
      });
      expect(query().options.settingSources).toEqual(['user', 'project', 'local']);
      expect(query().options.resume).toBe(resume);
      expect(query().sent).toEqual([]);
      await session.close();
    }
  });

  it.each([undefined, 'Review changes'])(
    'keeps the native prompt snapshot for an unchanged role %j on resume',
    async (role) => {
      const { sdk, host, query } = connector();
      const resume = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11';
      const session = await sdk.start(
        { ...SPEC, resume, roleChanged: false, ...(role === undefined ? {} : { role }) },
        host,
      );
      expect(query().options.systemPrompt).toEqual({
        type: 'preset',
        preset: 'claude_code',
        ...(role === undefined ? {} : { append: role }),
      });
      expect(query().options.resume).toBe(resume);
      expect(query().sent).toEqual([]);
      await session.close();
    },
  );

  it('runs the user’s claude as Claude Code, in the project folder, with their settings', async () => {
    const { sdk, host, query } = connector();
    await sdk.start(SPEC, host);
    const { options } = query();
    expect(options).toMatchObject({
      pathToClaudeCodeExecutable: '/home/user/.local/bin/claude',
      cwd: '/home/user/shop',
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      permissionMode: 'default',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      // Claude Code's file checkpoints, which a rewind restores.
      enableFileCheckpointing: true,
      // Hooks that fail or block are shown; the composer offers what the CLI predicts next.
      includeHookEvents: true,
      promptSuggestions: true,
      env: {
        PATH: '/usr/bin',
        HOME: '/home/user',
        CLAUDE_AGENT_SDK_CLIENT_APP: 'corrallm/0.1.0',
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
      },
    });
    expect(options.spawnClaudeCodeProcess).toBeTypeOf('function');
    // The CLI's default model, and a new conversation.
    expect(options).not.toHaveProperty('model');
    expect(options).not.toHaveProperty('resume');
  });

  it('asks the CLI how it is logged in first, in the project folder with the agents’ environment', async () => {
    const { sdk, host, authStatus } = connector();
    await sdk.start(SPEC, host);
    expect(authStatus).toHaveBeenCalledWith('/home/user/.local/bin/claude', {
      cwd: '/home/user/shop',
      env: SPEC.env,
    });
  });

  it('does not start on a Claude subscription login: it says why, and offers Terminal', async () => {
    const { sdk, host, events, queries } = connector({
      login: () =>
        Promise.resolve({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
          subscriptionType: 'max',
        }),
    });
    await expect(sdk.start(SPEC, host)).rejects.toThrow(SUBSCRIPTION_LOGIN);
    expect(queries).toEqual([]);
    expect(events).toEqual([
      {
        type: 'notice',
        id: expect.any(String) as unknown,
        level: 'error',
        text: SUBSCRIPTION_LOGIN,
        switchTo: 'claude-code.terminal',
      },
    ]);
    expect(SUBSCRIPTION_LOGIN).toMatch(/Anthropic doesn't allow other products/);
  });

  it('does not start when it cannot tell how the CLI is logged in', async () => {
    const { sdk, host, events, queries } = connector({
      login: () => Promise.reject(new Error('error: unknown command auth')),
    });
    await expect(sdk.start(SPEC, host)).rejects.toThrow(
      /couldn't check how Claude Code is logged in \(error: unknown command auth\)/,
    );
    expect(queries).toEqual([]);
    expect(events).toMatchObject([
      { type: 'notice', level: 'error', switchTo: 'claude-code.terminal' },
    ]);
  });

  it('says it started, with the models and slash commands the CLI offers', async () => {
    const { sdk, host, events } = connector();
    await sdk.start({ ...SPEC, mode: 'plan' }, host);
    expect(events[0]).toMatchObject({ type: 'started', model: 'default', mode: 'plan' });
    const started = events[0]?.type === 'started' ? events[0] : undefined;
    expect(started?.models.map((m) => m.value).slice(0, 5)).toEqual([
      'default',
      'opus',
      'fable',
      'sonnet',
      'haiku',
    ]);
    expect(started?.models[4]).toMatchObject({
      value: 'haiku',
      label: 'Haiku 5.5',
      description: 'Fastest for quick answers',
    });
    // Its effort levels, as Claude Code's effort menu offers them.
    const efforts = started?.models[4]?.efforts;
    expect(efforts?.map((effort) => effort.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(efforts?.[3]).toEqual({
      value: 'xhigh',
      label: 'Extra high',
      description: 'Extended reasoning with thorough analysis',
    });
    // At its model's default effort, unless given one.
    expect(started?.effort).toBeNull();
    // A model that takes no effort level offers none.
    expect(started?.models.find((m) => m.value === 'claude-haiku-4-5-20251001')).not.toHaveProperty(
      'efforts',
    );
    const commands = events[1]?.type === 'commands' ? events[1].commands : [];
    expect(commands).toContainEqual({
      name: 'compact',
      description: 'Free up context by summarizing the conversation so far',
      argumentHint: '<optional custom summarization instructions>',
    });
  });

  it('starts in the user’s own default mode when none was chosen, saying which it is', async () => {
    const { sdk, host, query, events } = connector({
      prepare: (q) => {
        q.settings = { effective: { permissions: { defaultMode: 'acceptEdits' } }, sources: [] };
      },
    });
    await sdk.start({ ...SPEC, mode: null }, host);
    expect(query().options).not.toHaveProperty('permissionMode');
    expect(events[0]).toMatchObject({ type: 'started', mode: 'acceptEdits' });
  });

  it('keeps an unknown native mode unset, and a chosen mode wins', async () => {
    const quiet = connector({
      prepare: (q) => {
        q.getSettings.mockRejectedValue(new Error('Unknown request: get_settings'));
      },
    });
    await quiet.sdk.start({ ...SPEC, mode: null }, quiet.host);
    expect(quiet.events[0]).toMatchObject({ type: 'started', mode: null });

    const chosen = connector({
      prepare: (q) => {
        q.settings = { effective: { permissions: { defaultMode: 'acceptEdits' } } };
      },
    });
    await chosen.sdk.start({ ...SPEC, mode: 'plan' }, chosen.host);
    expect(chosen.query().options.permissionMode).toBe('plan');
    expect(chosen.events[0]).toMatchObject({ type: 'started', mode: 'plan' });
  });

  it('does not offer bypassing permissions where the CLI’s settings turn it off', async () => {
    const off = connector({
      prepare: (q) => {
        q.settings = { effective: { permissions: { disableBypassPermissionsMode: 'disable' } } };
      },
    });
    await off.sdk.start(SPEC, off.host);
    expect(off.events[0]).toMatchObject({
      type: 'started',
      modes: ['manual', 'acceptEdits', 'plan', 'auto'],
    });

    const on = connector();
    await on.sdk.start(SPEC, on.host);
    expect(on.events[0]).not.toHaveProperty('modes');
  });

  it('starts with the model picked', async () => {
    const { sdk, host, query, events } = connector();
    await sdk.start({ ...SPEC, model: 'haiku' }, host);
    expect(query().options.model).toBe('haiku');
    expect(events[0]).toMatchObject({ type: 'started', model: 'haiku' });
  });

  it('tells the CLI a message from another party is a peer’s, never the user’s', async () => {
    const { sdk, host, query } = connector();
    const session = await sdk.start(SPEC, host);
    const id = '4f0c9f4e-2a8b-4c1d-9e3f-5a6b7c8d9e0f';
    await session.send({
      id,
      text: '[corrallm] Message from "orchestrator" (…):\nSay hello',
      from: { party: 'outside:orchestrator', name: 'orchestrator' },
    });
    await settle();
    // No fromMode: an undeclared sender, held at a recipient that runs without asking.
    expect(query().sent[0]?.origin).toEqual({
      kind: 'peer',
      from: 'outside:orchestrator',
      name: 'orchestrator',
    });
  });

  it('plays a turn: the message goes to the CLI, what it does comes back, and its result ends it', async () => {
    const { sdk, host, query, events, remembered } = connector();
    const session = await sdk.start(SPEC, host);
    // The id the recorded turn's message had.
    const id = 'dbc6dbde-0692-46d4-94c1-206b7b606f06';
    await session.send({ id, text: 'Run echo hello' });
    await settle();
    expect(query().sent).toEqual([
      {
        type: 'user',
        message: { role: 'user', content: 'Run echo hello' },
        parent_tool_use_id: null,
        uuid: id,
        origin: { kind: 'human' },
      },
    ]);
    expect(events.slice(-2)).toEqual([
      { type: 'user', id, text: 'Run echo hello' },
      { type: 'status', status: 'working' },
    ]);

    query().say(...turn('tools-and-compact', 0));
    await settle();
    expect(remembered).toEqual(['a8629cd9-286a-4160-b524-97c271917415']);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool', tool: 'Bash', status: 'done' }),
    );
    expect(events.at(-1)).toEqual({
      type: 'end',
      messages: [id],
      seconds: 5,
      result: { status: 'completed', reason: 'completed' },
    });
  });

  it('ends a native error result as failed, with its API error', async () => {
    const { sdk, host, query, events } = connector();
    const session = await sdk.start(SPEC, host);
    const id = '00000000-0000-4000-8000-000000000001';
    await session.send({ id, text: 'Hello' });
    await settle();
    const result = turn('tools-and-compact', 0).find((message) => message.type === 'result');
    if (!result) throw new Error('no recorded result');
    query().say({
      ...result,
      subtype: 'error_during_execution' as const,
      is_error: true,
      errors: ['The upstream API failed.'],
      user_message_uuids: [id],
    });
    await settle();
    expect(events.at(-1)).toMatchObject({
      type: 'end',
      messages: [id],
      result: { status: 'failed', reason: 'api', message: 'The upstream API failed.' },
    });
    expect(events.at(-1)).not.toHaveProperty('interrupted');
    expect(events.at(-1)).not.toHaveProperty('failed');
  });

  it('remembers its session only once a turn has made it one to resume', async () => {
    const { sdk, host, query, remembered } = connector();
    await sdk.start(SPEC, host);
    // Before any message, the CLI names a session it has not written down yet.
    query().say({
      type: 'system',
      subtype: 'commands_changed',
      commands: [],
      session_id: 'not-yet',
    } as unknown as SDKMessage);
    await settle();
    expect(remembered).toEqual([]);
    // /clear: the CLI starts a new conversation, which the next turn names.
    query().say(...turn('tools-and-compact', 0));
    query().say({
      ...turn('tools-and-compact', 0).find((m) => m.type === 'system' && m.subtype === 'init'),
      session_id: 'after-clear',
    } as SDKMessage);
    await settle();
    expect(remembered).toEqual(['a8629cd9-286a-4160-b524-97c271917415', 'after-clear']);
  });

  it('sends pasted images with the message', async () => {
    const { sdk, host, query } = connector();
    const session = await sdk.start(SPEC, host);
    await session.send({
      id: 'not-a-uuid',
      text: 'What is this?',
      images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }],
    });
    await settle();
    const [sent] = query().sent;
    expect(sent?.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      { type: 'text', text: 'What is this?' },
    ]);
    // The CLI names messages by uuid: one is made for an id that is not one.
    expect(sent?.uuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('asks the user before a tool runs, and tells the CLI their answer', async () => {
    const { sdk, host, query, events } = connector();
    const session = await sdk.start(SPEC, host);
    const asked = query().canUseTool(
      'Bash',
      { command: 'npm test' },
      {
        signal: new AbortController().signal,
        toolUseID: 'toolu_1',
        requestId: 'r1',
        suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'localSettings',
            rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
          },
        ],
      },
    );
    expect(events.slice(-2)).toEqual([
      {
        type: 'permission',
        id: 'toolu_1:prompt',
        tool: 'Bash',
        summary: 'npm test',
        always: "Yes, and don't ask again for `npm test` commands in shop",
      },
      { type: 'status', status: 'waiting' },
    ]);
    await session.answer('toolu_1:prompt', { kind: 'permission', answer: 'once' });
    expect(await asked).toMatchObject({ behavior: 'allow', updatedInput: { command: 'npm test' } });
    await expect(
      session.answer('toolu_1:prompt', { kind: 'permission', answer: 'once' }),
    ).rejects.toThrow(/no longer asked/);
  });

  it('gives a prompt an id of its own, apart from its tool call’s entry', async () => {
    const { sdk, host, query, events } = connector();
    await sdk.start(SPEC, host);
    // As the CLI does it: the tool call shows, then it asks whether it may run.
    query().say(
      ...turn('tools-and-compact', 0).filter(
        (m) => m.type === 'assistant' && m.message.content[0]?.type === 'tool_use',
      ),
    );
    await settle();
    void query().canUseTool(
      'Write',
      { file_path: '/home/user/shop/notes.txt', content: 'one\n' },
      {
        signal: new AbortController().signal,
        toolUseID: 'toolu_01BcsAQYMNM52sfGgGbPDfjx',
        requestId: 'r',
      },
    );
    const ids = events.flatMap((event) =>
      event.type === 'tool' || event.type === 'permission' ? [`${event.type} ${event.id}`] : [],
    );
    expect(ids).toContain('tool toolu_01BcsAQYMNM52sfGgGbPDfjx');
    const prompt = events.find((event) => event.type === 'permission');
    expect(prompt?.type === 'permission' && prompt.id).not.toBe('toolu_01BcsAQYMNM52sfGgGbPDfjx');
  });

  it('interrupts the turn: its result ends it, interrupted', async () => {
    const { sdk, host, query, events } = connector();
    const session = await sdk.start(SPEC, host);
    const id = '3a2eff9f-14a3-454c-aefe-ba5ce6baf1cf';
    await session.send({ id, text: 'Write a story' });
    await session.interrupt();
    expect(query().interrupt).toHaveBeenCalledWith({ cancelQueued: true });
    query().say(...turn('subagent-and-interrupt', 1));
    await settle();
    expect(events.at(-1)).toMatchObject({
      type: 'end',
      messages: [id],
      result: { status: 'cancelled' },
    });
  });

  it('ends a message the CLI had not started, when interrupting cancels it', async () => {
    const { sdk, host, query, events } = connector();
    const session = await sdk.start(SPEC, host);
    const id = '00000000-0000-4000-8000-000000000001';
    await session.send({ id, text: 'Later' });
    query().interrupt.mockResolvedValueOnce({ still_queued: [], cancelled: [id] });
    await session.interrupt();
    expect(events.at(-1)).toMatchObject({
      type: 'end',
      messages: [id],
      result: { status: 'cancelled' },
    });
  });

  it('does not end a message on another turn’s result (a background task’s follow-up)', async () => {
    const { sdk, host, query, events } = connector();
    const session = await sdk.start(SPEC, host);
    await session.send({ id: '00000000-0000-4000-8000-000000000002', text: 'Hello' });
    query().say({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      duration_ms: 1000,
      total_cost_usd: 0,
      modelUsage: {},
      origin: { kind: 'task-notification' },
      user_message_uuids: [],
    } as unknown as SDKMessage);
    await settle();
    expect(events.filter((event) => event.type === 'end')).toEqual([]);
  });

  it('says the mode it switched to, so a view that heard another since shows it', async () => {
    const { sdk, host, events } = connector();
    const session = await sdk.start(SPEC, host);
    // As when the user picked a mode while the session started: 'started' said Manual since.
    await session.setMode('acceptEdits');
    expect(events.at(-1)).toEqual({ type: 'mode', mode: 'acceptEdits' });
  });

  it('switches mode and model as the composer asks', async () => {
    const { sdk, host, query, events } = connector();
    const session = await sdk.start(SPEC, host);
    await session.setMode('acceptEdits');
    await session.setMode('manual');
    expect(query().setPermissionMode.mock.calls).toEqual([['acceptEdits'], ['default']]);
    await session.setModel('haiku');
    expect(query().setModel).toHaveBeenCalledWith('haiku');
    expect(events.at(-1)).toEqual({ type: 'model', model: 'haiku' });

    // A mode the CLI refuses: the composer goes back to the mode it was in.
    query().setPermissionMode.mockRejectedValueOnce(new Error('Auto mode is not available'));
    await expect(session.setMode('auto')).rejects.toThrow(/not available/);
    expect(events.at(-1)).toEqual({ type: 'mode', mode: 'manual' });
  });

  it('restores files to how they were before a message, or says what that would change', async () => {
    const { sdk, host, query } = connector();
    const session = await sdk.start(SPEC, host);
    const message = '00000000-0000-4000-8000-0000000000aa';
    query().rewindFiles.mockResolvedValue({
      canRewind: true,
      filesChanged: ['/home/user/shop/src/login.ts', '/home/user/notes.md'],
      insertions: 4,
      deletions: 10,
    });
    await expect(session.rewindFiles?.(message, true)).resolves.toEqual({
      possible: true,
      files: [path.join('src', 'login.ts'), path.join('~', 'notes.md')],
      added: 4,
      removed: 10,
    });
    expect(query().rewindFiles).toHaveBeenLastCalledWith(message, { dryRun: true });
    query().rewindFiles.mockResolvedValue({ canRewind: false, error: 'No checkpoint' });
    await expect(session.rewindFiles?.(message, false)).resolves.toEqual({
      possible: false,
      error: 'No checkpoint',
      files: [],
      added: 0,
      removed: 0,
    });
    expect(query().rewindFiles).toHaveBeenLastCalledWith(message, { dryRun: false });

    // Not while a turn goes on, and not to a message the CLI can't know.
    await session.send({ id: '00000000-0000-4000-8000-0000000000bb', text: 'Go' });
    await expect(session.rewindFiles?.(message, true)).rejects.toThrow(/until it is done/);
    await expect(session.rewindFiles?.('m1', true)).rejects.toThrow(/can’t be rewound/);
  });

  it('lists its MCP servers, and reconnects, enables and disables them as /mcp asks', async () => {
    const { sdk, host, query } = connector();
    const session = await sdk.start(SPEC, host);
    query().mcpServerStatus.mockResolvedValue([
      { name: 'github', status: 'connected', scope: 'user', tools: [{ name: 'create_issue' }] },
      { name: 'sentry', status: 'failed', error: 'Connection refused' },
    ]);
    await expect(session.mcpServers?.()).resolves.toEqual([
      { name: 'github', status: 'connected', scope: 'user', tools: 1 },
      { name: 'sentry', status: 'failed', error: 'Connection refused' },
    ]);
    await session.changeMcpServer?.('sentry', 'reconnect');
    await session.changeMcpServer?.('github', 'disable');
    await session.changeMcpServer?.('github', 'enable');
    expect(query().reconnectMcpServer).toHaveBeenCalledWith('sentry');
    expect(query().toggleMcpServer.mock.calls).toEqual([
      ['github', false],
      ['github', true],
    ]);
  });

  it('asks the user what an MCP server asks for, in a form', async () => {
    const { sdk, host, query, events } = connector();
    const session = await sdk.start(SPEC, host);
    const elicit = query().options.onElicitation;
    if (!elicit) throw new Error('no onElicitation');
    const told = elicit(
      {
        serverName: 'github',
        message: 'Which repository?',
        mode: 'form',
        requestedSchema: { type: 'object', properties: { repo: { type: 'string' } } },
      },
      { signal: new AbortController().signal, requestId: 'r' },
    );
    const asked = events.find((event) => event.type === 'elicitation');
    if (asked?.type !== 'elicitation') throw new Error('nothing asked');
    await session.answer(asked.id, {
      kind: 'elicitation',
      action: 'accept',
      values: { repo: 'acme/shop' },
    });
    expect(await told).toEqual({ action: 'accept', content: { repo: 'acme/shop' } });
  });

  it('sets the effort the composer picks, for this session, and only one Claude Code has', async () => {
    const { sdk, host, query } = connector();
    const session = await sdk.start(SPEC, host);
    await session.setEffort?.('xhigh');
    await session.setEffort?.(null);
    await expect(session.setEffort?.('ultra')).rejects.toThrow(/no ultra effort/);
    expect(query().applyFlagSettings.mock.calls).toEqual([
      [{ effortLevel: 'xhigh' }],
      [{ effortLevel: null }],
    ]);
  });

  it('starts at the effort it was given, where its model takes one', async () => {
    const { sdk, host, query, events } = connector();
    await sdk.start({ ...SPEC, model: 'haiku', effort: 'high' }, host);
    expect(query().applyFlagSettings.mock.calls).toEqual([[{ effortLevel: 'high' }]]);
    expect(events[0]).toMatchObject({ type: 'started', model: 'haiku', effort: 'high' });

    // A model that takes none starts at none.
    const other = connector();
    await other.sdk.start(
      { ...SPEC, model: 'claude-haiku-4-5-20251001', effort: 'high' },
      other.host,
    );
    expect(other.query().applyFlagSettings).not.toHaveBeenCalled();
    expect(other.events[0]).toMatchObject({ type: 'started', effort: null });
  });

  it('stops a task running in the background, and only one that is', async () => {
    const { sdk, host, query } = connector();
    const session = await sdk.start(SPEC, host);
    await expect(session.stopTask?.('b1')).rejects.toThrow(/not running/);
    query().say({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'npm run dev' }],
    } as unknown as SDKMessage);
    await settle();
    await session.stopTask?.('b1');
    expect(query().stopTask).toHaveBeenCalledWith('b1');
  });

  it('denies a tool with what to do instead: Claude goes on with it, as in Claude Code', async () => {
    const { sdk, host, query } = connector();
    const session = await sdk.start(SPEC, host);
    const asked = query().canUseTool(
      'Bash',
      { command: 'npm test' },
      { signal: new AbortController().signal, toolUseID: 'toolu_2', requestId: 'r2' },
    );
    await session.answer('toolu_2:prompt', {
      kind: 'permission',
      answer: 'deny',
      feedback: 'Use pnpm here',
    });
    const result = await asked;
    expect(result).toEqual({
      behavior: 'deny',
      message:
        "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nUse pnpm here",
      decisionClassification: 'user_reject',
    });
  });

  it('carries out an approved plan in the mode chosen, once the CLI has left plan mode', async () => {
    const { sdk, host, query } = connector();
    const session = await sdk.start({ ...SPEC, mode: 'plan' }, host);
    const approved = query().canUseTool(
      'ExitPlanMode',
      { plan: '1. Do it' },
      { signal: new AbortController().signal, toolUseID: 'toolu_plan', requestId: 'r' },
    );
    await session.answer('toolu_plan:prompt', {
      kind: 'plan',
      answer: { approve: true, mode: 'acceptEdits' },
    });
    await approved;
    expect(query().setPermissionMode).not.toHaveBeenCalled();
    // As recorded: the CLI goes back to the mode before plan mode...
    query().say({
      type: 'system',
      subtype: 'status',
      status: null,
      permissionMode: 'default',
    } as unknown as SDKMessage);
    await settle();
    // ...and the session goes on in the one chosen.
    expect(query().setPermissionMode).toHaveBeenCalledWith('acceptEdits');
  });

  it('resumes the agent’s session, showing what it did before', async () => {
    const { sdk, host, query, events, getSessionMessages } = connector({
      history: recordedHistory('subagent-and-interrupt'),
    });
    await sdk.start({ ...SPEC, resume: '8e7858d0-0cd7-4d37-a2a8-5bd390ce27fb' }, host);
    expect(query().options.resume).toBe('8e7858d0-0cd7-4d37-a2a8-5bd390ce27fb');
    expect(getSessionMessages).toHaveBeenCalledWith('8e7858d0-0cd7-4d37-a2a8-5bd390ce27fb', {
      dir: '/home/user/shop',
      includeSystemMessages: true,
    });
    const history = events.find((event) => event.type === 'history');
    expect(history?.type === 'history' && history.events[0]).toMatchObject({
      type: 'user',
      id: 'a88af29d-600f-4515-abeb-ce910cc34bf6',
    });
  });

  it('finds a resumed session’s history where the CLI keeps it: by the folder’s real path', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'corrallm-link-'));
    try {
      const link = path.join(dir, 'link');
      // A junction on Windows, which needs no privileges.
      await symlink(dir, link, 'junction');
      const { sdk, host, getSessionMessages } = connector();
      await sdk.start({ ...SPEC, cwd: link, resume: 'abc' }, host);
      expect(getSessionMessages).toHaveBeenCalledWith('abc', {
        dir: await realpath(dir),
        includeSystemMessages: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('starts a new conversation when the earlier one cannot be resumed, and says so', async () => {
    const { sdk, host, queries, events } = connector({
      prepare: (query, call) => {
        if (call === 0) {
          query.options.stderr?.('Error: the session’s transcript could not be read\n');
          query.initialization = Promise.reject(
            new Error('Claude Code process exited with code 1'),
          );
        }
      },
    });
    await sdk.start(
      { ...SPEC, resume: 'broken', role: 'Fallback review role', roleChanged: true },
      host,
    );
    expect(queries.map((q) => q.options.resume)).toEqual(['broken', undefined]);
    expect(queries.map((q) => q.options.systemPrompt)).toEqual([
      { type: 'preset', preset: 'claude_code', append: 'Fallback review role', snapshot: false },
      { type: 'preset', preset: 'claude_code', append: 'Fallback review role' },
    ]);
    expect(queries[0]?.close).toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'notice',
        level: 'warning',
        text: expect.stringMatching(/could not be resumed.*could not be read/) as unknown,
      }),
    );
  });

  it('starts a new conversation quietly when the id it resumes has none', async () => {
    // As the CLI says for an id with no transcript: one a Terminal session of the same agent was
    // given before its first message (the agent's id is shared between its connections).
    const { sdk, host, queries, events } = connector({
      prepare: (query, call) => {
        if (call === 0) {
          query.initialization = Promise.reject(
            new Error(
              'Claude Code returned an error result: No conversation found with session ID: 5c1f0e7a-1b2c-4d3e-8f90-123456789abc',
            ),
          );
        }
      },
    });
    await sdk.start({ ...SPEC, resume: '5c1f0e7a-1b2c-4d3e-8f90-123456789abc' }, host);
    expect(queries.map((q) => q.options.resume)).toEqual([
      '5c1f0e7a-1b2c-4d3e-8f90-123456789abc',
      undefined,
    ]);
    expect(queries[0]?.close).toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'notice')).toEqual([]);
    expect(events[0]?.type).toBe('started');
  });

  it('says why it could not start, with what the CLI said', async () => {
    const { sdk, host } = connector({
      prepare: (query) => {
        query.options.stderr?.('Error: Invalid API key\n');
        query.initialization = Promise.reject(new Error('Claude Code process exited with code 1'));
      },
    });
    await expect(sdk.start(SPEC, host)).rejects.toThrow(
      'Claude Code process exited with code 1: Error: Invalid API key',
    );
  });

  it('says when its CLI stops by itself, and closes when asked', async () => {
    const crashed = connector();
    await crashed.sdk.start(SPEC, crashed.host);
    crashed.query().finish(new Error('Claude Code process exited with code 1'));
    await settle();
    expect(crashed.events.at(-1)).toEqual({
      type: 'closed',
      error: 'Claude Code process exited with code 1',
    });

    const asked = connector();
    const session = await asked.sdk.start(SPEC, asked.host);
    await session.close();
    expect(asked.query().close).toHaveBeenCalled();
    expect(asked.events.filter((event) => event.type === 'closed')).toEqual([]);
  });
});
