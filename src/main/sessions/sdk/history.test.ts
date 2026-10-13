import { describe, expect, it } from 'vitest';

import type { SessionEvent } from '../../../shared/session';
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
        return event.interrupted ? 'end (interrupted)' : 'end';
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

describe('historyEvents, on what the real Claude Code kept', () => {
  it('replays each turn: the message, what Claude did, and its end', () => {
    const events = historyEvents(recordedHistory('question-and-plan'), RECORDED_PLACES);
    expect(outline(events)).toEqual([
      'user: First use the AskUserQuestion tool to ask me whether the new file should be named a.txt or b.txt. Then write a one-step plan to create that file containing the word hi, and present the plan for approval. After approval, do it. Keep replies very short.',
      // Answered long ago: the question and the plan are tool calls like any other.
      'AskUserQuestion Should the new file be named a.txt or b.txt? (running)',
      'AskUserQuestion Should the new file be named a.txt or b.txt? (done)',
      "thinking: Since I'm in plan mode, I shou",
      'Write ~/.claude/plans/first-use-the-askuserquestion-validated-sunset.md (running)',
      'Write ~/.claude/plans/first-use-the-askuserquestion-validated-sunset.md (done)',
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
