import type { ModelInfo, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import type { SessionEvent } from '../../../shared/session';
import { RECORDED_PLACES, recorded, recordedMessages } from './recorded';
import type { Fixture } from './recorded';
import { Translator } from './translate';

/** A fixed way to say when a limit resets, so the tests read the same everywhere. */
const formatReset = (at: number, window?: string) => `${String(at)}/${window ?? ''}`;

function translator(options: { history?: boolean } = {}) {
  const translate = new Translator({ places: RECORDED_PLACES, formatReset, ...options });
  translate.setMode('manual');
  return translate;
}

/** Every event a recorded session's messages make, in order. */
function play(fixture: Fixture, translate = translator()): SessionEvent[] {
  const init = recorded(fixture).find((item) => item.kind === 'initializationResult');
  if (init) translate.setModels(init.data.models as ModelInfo[], 'haiku');
  return recordedMessages(fixture).flatMap((message) => translate.translate(message));
}

const ofType = <T extends SessionEvent['type']>(events: SessionEvent[], type: T) =>
  events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type);

/** A tool call's events, by the tool and what it acted on. */
function calls(events: SessionEvent[], tool: string) {
  return ofType(events, 'tool').filter((event) => event.tool === tool);
}

/** All the text streamed into each entry, by id, in the order they began. */
function texts(events: SessionEvent[], type: 'text' | 'thinking'): Map<string, string> {
  const joined = new Map<string, string>();
  for (const event of ofType(events, type)) {
    joined.set(event.id, (joined.get(event.id) ?? '') + event.text);
  }
  return joined;
}

describe('Translator, on what the real Claude Code did', () => {
  it('shows each tool call running, then done, with what it acted on and its result', () => {
    const events = play('tools-and-compact');

    const bash = calls(events, 'Bash');
    expect(bash.map((call) => call.status)).toEqual(['running', 'done']);
    expect(bash.at(-1)).toMatchObject({
      summary: 'echo hello',
      detail: { kind: 'output', text: 'hello' },
    });

    // A new file is all added; an edit removes and adds lines; paths are the project's.
    expect(calls(events, 'Write').at(-1)).toMatchObject({
      summary: 'notes.txt',
      status: 'done',
      detail: { kind: 'diff', added: 1, removed: 0, lines: [{ kind: 'add', text: 'one' }] },
    });
    expect(calls(events, 'Edit').at(-1)).toMatchObject({
      summary: 'notes.txt',
      status: 'done',
      detail: {
        kind: 'diff',
        added: 1,
        removed: 1,
        lines: [
          { kind: 'remove', text: 'one' },
          { kind: 'add', text: 'two' },
        ],
      },
    });
  });

  it('streams the reply, without repeating it when its complete block arrives', () => {
    const events = play('tools-and-compact');
    expect([...texts(events, 'text').values()]).toEqual([
      'Done. `echo hello` printed `hello`. `notes.txt` was created with `one`, then edited to `two`.',
    ]);
    // Its thinking was not shown (the CLI omitted it): no empty thinking entry.
    expect(ofType(events, 'thinking')).toEqual([]);
  });

  it('streams thinking when the CLI summarizes it', () => {
    const thinking = [...texts(play('question-and-plan'), 'thinking').values()];
    expect(thinking[0]).toMatch(/^Since I'm in plan mode/);
  });

  it('follows the mode the CLI reports, saying only what changed', () => {
    // Answering "always" to an edit switched it to accept edits.
    expect(ofType(play('tools-and-compact'), 'mode').map((e) => e.mode)).toEqual(['acceptEdits']);

    // Plan mode: approved, the CLI goes back to Manual, then to the mode chosen.
    const plan = translator();
    plan.setMode('plan');
    expect(ofType(play('question-and-plan', plan), 'mode').map((e) => e.mode)).toEqual([
      'manual',
      'acceptEdits',
    ]);
  });

  it('reports what the session cost and how full its context is, after each turn', () => {
    const usage = ofType(play('tools-and-compact'), 'usage');
    expect(usage.at(0)?.usage).toEqual({
      costUsd: 0.006818879999999999,
      // The last reply's input, cache and output tokens.
      contextTokens: 2 + 316 + 39709 + 8,
      contextWindow: 1_000_000,
    });
    // Compacting leaves less in context.
    expect(usage.at(-1)?.usage).toMatchObject({ costUsd: 0.007957245, contextTokens: 9021 });
  });

  it('says when the conversation was compacted, once', () => {
    const notices = ofType(play('tools-and-compact'), 'notice').map((n) => n.text);
    expect(notices.filter((said) => /compact/i.test(said))).toEqual([
      'Compacted the conversation: 40,067 → 9,021 tokens.',
    ]);
  });

  it('warns once when a usage limit is near, saying when it resets', () => {
    const warnings = ofType(play('tools-and-compact'), 'notice').filter(
      (n) => n.level === 'warning',
    );
    expect(warnings.map((n) => n.text)).toEqual([
      "You've used 78% of your weekly limit · resets 1792242000/seven_day",
    ]);
  });

  it('shows prompts’ tools only as their prompts, live; the plan file it wrote as a tool call', () => {
    const events = play('question-and-plan');
    expect(calls(events, 'AskUserQuestion')).toEqual([]);
    expect(calls(events, 'ExitPlanMode')).toEqual([]);
    expect(calls(events, 'Write').map((call) => call.summary)).toContain(
      '~/.claude/plans/first-use-the-askuserquestion-validated-sunset.md',
    );
    expect(calls(events, 'Write').at(-1)).toMatchObject({ summary: 'a.txt', status: 'done' });
  });

  it('nests a subagent’s work under its Agent call, and shows its report', () => {
    const events = play('subagent-and-interrupt');
    const agent = calls(events, 'Agent');
    const id = agent[0]?.id;
    expect(agent[0]).toMatchObject({ summary: 'Read README.md first line', status: 'running' });
    expect(agent.at(-1)).toMatchObject({
      status: 'done',
      detail: { kind: 'output', text: 'Corral the agents' },
    });

    // The subagent's own tool call and reply sit under it.
    expect(calls(events, 'Read').at(-1)).toMatchObject({
      summary: 'README.md',
      status: 'done',
      parent: id,
    });
    const nested = ofType(events, 'text').filter((event) => event.parent === id);
    expect(nested.map((event) => event.text)).toEqual(['Corral the agents']);
    // The main thread's reply is not nested.
    const replies = ofType(events, 'text').filter((event) => event.parent === undefined);
    expect([...texts(replies, 'text').values()][0]).toBe('Corral the agents');
  });

  it('keeps the whole of a reply cut short by an interrupt, and calls it no error', () => {
    const events = play('subagent-and-interrupt');
    const story = [...texts(events, 'text').values()].at(-1) ?? '';
    expect(story).toMatch(/^The Fox Who Counted Stars\n\nEmber was a red fox/);
    expect(ofType(events, 'notice').filter((n) => n.level === 'error')).toEqual([]);
  });

  it('reports the model the CLI says it runs, by the picker’s name for it', () => {
    const translate = translator();
    const init = recorded('tools-and-compact').find((item) => item.kind === 'initializationResult');
    translate.setModels((init?.data.models ?? []) as ModelInfo[], null);
    const message = recordedMessages('tools-and-compact').find(
      (m) => m.type === 'system' && m.subtype === 'init',
    );
    if (!message) throw new Error('no init');
    // Started with the default (Opus), it runs Haiku: the picker shows Haiku.
    expect(ofType(translate.translate(message), 'model')).toEqual([
      { type: 'model', model: 'haiku' },
    ]);
    // Said again, it is not news.
    expect(ofType(translate.translate(message), 'model')).toEqual([]);
  });
});

/** A message as the SDK types it, from the parts a test sets. */
const sdk = (message: object) => message as SDKMessage;

const assistantError = (error: string, said: string) =>
  sdk({
    type: 'assistant',
    message: {
      id: 'msg_error',
      type: 'message',
      role: 'assistant',
      model: '<synthetic>',
      content: [{ type: 'text', text: said }],
      stop_reason: 'stop_sequence',
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    error,
    parent_tool_use_id: null,
    uuid: '00000000-0000-4000-8000-000000000001',
    session_id: 's',
  });

const failedResult = sdk({
  type: 'result',
  subtype: 'success',
  is_error: true,
  result: 'API Error',
  total_cost_usd: 0,
  modelUsage: {},
  duration_ms: 10,
  errors: [],
});

describe('Translator, on errors', () => {
  it('says a usage limit was hit, and when it resets', () => {
    const translate = translator();
    translate.translate(
      sdk({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 1791875400, rateLimitType: 'five_hour' },
      }),
    );
    const events = [
      ...translate.translate(assistantError('rate_limit', "You've hit your session limit")),
      ...translate.translate(failedResult),
    ];
    expect(ofType(events, 'notice').map((n) => [n.level, n.text])).toEqual([
      ['error', "You've hit your session limit · resets 1791875400/five_hour"],
    ]);
  });

  it('keeps the reset time Claude Code already gave', () => {
    const events = translator().translate(
      assistantError('rate_limit', "You've hit your session limit · resets 3:45pm"),
    );
    expect(ofType(events, 'notice').map((n) => n.text)).toEqual([
      "You've hit your session limit · resets 3:45pm",
    ]);
  });

  it('says how to log in when Claude Code is not logged in', () => {
    const events = translator().translate(
      assistantError('authentication_failed', 'Not logged in · Please run /login'),
    );
    const [said] = ofType(events, 'notice');
    expect(said?.level).toBe('error');
    expect(said?.text).toMatch(/^Not logged in · Please run \/login /);
    expect(said?.text).toMatch(/run `claude` in a terminal and log in there/);
    // Not also as a reply.
    expect(ofType(events, 'text')).toEqual([]);
  });

  it('says why a turn failed, unless it was interrupted', () => {
    const failed = (terminal: string) =>
      sdk({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['[ede_diagnostic] result_type=user', 'Claude Code crashed'],
        terminal_reason: terminal,
        total_cost_usd: 0,
        modelUsage: {},
      });
    expect(ofType(translator().translate(failed('api_error')), 'notice')[0]?.text).toBe(
      'The turn failed: Claude Code crashed',
    );
    expect(ofType(translator().translate(failed('aborted_tools')), 'notice')).toEqual([]);
  });
});

/** An assistant message delivering one tool call, as the CLI sends it. */
const toolUse = (id: string, name: string, input: object, parent: string | null = null) =>
  sdk({
    type: 'assistant',
    message: {
      id: `msg_${id}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input }],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: parent,
    uuid: '00000000-0000-4000-8000-000000000002',
    session_id: 's',
  });

/** The CLI's message carrying a tool call's result. */
const toolResult = (id: string, content: string, result?: object, isError = false) =>
  sdk({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    },
    parent_tool_use_id: null,
    tool_use_result: result,
    session_id: 's',
  });

describe('Translator, on to-dos and background work', () => {
  it('shows TodoWrite’s list as a to-do list, not a tool call', () => {
    const events = translator().translate(
      toolUse('toolu_todo', 'TodoWrite', {
        todos: [
          { content: 'Read the code', status: 'completed', activeForm: 'Reading' },
          { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing' },
          { content: 'Run the tests', status: 'pending', activeForm: 'Running' },
        ],
      }),
    );
    expect(events).toEqual([
      {
        type: 'todos',
        id: 'toolu_todo',
        items: [
          { text: 'Read the code', status: 'done' },
          { text: 'Fix the bug', status: 'active' },
          { text: 'Run the tests', status: 'pending' },
        ],
      },
    ]);
  });

  it('keeps the task tools’ list as tasks are created and updated', () => {
    const translate = translator();
    translate.translate(toolUse('toolu_c1', 'TaskCreate', { subject: 'Read the code' }));
    translate.translate(
      toolResult('toolu_c1', 'Task #1 created', { task: { id: '1', subject: 'Read the code' } }),
    );
    translate.translate(toolUse('toolu_c2', 'TaskCreate', { subject: 'Fix the bug' }));
    const created = translate.translate(
      toolResult('toolu_c2', 'Task #2 created', { task: { id: '2', subject: 'Fix the bug' } }),
    );
    expect(created).toEqual([
      {
        type: 'todos',
        id: 'toolu_c2',
        items: [
          { text: 'Read the code', status: 'pending' },
          { text: 'Fix the bug', status: 'pending' },
        ],
      },
    ]);
    translate.translate(toolUse('toolu_u1', 'TaskUpdate', { taskId: '1', status: 'completed' }));
    const updated = translate.translate(toolResult('toolu_u1', 'Updated task #1'));
    expect(updated).toMatchObject([
      {
        type: 'todos',
        items: [
          { text: 'Read the code', status: 'done' },
          { text: 'Fix the bug', status: 'pending' },
        ],
      },
    ]);
  });

  it('keeps a background subagent running until its task ends', () => {
    const translate = translator();
    translate.translate(
      toolUse('toolu_bg', 'Agent', { description: 'Survey the code', prompt: 'Go' }),
    );
    translate.translate(
      sdk({
        type: 'system',
        subtype: 'task_started',
        task_id: 't1',
        tool_use_id: 'toolu_bg',
        description: 'Survey the code',
        is_backgrounded: true,
      }),
    );
    expect(
      translate.translate(toolResult('toolu_bg', 'Async agent launched successfully.')),
    ).toMatchObject([{ type: 'tool', id: 'toolu_bg', status: 'running' }]);
    expect(
      translate.translate(
        sdk({
          type: 'system',
          subtype: 'task_notification',
          task_id: 't1',
          tool_use_id: 'toolu_bg',
          status: 'completed',
          output_file: '/tmp/out',
          summary: 'Found three modules',
        }),
      ),
    ).toEqual([
      {
        type: 'tool',
        id: 'toolu_bg',
        tool: 'Agent',
        summary: 'Survey the code',
        status: 'done',
        detail: { kind: 'output', text: 'Found three modules' },
      },
    ]);
  });

  it('shows a tool call that failed, with what went wrong', () => {
    const translate = translator();
    translate.translate(toolUse('toolu_rm', 'Bash', { command: 'rm -rf build' }));
    expect(
      translate.translate(toolResult('toolu_rm', 'Permission denied', undefined, true)),
    ).toEqual([
      {
        type: 'tool',
        id: 'toolu_rm',
        tool: 'Bash',
        summary: 'rm -rf build',
        status: 'failed',
        detail: { kind: 'output', text: 'Permission denied' },
      },
    ]);
  });

  it('tells the user of retries and auto-denials', () => {
    const translate = translator();
    translate.translate(toolUse('toolu_x', 'Bash', { command: 'curl example.com' }));
    const said = [
      sdk({
        type: 'system',
        subtype: 'api_retry',
        attempt: 2,
        max_retries: 10,
        retry_delay_ms: 4200,
        error_status: 529,
        error: 'overloaded',
      }),
      sdk({
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Bash',
        tool_use_id: 'toolu_x',
        decision_reason: 'network access is not allowed',
        message: 'Denied',
      }),
    ].flatMap((message) => ofType(translate.translate(message), 'notice'));
    expect(said.map((n) => [n.level, n.text])).toEqual([
      ['warning', 'API error 529 (overloaded): retrying in 4s (attempt 2 of 10).'],
      ['warning', 'Not allowed: Bash curl example.com (network access is not allowed)'],
    ]);
  });

  it('marks where /clear cleared the conversation', () => {
    expect(
      translator().translate(
        sdk({
          type: 'conversation_reset',
          new_conversation_id: 'n',
          trigger: 'clear',
          uuid: 'reset-1',
        }),
      ),
    ).toEqual([{ type: 'cleared', id: 'reset-1' }]);
  });
});
