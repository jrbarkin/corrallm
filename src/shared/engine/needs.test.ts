import { describe, expect, it } from 'vitest';

import type { CanvasId } from '../canvas';
import type { AgentNode } from '../model/canvas';
import type { QueueItem } from '../model/queue';
import { NEW_SESSION } from '../model/session';
import type { Session } from '../model/session';
import { needs, needsOf, withoutChoices } from './needs';
import type { NeedsInput } from './needs';
import type { Run } from './run/runner';
import { TEST_ENGINE } from './test-engine';

const CANVAS = '7f3e2d1c-0b9a-4876-8543-210fedcba987' as CanvasId;

const agent = (
  id: string,
  label: string,
  queue: QueueItem[] = [],
  connection?: string,
): AgentNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label, queue, ...(connection === undefined ? {} : { connection }) },
});

/** The Builder pauses until 18:00; the Planner waits for that, no later than 18:00, then asks for an OK. */
const builder = agent('b', 'Builder', [{ id: 'pause', delay: { at: '18:00' } }]);
const planner = agent('p', 'Planner', [
  { id: 'wait', waitFor: [{ agent: 'b', item: 'pause' }], timeout: { at: '18:00' } },
  { id: 'ok', approve: 'the plan' },
]);
const held: Run = {
  running: true,
  agents: { p: { status: 'asking', current: 'ok', outcomes: { wait: 'succeeded' } } },
};

const input = (more: Partial<NeedsInput> = {}): NeedsInput => ({
  canvas: CANVAS,
  nodes: [builder, planner],
  run: { running: false, agents: {} },
  sessions: {},
  catalog: TEST_ENGINE,
  now: Date.now(),
  ...more,
});

/** A session waiting on a permission prompt. */
const asking: Session = {
  ...NEW_SESSION,
  status: 'waiting',
  entries: [
    { id: 'm1', kind: 'user', text: 'Run the tests' },
    { id: 'm1/permission', kind: 'permission', tool: 'Bash', summary: 'npm test', always: null },
  ],
};

describe('needs', () => {
  it('words a hold in the host’s locale', () => {
    const [item] = needs(input({ run: held, locale: 'en-GB' }));
    expect(item).toEqual({
      id: 'hold/p/ok',
      canvas: CANVAS,
      agent: 'p',
      kind: 'hold',
      for: 'you',
      by: ['you'],
      title: 'Your OK on the plan?',
      detail: 'After Wait for Builder: Wait until 18:00, no later than 18:00',
      choices: [
        { value: 'approve', label: 'Approve', humanOnly: 'Only you approve an OK.' },
        {
          value: 'stop',
          label: 'Stop here',
          description: 'Stop this queue here, and whatever waits on it',
        },
      ],
      text: { placeholder: 'What should change?' },
      answerIn: 'api',
    });
    expect(needs(input({ run: held, locale: 'en-US' }))[0]?.detail).toBe(
      'After Wait for Builder: Wait until 6:00 PM, no later than 6:00 PM',
    );
  });

  it('lists run holds, then session prompts, then what Terminal agents ask in their terminals', () => {
    const terminal = agent('t', 'Shell', [], 'codex.terminal');
    const items = needs(
      input({
        nodes: [terminal, builder, planner],
        run: held,
        sessions: {
          b: asking,
          t: { ...NEW_SESSION, asking: [{ kind: 'other', id: 'ask-1', text: 'Action Required' }] },
        },
      }),
    );
    expect(items.map(({ id, kind, answerIn }) => [id, kind, answerIn])).toEqual([
      ['hold/p/ok', 'hold', 'api'],
      ['prompt/b/m1/permission', 'prompt', 'api'],
      ['prompt/t/ask-1', 'prompt', 'terminal'],
    ]);
    expect(items[1]).toMatchObject({
      agent: 'b',
      title: 'Approve Bash: npm test?',
      choices: [
        { value: 'once', label: 'Yes' },
        { value: 'deny', label: 'No' },
      ],
    });
    // Answered in its terminal: nothing to choose here.
    expect(items[2]).toMatchObject({ title: 'Action Required', choices: [] });
  });

  it('derives what the sidebar shows from the same list', () => {
    expect(
      needsOf(input({ run: held, sessions: { b: asking } })).map(({ kind, agent }) => [
        kind,
        agent.id,
      ]),
    ).toEqual([
      ['hold', 'p'],
      ['prompt', 'b'],
    ]);
  });

  it('shows a token your items without their choices', () => {
    const [item] = needs(input({ run: held }));
    if (!item) throw new Error('no item');
    const theirs = withoutChoices(item);
    expect(theirs.choices).toEqual([]);
    expect(theirs).not.toHaveProperty('text');
    expect(theirs).toMatchObject({ title: item.title, by: ['you'], for: 'you' });
  });
});
