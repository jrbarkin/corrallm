import path from 'node:path';

import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import type { SessionEvent } from '../../../../shared/session';
import { historyEvents } from './history';
import { RECORDED_PLACES, recorded, recordedHistory } from './recorded';

/** Each event, in short: what a reader of the transcript would see, in order. */
function outline(events: SessionEvent[]): string[] {
  return events.map((event) => {
    switch (event.type) {
      case 'user':
        return `user: ${event.text}`;
      case 'tool':
        return `${event.tool} ${event.summary} (${event.status})`;
      case 'end':
        return event.result.status === 'cancelled' ? 'end (interrupted)' : 'end';
      case 'notice':
        return `notice: ${event.text}`;
      case 'text':
      case 'thinking':
        return `${event.type}: ${event.text.slice(0, 30)}`;
      default:
        return event.type;
    }
  });
}

/** The plan file Claude Code wrote, as the transcript shows it (with the machine's separator). */
const PLAN = path.join(
  '~',
  '.claude',
  'plans',
  'first-use-the-askuserquestion-validated-sunset.md',
);

describe('historyEvents, on what the real Claude Code kept', () => {
  it('uses the saved native completion or refusal, and never completes an unfinished turn', () => {
    const user = (uuid: string): SessionMessage => ({
      type: 'user',
      uuid,
      session_id: 's',
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: { role: 'user', content: 'Hello' },
    });
    const assistant = (stop_reason: string | null, said: string): SessionMessage => ({
      type: 'assistant',
      uuid: 'a',
      session_id: 's',
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: said }], stop_reason },
    });
    const ends = (messages: SessionMessage[]) =>
      historyEvents(messages, RECORDED_PLACES)
        .filter((event) => event.type === 'end')
        .map((event) => event.result);
    expect(ends([user('u'), assistant('refusal', 'I cannot do that.')])).toEqual([
      { status: 'failed', reason: 'declined', message: 'I cannot do that.' },
    ]);
    expect(
      ends([
        user('u'),
        assistant('refusal', 'I cannot do that.'),
        assistant('end_turn', 'The fallback did it.'),
      ]),
    ).toEqual([{ status: 'completed', reason: 'completed' }]);
    expect(ends([user('u'), assistant(null, 'Still thinking')])).toEqual([]);
    expect(ends([user('u'), user('next')])).toEqual([]);
    expect(
      ends([
        user('u'),
        {
          ...assistant('stop_sequence', 'API Error'),
          message: {
            id: 'a',
            model: '<synthetic>',
            stop_reason: 'stop_sequence',
            content: [{ type: 'text', text: 'API Error' }],
          },
        },
      ]),
    ).toEqual([]);
    expect(
      ends([
        user('u'),
        { ...assistant(null, 'Interrupted'), interruptedByShutdown: true } as SessionMessage,
      ]),
    ).toEqual([{ status: 'cancelled', reason: 'connection-closed' }]);
  });

  it('replays each turn: the message, what Claude did, and its end', () => {
    const events = historyEvents(recordedHistory('question-and-plan'), RECORDED_PLACES);
    expect(outline(events)).toEqual([
      'user: First use the AskUserQuestion tool to ask me whether the new file should be named a.txt or b.txt. Then write a one-step plan to create that file containing the word hi, and present the plan for approval. After approval, do it. Keep replies very short.',
      // Answered long ago: the question and the plan are tool calls like any other.
      'AskUserQuestion Should the new file be named a.txt or b.txt? (running)',
      'AskUserQuestion Should the new file be named a.txt or b.txt? (done)',
      "thinking: Since I'm in plan mode, I shou",
      `Write ${PLAN} (running)`,
      `Write ${PLAN} (done)`,
      'ToolSearch select:ExitPlanMode (running)',
      'ToolSearch select:ExitPlanMode (done)',
      'ExitPlanMode  (running)',
      'ExitPlanMode  (done)',
      "thinking: With the plan approved, I'll c",
      'Write a.txt (running)',
      'Write a.txt (done)',
      'Read a.txt (running)',
      'Read a.txt (done)',
      'text: Created `a.txt` in the run-b s',
      'end',
    ]);
    // The turn is the message the user sent: the same id it had live.
    const sent = recorded('question-and-plan').find((item) => item.kind === 'send');
    expect(events[0]).toMatchObject({ type: 'user', id: sent?.data.uuid });
    // Without the tool's structured result, a written file's diff is rebuilt from its content.
    const written = events.filter(
      (event) => event.type === 'tool' && event.summary === 'a.txt' && event.status === 'done',
    );
    expect(written[0]).toMatchObject({
      detail: { kind: 'diff', added: 1, removed: 0, lines: [{ kind: 'add', text: 'hi' }] },
    });
  });

  it('keeps entries’ ids as they were live, so that a transcript showing them is not repeated', () => {
    const events = historyEvents(recordedHistory('subagent-and-interrupt'), RECORDED_PLACES);
    const ids = events.flatMap((event) => ('id' in event ? [event.id] : []));
    expect(ids).toContain('toolu_01Nm9BzJJhCPpkNza6xFmnPk');
    expect(ids).toContain('msg_011CfyhWuvjZAohwe8Nafb9u:1');
  });

  it('marks a turn the user interrupted, and shows a subagent’s report without its frame', () => {
    const events = historyEvents(recordedHistory('subagent-and-interrupt'), RECORDED_PLACES);
    expect(outline(events).filter((line) => line.startsWith('end'))).toEqual([
      'end',
      'end (interrupted)',
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool',
        tool: 'Agent',
        status: 'done',
        detail: { kind: 'output', text: 'Corral the agents' },
      }),
    );
  });

  it('times each turn by its own work, not the wait for the next message', () => {
    const events = historyEvents(recordedHistory('subagent-and-interrupt'), RECORDED_PLACES);
    // Sent at 05:39:51.549, its last reply at 05:40:02.717; the next message came at 05:40:04.
    expect(events.find((event) => event.type === 'end')).toMatchObject({ seconds: 11 });
  });

  it('shows a slash command’s output, and is not stretched by what the CLI noted later', () => {
    const at = (seconds: number) => new Date(Date.UTC(2026, 9, 13, 6, 0, seconds)).toISOString();
    const message = (
      type: 'user' | 'assistant',
      uuid: string,
      seconds: number,
      content: unknown,
      flags: object = {},
    ) =>
      ({
        type,
        uuid,
        session_id: 's',
        parent_tool_use_id: null,
        parent_agent_id: null,
        timestamp: at(seconds),
        message: { role: type, content },
        ...flags,
      }) as SessionMessage;
    const events = historyEvents(
      [
        message(
          'user',
          'u1',
          0,
          '<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>',
          { isCompletedLocalCommand: true },
        ),
        // Shown to the user only: the CLI keeps it as meta.
        message(
          'user',
          'u2',
          2,
          '<local-command-stdout>## Context Usage\n\n**Tokens:** 18k / 200k (9%)</local-command-stdout>',
          { isCompletedLocalCommand: true, is_meta: true },
        ),
        message('user', 'u3', 50, 'Hello'),
        {
          ...message('assistant', 'a1', 53, [{ type: 'text', text: 'Hi' }]),
          message: { id: 'a1', content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn' },
        },
        // Noted long after the turn: not part of it.
        message('user', 'u4', 900, 'Caveat: the messages below were generated by the user', {
          is_meta: true,
        }),
      ],
      RECORDED_PLACES,
    );
    expect(outline(events)).toEqual([
      'user: /context',
      'notice: ## Context Usage\n\n**Tokens:** 18k / 200k (9%)',
      'end',
      'user: Hello',
      'text: Hi',
      'end',
    ]);
    expect(events.filter((event) => event.type === 'end').map((end) => end.seconds)).toEqual([
      2, 3,
    ]);
  });

  it('shows a compaction once, and the command that made it as the user typed it', () => {
    const events = historyEvents(recordedHistory('tools-and-compact'), RECORDED_PLACES);
    expect(outline(events)).toEqual([
      'notice: The conversation was compacted: what came before is summarized for Claude.',
      'text: Done. `echo hello` printed `he',
      'user: /compact',
      'end',
    ]);
  });
});
