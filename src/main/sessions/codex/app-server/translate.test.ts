import { describe, expect, it } from 'vitest';

import type { SessionEvent } from '../../../../shared/session';
import type { UsageWindows } from '../../../../shared/usage';
import { property } from '../../transcript';
import { RECORDED_PLACES, recordedNotifications, recordedResult } from './recorded';
import type { Fixture } from './recorded';
import { OUTPUT_EVERY_MS, Translator, commandLine, historyEvents, unwrapShell } from './translate';

const THREAD = '01a1344c-68e9-7bf2-a777-b062d871bb26';

/** A translator of the recorded thread, its notifications played through it. */
function play(notifications: { method: string; params: unknown }[], at = () => 0, thread = THREAD) {
  const translator = new Translator({ places: RECORDED_PLACES, now: at });
  translator.thread = thread;
  const events = notifications.flatMap(({ method, params }) =>
    translator.notification(method, params),
  );
  return { translator, events };
}

/** Each entry's text, streamed together, by id. */
function texts(events: SessionEvent[], type: 'text' | 'thinking' = 'text'): Record<string, string> {
  const joined: Record<string, string> = {};
  for (const event of events) {
    if (event.type === type) joined[event.id] = (joined[event.id] ?? '') + event.text;
  }
  return joined;
}

/** The last of each tool entry, by id. */
function tools(events: SessionEvent[]) {
  const last = new Map<string, Extract<SessionEvent, { type: 'tool' }>>();
  for (const event of events) if (event.type === 'tool') last.set(event.id, event);
  return [...last.values()];
}

/** A notification about an item of the thread, in its turn. */
const about = (params: Record<string, unknown>) => ({ threadId: THREAD, turnId: 't1', ...params });

describe('the App Server translator, on what Codex did', () => {
  it('uses the reported window and last request, with a lower native compaction limit', () => {
    const { translator } = play([]);
    translator.setConfig({ config: { model_auto_compact_token_limit: 400_000 } });
    const update = (used: number) =>
      translator.notification(
        'thread/tokenUsage/updated',
        about({
          tokenUsage: {
            total: { totalTokens: 900_000 },
            last: { totalTokens: used },
            modelContextWindow: 475_000,
          },
        }),
      );
    expect(update(430_000)).toMatchObject([
      { type: 'usage', usage: { context: { used: 430_000, window: 475_000, compactAt: 400_000 } } },
    ]);
    translator.setConfig({ config: { model_auto_compact_token_limit: 600_000 } });
    expect(update(431_000)).toMatchObject([
      { type: 'usage', usage: { context: { used: 431_000, window: 475_000, compactAt: 450_000 } } },
    ]);
  });

  it.each([null, -1, 1.5, NaN, Infinity])(
    'does not retain context after an invalid window %s',
    (window) => {
      const { translator } = play([]);
      const update = (modelContextWindow: unknown) =>
        translator.notification(
          'thread/tokenUsage/updated',
          about({ tokenUsage: { last: { totalTokens: 1 }, modelContextWindow } }),
        );
      expect(update(475_000)).toMatchObject([
        { type: 'usage', usage: { context: { used: 1, window: 475_000, compactAt: 450_000 } } },
      ]);
      expect(update(window)).toMatchObject([{ type: 'usage', usage: { context: null } }]);
    },
  );
  it('reports a typed terminal failure while leaving individual command errors within the turn', () => {
    const { translator } = play([]);
    translator.notification(
      'error',
      about({
        error: { message: 'Sign in again', codexErrorInfo: 'unauthorized' },
        willRetry: false,
      }),
    );
    expect(translator.takeResult({ status: 'failed' })).toMatchObject({
      status: 'failed',
      reason: 'auth',
      message: expect.stringContaining('Sign in again') as string,
    });
    translator.notification(
      'item/completed',
      about({
        item: {
          id: 'bad-test',
          type: 'commandExecution',
          command: 'false',
          status: 'failed',
          exitCode: 1,
        },
      }),
    );
    expect(translator.takeResult({ status: 'completed' })).toEqual({
      status: 'completed',
      reason: 'completed',
    });
    expect(translator.takeResult({ status: 'interrupted' })).toEqual({
      status: 'cancelled',
      reason: 'interrupted',
    });
  });

  it('streams replies, and shows each command it ran with its output', () => {
    const { events } = play(recordedNotifications('turns'));
    expect(Object.values(texts(events))).toEqual([
      '`ls` shows `notes.md`. The workspace is read-only, so I’ll request write access to create `hello.txt`.',
      'Created `hello.txt` containing `hi`.',
      'I’ll record the two steps, then append `bye` to the file.',
      'Appended `bye` to `hello.txt`. I couldn’t use `update_plan`; it isn’t available here.',
    ]);
    // The commands as the user's shell ran them, unwrapped, as Codex shows them.
    expect(
      tools(events).map(({ tool, summary, status, detail }) => ({ tool, summary, status, detail })),
    ).toEqual([
      {
        tool: 'exec_command',
        summary: 'ls',
        status: 'done',
        detail: { kind: 'output', text: 'notes.md\n' },
      },
      { tool: 'exec_command', summary: "printf 'hi' > hello.txt", status: 'done' },
      { tool: 'exec_command', summary: "printf 'bye\\n' >> hello.txt", status: 'done' },
    ]);
  });

  it('says how full the context is, and how much of the plan’s limits is used', () => {
    const { events } = play(recordedNotifications('turns'));
    const usage = events.filter((event) => event.type === 'usage').at(-1);
    expect(usage).toEqual({
      type: 'usage',
      usage: {
        costUsd: null,
        context: { used: expect.any(Number) as number, window: 258_400, compactAt: 244_800 },
        contextTokens: expect.any(Number) as number,
        contextWindow: 258_400,
        limits: [
          { name: '5h', usedPercent: 0, resetsAt: 1_791_896_790_000 },
          { name: 'weekly', usedPercent: 0, resetsAt: 1_792_483_590_000 },
        ],
      },
    });
  });

  it('passes the plan’s limits it shows on to the usage readings, as windows', () => {
    const readings: UsageWindows[] = [];
    const translator = new Translator({
      places: RECORDED_PLACES,
      now: () => 1_791_880_000_000,
      usage: (windows) => readings.push(windows),
    });
    translator.thread = THREAD;
    for (const { method, params } of recordedNotifications('turns')) {
      translator.notification(method, params);
    }
    expect(readings).toHaveLength(
      recordedNotifications('turns').filter(({ method }) => method === 'account/rateLimits/updated')
        .length,
    );
    expect(readings.at(-1)).toEqual({
      fiveHour: { usedPercent: 0, resetsAt: 1_791_896_790_000 },
      weekly: { usedPercent: 0, resetsAt: 1_792_483_590_000 },
    });
    // What read says at the start goes there too; another limit (a model's) does not.
    translator.setLimits({
      limitId: 'codex',
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_791_896_790 },
    });
    translator.setLimits({ limitId: 'gpt-6-sol', primary: { usedPercent: 99 } });
    expect(readings.at(-1)).toEqual({
      fiveHour: { usedPercent: 12, resetsAt: 1_791_896_790_000 },
    });
  });

  it('tells usage only when it changed (Codex reports it with each request, and limits after)', () => {
    const { events } = play(
      recordedNotifications('patch'),
      () => 0,
      '01a1348d-2ce8-78b1-9629-fd1c7f6a8e4b',
    );
    const told = events.filter((event) => event.type === 'usage');
    expect(told.map((event) => JSON.stringify(event))).toEqual([
      ...new Set(told.map((event) => JSON.stringify(event))),
    ]);
    expect(told.length).toBeGreaterThan(1);
  });

  it('keeps plan mode’s plan for the session to ask about, rather than showing it', () => {
    const { translator, events } = play(recordedNotifications('turns'));
    expect(events.some((event) => event.type === 'text' && event.text.includes('# Rename'))).toBe(
      false,
    );
    expect(translator.takePlan()).toEqual({
      id: '01a1344c-b7e2-76c3-b75f-829371368e2d-plan',
      text: '# Rename `hello.txt`\n\n## Steps\n\n1. Rename `hello.txt` to `greeting.txt` in the workspace.\n2. Confirm `greeting.txt` exists and `hello.txt` no longer does.\n',
    });
    // Asked once.
    expect(translator.takePlan()).toBeUndefined();
  });

  it('replays a thread’s history as the turns it was, with the same entry ids', () => {
    const read = recordedResult('turns', 'thread/read');
    const turns = property(property(read, 'thread'), 'turns') as unknown[];
    const events = historyEvents(turns, RECORDED_PLACES);
    expect(events.filter((event) => event.type === 'user').map((event) => event.text)).toEqual([
      'Run ls, then create hello.txt containing the word hi. Be brief.',
      'Use update_plan with two short steps, then append a line saying bye to hello.txt. Be brief.',
      'Plan how to rename hello.txt to greeting.txt. Two steps at most.',
    ]);
    expect(events.filter((event) => event.type === 'end')).toEqual([
      {
        type: 'end',
        messages: ['01a1344c-73e4-7b23-b95b-33e074ac24e2'],
        seconds: 11,
        result: { status: 'completed', reason: 'completed' },
      },
      {
        type: 'end',
        messages: ['01a1344c-985c-7e92-b648-b6b52e979f74'],
        seconds: 8,
        result: { status: 'completed', reason: 'completed' },
      },
      {
        type: 'end',
        messages: ['01a1344c-b7fa-74f2-a6c5-43a43837428c'],
        seconds: 3,
        result: { status: 'completed', reason: 'completed' },
      },
    ]);
    const live = play(recordedNotifications('turns')).events;
    const liveIds = new Set(live.flatMap((event) => ('id' in event ? [event.id] : [])));
    // The replies and commands are the entries shown live (live, the plan was a prompt).
    for (const event of events) {
      if ((event.type === 'text' || event.type === 'tool') && !event.id.endsWith('-plan')) {
        expect(liveIds.has(event.id)).toBe(true);
      }
    }
    // In history, a proposed plan reads as text.
    expect(Object.values(texts(events)).at(-1)).toMatch(/^# Rename `hello.txt`/);
  });
});

describe('the App Server translator, on the shapes Codex declares', () => {
  it('streams reasoning summaries, a paragraph per part', () => {
    const { events } = play([
      {
        method: 'item/started',
        params: about({ item: { type: 'reasoning', id: 'rs_1', summary: [], content: [] } }),
      },
      {
        method: 'item/reasoning/summaryTextDelta',
        params: about({ itemId: 'rs_1', delta: '**Looking**', summaryIndex: 0 }),
      },
      {
        method: 'item/reasoning/summaryPartAdded',
        params: about({ itemId: 'rs_1', summaryIndex: 1 }),
      },
      {
        method: 'item/reasoning/summaryTextDelta',
        params: about({ itemId: 'rs_1', delta: 'Then ', summaryIndex: 1 }),
      },
      {
        method: 'item/completed',
        params: about({
          item: {
            type: 'reasoning',
            id: 'rs_1',
            summary: ['**Looking**', 'Then this.'],
            content: [],
          },
        }),
      },
    ]);
    expect(texts(events, 'thinking')).toEqual({ rs_1: '**Looking**\n\nThen this.' });
  });

  it('shows a patch as an entry per file, with its diff', () => {
    const change = {
      type: 'fileChange',
      id: 'call_1',
      status: 'inProgress',
      changes: [
        { path: '/work/smoke/p1/hello.txt', kind: { type: 'add' }, diff: 'hi\nthere\n' },
        {
          path: '/work/smoke/p1/notes.md',
          kind: { type: 'update', move_path: null },
          diff: '@@ -1,2 +1,2 @@\n # Notes\n-old\n+new\n',
        },
      ],
    };
    const { translator, events } = play([
      { method: 'item/started', params: about({ item: change }) },
      { method: 'item/completed', params: about({ item: { ...change, status: 'completed' } }) },
    ]);
    expect(tools(events)).toEqual([
      {
        type: 'tool',
        id: 'call_1:0',
        tool: 'apply_patch',
        summary: 'hello.txt',
        status: 'done',
        detail: {
          kind: 'diff',
          added: 2,
          removed: 0,
          lines: [
            { kind: 'add', text: 'hi' },
            { kind: 'add', text: 'there' },
          ],
        },
      },
      {
        type: 'tool',
        id: 'call_1:1',
        tool: 'apply_patch',
        summary: 'notes.md',
        status: 'done',
        detail: {
          kind: 'diff',
          added: 1,
          removed: 1,
          lines: [
            { kind: 'same', text: '# Notes' },
            { kind: 'remove', text: 'old' },
            { kind: 'add', text: 'new' },
          ],
        },
      },
    ]);
    // Its approval prompt shows both files.
    expect(translator.patch('call_1')?.summary).toBe('hello.txt, notes.md');
  });

  it('streams a command’s output while it runs, a few times a second', () => {
    let now = 1000;
    const translator = new Translator({ places: RECORDED_PLACES, now: () => now });
    translator.thread = THREAD;
    const command = {
      type: 'commandExecution',
      id: 'exec-1',
      command: '/bin/zsh -lc "npm test"',
      status: 'inProgress',
      aggregatedOutput: null,
      exitCode: null,
    };
    const say = (method: string, params: Record<string, unknown>) =>
      translator.notification(method, about(params));
    expect(say('item/started', { item: command })).toMatchObject([
      { type: 'tool', summary: 'npm test', status: 'running' },
    ]);
    expect(
      say('item/commandExecution/outputDelta', { itemId: 'exec-1', delta: 'one\n' }),
    ).toMatchObject([{ detail: { kind: 'output', text: 'one\n' } }]);
    now += 10;
    expect(say('item/commandExecution/outputDelta', { itemId: 'exec-1', delta: 'two\n' })).toEqual(
      [],
    );
    expect(translator.pendingOutput).toBe(true);
    now += OUTPUT_EVERY_MS;
    expect(translator.flush()).toMatchObject([{ detail: { kind: 'output', text: 'one\ntwo\n' } }]);
    expect(
      say('item/completed', {
        item: { ...command, status: 'failed', aggregatedOutput: 'one\ntwo\nFAIL\n', exitCode: 1 },
      }),
    ).toMatchObject([{ status: 'failed', detail: { kind: 'output', text: 'one\ntwo\nFAIL\n' } }]);
    expect(translator.pendingOutput).toBe(false);
  });

  it('shows web searches, MCP tool calls and subagents, nesting a subagent’s work under its spawn', () => {
    const { events } = play([
      {
        method: 'item/completed',
        params: about({
          item: {
            type: 'webSearch',
            id: 'ws_1',
            query: '',
            action: { type: 'search', query: 'codex app server' },
            results: null,
          },
        }),
      },
      {
        method: 'item/completed',
        params: about({
          item: {
            type: 'mcpToolCall',
            id: 'mcp_1',
            server: 'docs',
            tool: 'search',
            status: 'completed',
            arguments: { query: 'sandbox' },
            result: { content: [{ type: 'text', text: 'Found 2 pages' }], structuredContent: null },
            error: null,
          },
        }),
      },
      {
        method: 'item/started',
        params: about({
          item: {
            type: 'collabAgentToolCall',
            id: 'spawn_1',
            tool: 'spawnAgent',
            status: 'inProgress',
            senderThreadId: THREAD,
            receiverThreadIds: ['child-1'],
            prompt: 'Read the README\nand sum it up',
            agentsStates: {},
          },
        }),
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'child-1',
          turnId: 'c1',
          item: {
            type: 'agentMessage',
            id: 'msg_child',
            text: 'It is a shop.',
            phase: 'final_answer',
          },
        },
      },
    ]);
    expect(tools(events).map(({ tool, summary, status }) => [tool, summary, status])).toEqual([
      ['web_search', 'codex app server', 'done'],
      ['mcp__docs__search', 'sandbox', 'done'],
      ['spawn_agent', 'Read the README …', 'running'],
    ]);
    expect(events).toContainEqual({
      type: 'text',
      id: 'msg_child',
      text: 'It is a shop.',
      parent: 'spawn_1',
    });
  });

  it('keeps update_plan’s plan as the turn’s to-do list', () => {
    const { events } = play([
      {
        method: 'turn/plan/updated',
        params: about({
          explanation: null,
          plan: [
            { step: 'Read the code', status: 'completed' },
            { step: 'Change it', status: 'inProgress' },
            { step: 'Test it', status: 'pending' },
          ],
        }),
      },
    ]);
    expect(events).toEqual([
      {
        type: 'todos',
        id: 'plan:t1',
        items: [
          { text: 'Read the code', status: 'done' },
          { text: 'Change it', status: 'active' },
          { text: 'Test it', status: 'pending' },
        ],
      },
    ]);
  });

  it('says what went wrong, with what to do: a login refused, a usage limit and when it resets', () => {
    const translator = new Translator({ places: RECORDED_PLACES });
    translator.thread = THREAD;
    translator.setLimits({
      limitId: 'codex',
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_791_896_790 },
      secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_792_483_590 },
    });
    const failed = (codexErrorInfo: unknown, message: string, willRetry = false) =>
      translator.notification(
        'error',
        about({ error: { message, codexErrorInfo, additionalDetails: null }, willRetry }),
      );
    expect(failed('unauthorized', 'Your access token could not be refreshed.')).toMatchObject([
      {
        type: 'notice',
        level: 'error',
        text: expect.stringMatching(/refreshed\. .*codex login --with-api-key/) as string,
      },
    ]);
    expect(failed('usageLimitExceeded', 'You’ve hit your usage limit.')).toMatchObject([
      {
        level: 'error',
        text: expect.stringMatching(/usage limit\. · resets \w{3} \d+, /) as string,
      },
    ]);
    expect(translator.takeResult({ status: 'failed' })).toMatchObject({
      status: 'failed',
      reason: 'usage-limit',
      resetsAt: 1_791_896_790_000,
    });
    expect(
      failed({ responseStreamDisconnected: { httpStatusCode: 502 } }, 'stream disconnected', true),
    ).toMatchObject([{ level: 'warning', text: 'stream disconnected Codex is retrying.' }]);
    // The turn's failure was told by its error: not again when it ends.
    expect(translator.endTurn({ status: 'failed', error: { message: 'boom' } })).toEqual([]);
    expect(translator.endTurn({ status: 'failed', error: { message: 'boom' } })).toMatchObject([
      { type: 'notice', level: 'error', text: 'boom' },
    ]);
  });

  it('marks compaction and reviews, once each', () => {
    const compaction = { type: 'contextCompaction', id: 'cc_1' };
    const { events } = play([
      { method: 'item/started', params: about({ item: compaction }) },
      { method: 'item/completed', params: about({ item: compaction }) },
      { method: 'item/completed', params: about({ item: compaction }) },
      {
        method: 'item/completed',
        params: about({ item: { type: 'enteredReviewMode', id: 'r1', review: 'current changes' } }),
      },
      {
        method: 'item/completed',
        params: about({ item: { type: 'exitedReviewMode', id: 'r2', review: 'No issues found.' } }),
      },
    ]);
    expect(events).toEqual([
      { type: 'notice', id: 'cc_1', level: 'info', text: 'Context compacted' },
      { type: 'notice', id: 'r1', level: 'info', text: 'Code review started: current changes' },
      { type: 'text', id: 'r2', text: 'No issues found.' },
    ]);
  });

  it('tells an MCP server that failed to start, once', () => {
    const failed = {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: THREAD,
        name: 'docs',
        status: 'failed',
        error: 'spawn npx ENOENT',
        failureReason: null,
      },
    };
    const { events } = play([failed, failed]);
    expect(events).toMatchObject([
      {
        type: 'notice',
        level: 'warning',
        text: 'The MCP server docs failed to start: spawn npx ENOENT',
      },
    ]);
  });
});

describe('commands as Codex shows them', () => {
  it('unwraps the shell Codex runs them in', () => {
    expect(unwrapShell('/bin/zsh -lc ls')).toBe('ls');
    expect(unwrapShell(`/bin/zsh -lc "printf 'bye\\\\n' >> hello.txt"`)).toBe(
      "printf 'bye\\n' >> hello.txt",
    );
    expect(unwrapShell("bash -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'");
    expect(unwrapShell('npm test')).toBe('npm test');
  });

  it('writes an exec policy’s prefix as a command line', () => {
    expect(commandLine(['/bin/zsh', '-lc', "printf 'hi' > hello.txt"])).toBe(
      "printf 'hi' > hello.txt",
    );
    expect(commandLine(['npm', 'run', 'build:prod'])).toBe('npm run build:prod');
    expect(commandLine(['git', 'commit', '-m', 'a b'])).toBe("git commit -m 'a b'");
  });
});

/**
 * What a real compaction recording makes the translator say: each usage event's context and
 * cumulative-count-free reading, and the notices, in order, with the compaction's start marked.
 */
function playCompaction(name: Extract<Fixture, 'compact-default' | 'compact-limit'>) {
  const threadId = property(
    property(recordedResult(name, 'thread/start'), 'thread'),
    'id',
  ) as string;
  const translator = new Translator({ places: RECORDED_PLACES });
  translator.thread = threadId;
  translator.setConfig(recordedResult(name, 'config/read'));
  const told: (
    { context: unknown; contextTokens: unknown } | { note: string } | { started: true }
  )[] = [];
  for (const { method, params } of recordedNotifications(name)) {
    if (
      method === 'item/started' &&
      property(property(params, 'item'), 'type') === 'contextCompaction'
    )
      told.push({ started: true });
    for (const event of translator.notification(method, params)) {
      if (event.type === 'usage')
        told.push({ context: event.usage.context, contextTokens: event.usage.contextTokens });
      if (event.type === 'notice') told.push({ note: event.text });
    }
  }
  return told;
}

describe('the App Server translator, through real automatic compactions (Codex 0.162.1, B11a C4)', () => {
  const window = 47_500;

  it('reports the last request, never the running total, against the usable window', () => {
    const told = playCompaction('compact-default');
    const contexts = told.flatMap((t) => ('context' in t ? [t.context] : []));
    expect(contexts[0]).toEqual({ used: 24_060, window, compactAt: 45_000 });
    // The session had spent over 250,000 tokens in all by then: not what fills its context.
    expect(contexts).toContainEqual({ used: 42_934, window, compactAt: 45_000 });
    for (const t of told) if ('context' in t) expect(t.contextTokens).toBeLessThan(window + 10_000);
  });

  it('puts compaction at 90% of the raw window, which is 45,000 of this 50,000', () => {
    // The recording's model window was 50,000 (so its usable window 47,500 = 95%): Codex
    // compacted after a request of 42,934 tokens (its next request would have held that and
    // the output of the command it had just asked for, up to 2,500 tokens), and not after the
    // 42,861 before it. floor(47,500 × 90 / 95) is 45,000.
    expect(Math.floor((window * 90) / 95)).toBe(45_000);
    const told = playCompaction('compact-default');
    const at = told.findIndex((t) => 'started' in t);
    expect(told[at - 1]).toMatchObject({ context: { used: 42_934, compactAt: 45_000 } });
    expect(told[at - 2]).toMatchObject({ context: { used: 42_861, compactAt: 45_000 } });
  });

  it('reports what the compaction left, then says it compacted', () => {
    const told = playCompaction('compact-default');
    const at = told.findIndex((t) => 'started' in t);
    expect(told[at + 1]).toMatchObject({ context: { used: 19_554, window, compactAt: 45_000 } });
    expect(told[at + 2]).toEqual({ note: 'Context compacted' });
    expect(told[at + 3]).toMatchObject({ context: { used: 33_083, window, compactAt: 45_000 } });
  });

  it('lowers the compaction point to the configured limit, the limit config/read reports', () => {
    expect(
      property(
        property(recordedResult('compact-limit', 'config/read'), 'config'),
        'model_auto_compact_token_limit',
      ),
    ).toBe(40_000);
    expect(
      property(
        property(recordedResult('compact-default', 'config/read'), 'config'),
        'model_auto_compact_token_limit',
      ),
    ).toBeNull();
    const told = playCompaction('compact-limit');
    const contexts = told.flatMap((t) => ('context' in t ? [t.context] : []));
    expect(contexts.slice(0, 3)).toEqual([
      { used: 24_060, window, compactAt: 40_000 },
      { used: 34_052, window, compactAt: 40_000 },
      { used: 42_915, window, compactAt: 40_000 },
    ]);
    // It compacted as the next turn began, past the limit, and not at 34,052.
    const at = told.findIndex((t) => 'started' in t);
    expect(told[at - 1]).toMatchObject({ context: { used: 42_915 } });
    expect(told[at + 1]).toMatchObject({ context: { used: 25_632, window, compactAt: 40_000 } });
    expect(told[at + 2]).toEqual({ note: 'Context compacted' });
  });
});
