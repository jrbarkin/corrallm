import { describe, expect, it } from 'vitest';

import { MAX_DETAIL_LINES } from '../../../shared/api/limits';
import type { CanvasId } from '../../../shared/canvas';
import type { AgentNode } from '../../../shared/model/canvas';
import type { QueueItem } from '../../../shared/model/queue';
import { NEW_SESSION } from '../../../shared/model/session';
import type { Session } from '../../../shared/model/session';
import {
  holdGeneration,
  needs,
  needsOf,
  withoutChoices,
} from '../../../shared/model/needs-selectors';
import type { NeedsInput } from '../../../shared/model/needs-selectors';
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
      id: `hold/p/${holdGeneration(held.agents.p)}/ok`,
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
      [`hold/p/${holdGeneration(held.agents.p)}/ok`, 'hold', 'api'],
      ['prompt/b/0/m1/permission', 'prompt', 'api'],
      ['prompt/t/0/ask-1', 'prompt', 'terminal'],
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

  it('gives every item an id no other item can have', () => {
    // A queue item named "start" on an agent whose session won't start; an agent id with a slash.
    const starter = agent('s', 'Starter', [{ id: 'start', approve: 'the start' }]);
    const slashed = agent('a/b', 'Slashed', [{ id: 'c', approve: 'it' }]);
    const plain = agent('a', 'Plain', [{ id: 'b/c', approve: 'it' }]);
    const asks = (current: string) => ({ status: 'asking' as const, current, outcomes: {} });
    const items = needs(
      input({
        nodes: [starter, slashed, plain],
        run: { running: true, agents: { s: asks('start'), 'a/b': asks('c'), a: asks('b/c') } },
        stuck: [{ agent: 's', text: 'This login can’t run here.', clears: 'It tries again.' }],
        unasking: [{ agent: 's', why: 'mode' }],
      }),
    );
    expect(items.map(({ kind, agent }) => [kind, agent])).toEqual([
      ['hold', 's'],
      ['hold', 'a/b'],
      ['hold', 'a'],
      ['hold', 's'],
      ['hold', 's'],
    ]);
    expect(new Set(items.map(({ id }) => id)).size).toBe(items.length);
  });

  it('says why parties’ messages wait on an agent that would act without asking', () => {
    const planner2 = agent('q', 'Reviewer');
    const items = needs(
      input({
        nodes: [builder, planner, planner2],
        unasking: [
          { agent: 'b', why: 'mode' },
          { agent: 'p', why: 'default' },
          { agent: 'q', why: 'unknown' },
        ],
      }),
    );
    expect(items.map(({ id, title, detail }) => [id, title, detail])).toEqual([
      [
        'unasking/b',
        'Builder runs without asking, so messages from other parties wait',
        'They go once it runs in a mode that asks again.',
      ],
      [
        'unasking/p',
        'Planner’s CLI defaults to a mode that never asks, so messages from other parties wait',
        'They go once it runs in a mode that asks: set it to start in one.',
      ],
      [
        'unasking/q',
        'corrallm can’t tell whether Reviewer’s CLI defaults to a mode that asks, so messages from other parties wait',
        'They go once it runs in a mode that asks: set it to start in one.',
      ],
    ]);
  });

  it('marks each choice only you may make, saying why', () => {
    const step = (id: string, label: string) => agent(id, label, [{ id: 'step', message: 'Go' }]);
    const asks = (more: object) => ({
      status: 'asking' as const,
      current: 'step',
      outcomes: {},
      ...more,
    });
    const resetsAt = Date.now() + 3_600_000;
    const items = needs(
      input({
        nodes: [step('u', 'Usage'), step('c', 'Condition'), step('s', 'Switch'), builder],
        run: {
          running: true,
          agents: {
            u: asks({
              usage: { backend: 'codex', window: 'fiveHour', percent: 50, used: 80, resetsAt },
            }),
            c: asks({
              problem: {
                kind: 'uncertain',
                reason: 'condition',
                text: 'Is it done?',
                agent: 'c',
                conditionKey: 'step',
              },
            }),
            s: asks({
              refused: {
                agent: 's',
                connection: 'claude-code.sdk',
                text: 'Use Terminal',
                switchTo: 'claude-code.terminal',
              },
            }),
          },
        },
        sessions: {
          b: {
            ...asking,
            entries: [
              { id: 'm1', kind: 'user', text: 'Run the tests' },
              {
                id: 'm1/permission',
                kind: 'permission',
                tool: 'Bash',
                summary: 'npm test',
                always: 'Always allow npm test',
              },
            ],
          },
        },
      }),
    );
    const marks = (agentId: string) =>
      Object.fromEntries(
        (items.find((item) => item.agent === agentId)?.choices ?? []).map(
          ({ value, humanOnly }) => [value, humanOnly],
        ),
      );
    expect(marks('u')).toEqual({
      goOn: 'Only you decide to spend more of a usage window.',
      wait: 'Only you decide to spend more of a usage window.',
      stop: undefined,
    });
    expect(items.find((item) => item.agent === 'u')?.until).toBe(resetsAt);
    expect(marks('c')).toMatchObject({
      yes: 'Only you judge a condition.',
      no: 'Only you judge a condition.',
    });
    expect(marks('s')).toEqual({ switch: 'Only you switch how an agent runs.' });
    expect(marks('b')).toEqual({
      once: undefined,
      always: 'Only you allow it always.',
      deny: undefined,
    });
  });

  it('lists only a question prompt’s questions still unanswered, and cuts a long detail short', () => {
    const output = Array.from({ length: 20 }, (_, i) => `line ${String(i + 1)}`).join('\n');
    const items = needs(
      input({
        sessions: {
          b: {
            ...NEW_SESSION,
            status: 'waiting',
            entries: [
              {
                id: 'q',
                kind: 'question',
                questions: [
                  { header: 'A', text: 'First?', options: [], multiple: false, answer: 'yes' },
                  { header: 'B', text: 'Second?', options: [], multiple: false },
                ],
              },
            ],
          },
          p: {
            ...asking,
            entries: [
              {
                id: 'p1',
                kind: 'permission',
                tool: 'Bash',
                summary: 'npm test',
                always: null,
                detail: { kind: 'output', text: output },
              },
            ],
          },
        },
      }),
    );
    expect(items[0]).toMatchObject({ title: 'Second?' });
    expect(items[0]?.questions?.map(({ text }) => text)).toEqual(['Second?']);
    const detail = items[1]?.detail?.split('\n') ?? [];
    expect(detail).toHaveLength(MAX_DETAIL_LINES + 1);
    expect(detail.at(-1)).toBe(`… ${String(20 - MAX_DETAIL_LINES)} more lines`);
  });

  it('tells every time of day in a hold’s words in the host’s locale', () => {
    // A delay until 18:00 the run holds at, as a problem and as a session that won't start; and a
    // usage rule's hold before a message, its window resetting at 18:00. (An OK's own words tell
    // a wait's time, above: a delay right before it is passed over.)
    const queue: QueueItem[] = [
      { id: 'pause', delay: { at: '18:00' } },
      { id: 'say', message: 'Hello' },
    ];
    const resetsAt = new Date();
    resetsAt.setHours(18, 0, 0, 0);
    if (resetsAt.getTime() < Date.now()) resetsAt.setDate(resetsAt.getDate() + 1);
    const asks = (current: string, more: object) => ({
      status: 'asking' as const,
      current,
      outcomes: {},
      ...more,
    });
    const run: Run = {
      running: true,
      agents: {
        x: asks('pause', {
          problem: { kind: 'failed', reason: 'error', text: 'Failed.', agent: 'x' },
        }),
        y: asks('pause', { refused: { agent: 'y', connection: 'claude-code.sdk', text: 'No.' } }),
        w: asks('say', {
          usage: {
            backend: 'codex',
            window: 'fiveHour',
            percent: 50,
            used: 80,
            resetsAt: resetsAt.getTime(),
          },
        }),
      },
    };
    const nodes = ['x', 'y', 'w'].map((id) => agent(id, id.toUpperCase(), queue));
    const details = (locale: string) =>
      needs(input({ nodes, run, locale })).map(({ detail }) => detail);
    expect(details('en-GB')).toEqual([
      'Wait until 18:00',
      'Wait until 18:00 waits until Y can start',
      expect.stringMatching(/^Before “Hello” · resets (\w+ )?18:00$/) as string,
    ]);
    expect(details('en-US')).toEqual([
      'Wait until 6:00 PM',
      'Wait until 6:00 PM waits until Y can start',
      expect.stringMatching(/^Before “Hello” · resets (\w+ )?6:00 PM$/) as string,
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

  it('shows a token an MCP server’s request without the link only you may open', () => {
    const signIn: Session = {
      ...NEW_SESSION,
      status: 'waiting',
      entries: [
        { id: 'm1', kind: 'user', text: 'Read the issues' },
        {
          id: 'm1/elicitation',
          kind: 'elicitation',
          server: 'tracker',
          message: 'Sign in at tracker.example.com/oauth%3Fstate%3Dsecret',
          url: 'https://tracker.example.com/oauth?state=secret',
        },
        {
          id: 'm1/form',
          kind: 'elicitation',
          server: 'tracker',
          message: 'Paste the key tracker.example.com/key%3Ftoken%3Dsecret shows',
          fields: [{ name: 'key', label: 'Key', required: true, kind: 'text' }],
        },
      ],
    };
    const [link, form] = needs(input({ sessions: { b: signIn } }));
    // Titled in the core's words, never the server's, which may hold its link.
    expect(link).toMatchObject({
      title: 'MCP server “tracker” asks you to open a link',
      form: { url: 'https://tracker.example.com/oauth?state=secret' },
    });
    expect(form).toMatchObject({ title: 'MCP server “tracker” asks you to fill in a form' });
    if (!link || !form) throw new Error('no item');
    for (const item of [link, form]) {
      const theirs = withoutChoices(item);
      expect(theirs).not.toHaveProperty('form');
      expect(theirs.title).toBe(item.title);
      expect(JSON.stringify(theirs)).not.toMatch(/secret|Sign in at|Paste the key|example\.com/);
    }
  });

  it('gives a hold asked again, after changes, a retry or another run, another id (B11 §7)', () => {
    const at = held.agents.p;
    if (at === undefined) throw new Error('no hold');
    const id = (run: Run) => needs(input({ run }))[0]?.id;
    const first = id(held);
    expect(first).toMatch(/^hold\/p\/[0-9a-f]{8}\/ok$/);
    // The same hold read again, across a restart too: the same id.
    expect(id({ ...held, agents: { p: { ...at } } })).toBe(first);
    // After its changes were asked for, the OK it asks again is another.
    expect(id({ ...held, agents: { p: { ...at, changes: { ok: ['Shorter'] } } } })).not.toBe(first);
    // Reached again after a task ran again (another attempt), or in another run.
    expect(
      id({
        ...held,
        agents: {
          p: { ...at, attempts: { wait: [{ id: 'a2', startedAt: 1, status: 'succeeded' }] } },
        },
      }),
    ).not.toBe(first);
    // A usage reading that only moves its percent isn't another hold.
    const usage = { backend: 'claude', window: 'fiveHour', percent: 91, used: 91, resetsAt: 5 };
    const asking = (percent: number): Run => ({
      ...held,
      agents: { p: { ...at, usage: { ...usage, percent, used: percent } as never } },
    });
    expect(id(asking(91))).toBe(id(asking(97)));
  });

  it('gives a prompt of another session whose native id is reused another id', () => {
    const generations = (generation: number) => () => generation;
    const of = (generation: number) =>
      needs(input({ sessions: { b: asking }, sessionGenerations: generations(generation) }))[0]?.id;
    expect(of(3)).toBe('prompt/b/3/m1/permission');
    expect(of(4)).toBe('prompt/b/4/m1/permission');
  });
});
