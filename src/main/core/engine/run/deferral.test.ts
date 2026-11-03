import { afterEach, describe, expect, it } from 'vitest';

import type { AgentNode } from '../../../../shared/model/canvas';
import type { QueueItem } from '../../../../shared/model/queue';
import type { TaskMessage, TurnResult } from '../../../../shared/session';
import { TEST_ENGINE } from '../test-engine';
import type { RunIO, RunTasks, TurnEnd } from './runner';
import { expectRestorable, liveRun } from './test-restore';

afterEach(expectRestorable);

/*
 * B21 C5 (Design §9.2 C7, C8), the run's half: a step's turn that ends while its attempt waits on
 * an ask is not judged (its queue stays, its attempt runs); the turn each settlement brings it (a
 * continuation, which delivery schedules) is the attempt's own, and judges it once none waits; a
 * verdict reported with `complete` is fixed then and applied at the turn's native end; the step's
 * text asks for `complete` once its session listed it; and a held or restored run keeps a waiting
 * attempt waiting, as the canvas's mailbox (RunIO.tasks) says, never inventing an uncertain turn.
 */

const engine = TEST_ENGINE;
const COMPLETED: TurnResult = { status: 'completed', reason: 'completed' };

/** What the canvas's mailbox holds of each attempt's asks and result, as each test says (RunIO.tasks). */
function mailbox() {
  /** Attempts with an ask open, or a continuation not yet ended. */
  const waiting = new Set<string>();
  /** Attempts one of whose continuations was in flight as the session ended. */
  const answered = new Set<string>();
  /** What each attempt's agent reported with complete. */
  const reported = new Map<string, 'succeeded' | 'failed'>();
  /** Each attempt Stop, Kill or Run again took back a continuation of. */
  const interrupted: string[] = [];
  const tasks: RunTasks = {
    waits: ({ attempt }) => waiting.has(attempt),
    reported: ({ attempt }) => reported.get(attempt),
    recover: ({ attempt }) =>
      waiting.has(attempt) && !answered.has(attempt)
        ? { waiting: true }
        : { waiting: false, answered: answered.has(attempt) },
    interrupt: ({ attempt }) => {
      interrupted.push(attempt);
    },
  };
  return { waiting, answered, reported, interrupted, tasks };
}

/** A run of agent A's queue, on a connected agent, its turns ended by the test. */
function setup(queue: QueueItem[], more: Partial<RunIO> = {}, box = mailbox()) {
  const sent: { text: string; done: (turn: TurnEnd) => void; task?: TaskMessage }[] = [];
  const io: RunIO = {
    send: (_node, text, done, _images, _refused, _origin, _display, task) => {
      sent.push({ text, done, ...(task === undefined ? {} : { task }) });
      return () => undefined;
    },
    tell: () => undefined,
    later: () => () => undefined,
    now: () => 1234,
    tasks: box.tasks,
    ...more,
  };
  const node: AgentNode = {
    id: 'a',
    type: 'agent',
    position: { x: 0, y: 0 },
    data: { label: 'A', connection: 'claude-code.sdk', queue },
  };
  const store = liveRun(engine, io);
  store.update([node]);
  /** The agent's current task's last attempt. */
  const attempt = () => {
    const at = store.snapshot().agents.a;
    return at?.attempts?.[at.current ?? '']?.at(-1);
  };
  /** That attempt, as a task's messages name it. */
  const task = (): TaskMessage => {
    const at = store.snapshot().agents.a;
    const last = attempt();
    if (at?.current === undefined || last === undefined) throw new Error('No attempt');
    return { agent: 'a', item: at.current, attempt: last.id };
  };
  return {
    store,
    sent,
    box,
    io,
    node,
    attempt,
    task,
    /** Ends the turn of the last thing sent, as it went. */
    reply: (reply: string, failed = false, result?: TurnResult) => {
      const turn = sent.at(-1);
      if (!turn) throw new Error('No turn');
      turn.done({ failed, reply, ...(result ? { result } : {}) });
    },
  };
}

const step = { id: 'build', action: 'Bash', instruction: 'Run the tests' };
const next = { id: 'next', message: 'Ship it' };
/** What a tool's step asks for at its end, without complete (turns.ts). */
const VERDICT =
  'End your reply with SUCCEEDED or FAILED on a line of its own: whether the step succeeded (a command: whether it exited with status 0; tests: whether they all passed), even if you expected it to fail.';
/** What it asks for once its session listed complete: that call, else the last line. */
const COMPLETE = (attempt: string) =>
  `When the step is done, report how it went with corrallm’s complete tool: task "${attempt}", outcome "succeeded" or "failed" (whether the step succeeded: a command, whether it exited with status 0; tests, whether they all passed; even if you expected it to fail), and a short summary of what you did. If that call is refused or unavailable, end your reply with SUCCEEDED or FAILED on a line of its own instead.`;

describe('a step whose attempt asks (C7)', () => {
  it('isn’t judged when its turn ends with an ask open; its continuation’s end judges it', () => {
    const run = setup([step, next]);
    run.store.start();
    const task = run.task();
    run.box.waiting.add(task.attempt);
    run.reply('I asked which tests to run.');
    // No verdict, no condition, the queue stays: the attempt runs on, waiting.
    expect(run.store.snapshot().agents.a).toMatchObject({ current: 'build', status: 'running' });
    expect(run.store.snapshot().agents.a?.problem).toBeUndefined();
    expect(run.attempt()?.status).toBe('running');
    expect(run.store.snapshot().running).toBe(true);
    expect(run.sent).toHaveLength(1);
    // Its answer's turn is the attempt's own: its end judges it, by its reply's last line.
    run.box.waiting.delete(task.attempt);
    run.store.continued(task, {
      failed: false,
      reply: 'All 12 pass.\nSUCCEEDED',
      result: COMPLETED,
    });
    expect(run.store.snapshot().agents.a).toMatchObject({
      current: 'next',
      outcomes: { build: 'succeeded' },
    });
    expect(run.sent.map(({ text }) => text).at(-1)).toBe('Ship it');
  });

  it('waits again while another of its asks waits, and hears no other attempt’s continuation', () => {
    const run = setup([step, next]);
    run.store.start();
    const task = run.task();
    run.box.waiting.add(task.attempt);
    run.reply('Asked two.');
    // Another attempt's (a stale one's) continuation judges nothing.
    run.store.continued(
      { ...task, attempt: '00000000-0000-4000-8000-000000000000' },
      { failed: false, reply: 'SUCCEEDED' },
    );
    expect(run.store.snapshot().agents.a?.outcomes).toEqual({});
    // One answered, the other still open: it waits again, unjudged.
    run.store.continued(task, { failed: false, reply: 'One answer in.' });
    expect(run.store.snapshot().agents.a).toMatchObject({ current: 'build', status: 'running' });
    expect(run.store.snapshot().agents.a?.problem).toBeUndefined();
    run.box.waiting.delete(task.attempt);
    run.store.continued(task, { failed: false, reply: 'Both in.\nFAILED' });
    expect(run.store.snapshot().agents.a).toMatchObject({
      current: 'build',
      status: 'asking',
      problem: { kind: 'failed', reason: 'task-failed' },
    });
  });

  it('holds a native failure or cancellation for you even while an ask is open', () => {
    const failed = setup([step]);
    failed.store.start();
    failed.box.waiting.add(failed.task().attempt);
    failed.reply('', true, { status: 'failed', reason: 'usage-limit', message: 'Limit.' });
    expect(failed.store.snapshot().agents.a?.problem).toMatchObject({
      kind: 'failed',
      reason: 'usage-limit',
    });
    const cancelled = setup([step]);
    cancelled.store.start();
    cancelled.box.waiting.add(cancelled.task().attempt);
    cancelled.reply('', false, { status: 'cancelled', reason: 'interrupted' });
    expect(cancelled.store.snapshot().agents.a?.problem).toMatchObject({ kind: 'cancelled' });
  });

  it('never waits on a message item, which an ask in its turn doesn’t belong to', () => {
    const run = setup([next]);
    run.store.start();
    run.box.waiting.add(run.task().attempt);
    run.reply('Shipped.');
    expect(run.store.snapshot().agents.a).toMatchObject({
      status: 'done',
      outcomes: { next: 'succeeded' },
    });
  });

  it('ends a waiting attempt cancelled on Stop or Kill, taking back its continuation', () => {
    const stopped = setup([step]);
    stopped.store.start();
    const task = stopped.task();
    stopped.box.waiting.add(task.attempt);
    stopped.reply('Asked.');
    stopped.store.stop();
    expect(stopped.attempt()?.status).toBe('cancelled');
    expect(stopped.store.snapshot().agents.a?.problem?.kind).toBe('cancelled');
    expect(stopped.box.interrupted).toEqual([task.attempt]);
    // Its continuation's end, if one comes, judges nothing now.
    stopped.store.continued(task, { failed: false, reply: 'SUCCEEDED' });
    expect(stopped.store.snapshot().agents.a?.outcomes).toEqual({});

    const killed = setup([step]);
    killed.store.start();
    const killedTask = killed.task();
    killed.box.waiting.add(killedTask.attempt);
    killed.reply('Asked.');
    killed.store.killAgent('a');
    expect(killed.attempt()?.status).toBe('cancelled');
    expect(killed.box.interrupted).toEqual([killedTask.attempt]);
  });
});

describe('a step its agent completes (C8)', () => {
  it('asks for complete, with its attempt id, only once its session listed complete', () => {
    const listed = setup([step], { completes: () => true });
    listed.store.start();
    expect(listed.sent[0]?.text).toBe(
      `Use the Bash tool for this step: Run the tests\n\n${COMPLETE(listed.task().attempt)}`,
    );
    const unlisted = setup([step], { completes: () => false });
    unlisted.store.start();
    expect(unlisted.sent[0]?.text).toBe(
      `Use the Bash tool for this step: Run the tests\n\n${VERDICT}`,
    );
    // A slash command is sent as it is, whatever was listed.
    const command = setup([{ id: 'review', action: '/code-review' }], { completes: () => true });
    command.store.start();
    expect(command.sent[0]?.text).toBe('/code-review');
  });

  it('applies the reported outcome at the turn’s native end: native first, inverted by expect', () => {
    const reported = setup([step, next]);
    reported.store.start();
    reported.box.reported.set(reported.task().attempt, 'succeeded');
    // No last line needed: the report decides.
    reported.reply('Done.');
    expect(reported.store.snapshot().agents.a?.outcomes).toEqual({ build: 'succeeded' });

    const native = setup([step]);
    native.store.start();
    native.box.reported.set(native.task().attempt, 'succeeded');
    native.reply('', true, { status: 'failed', reason: 'api', message: 'Overloaded.' });
    expect(native.store.snapshot().agents.a?.problem).toMatchObject({
      kind: 'failed',
      reason: 'api',
    });

    const expected = setup([{ ...step, expect: 'fails' as const }]);
    expected.store.start();
    expected.box.reported.set(expected.task().attempt, 'failed');
    expected.reply('It fails, as written.');
    expect(expected.store.snapshot().agents.a).toMatchObject({
      outcomes: { build: 'succeeded' },
      asExpected: { build: true },
    });
  });

  it('holds uncertain, showing both, a last line that disagrees with the report', () => {
    const run = setup([step]);
    run.store.start();
    run.box.reported.set(run.task().attempt, 'succeeded');
    run.reply('2 tests failed.\nFAILED');
    expect(run.store.snapshot().agents.a?.problem).toMatchObject({
      kind: 'uncertain',
      reason: 'disagreeing-verdict',
      text: 'The agent reported this step succeeded with complete, but its reply’s last line says FAILED. Inspect the session before continuing.',
    });
  });

  it('judges a waiting attempt once its agent reported it, at its continuation’s end', () => {
    const run = setup([step]);
    run.store.start();
    const task = run.task();
    run.box.waiting.add(task.attempt);
    run.reply('Asked.');
    // complete withdrew its asks and reported it: the next turn's end judges it.
    run.box.waiting.delete(task.attempt);
    run.box.reported.set(task.attempt, 'failed');
    run.store.continued(task, { failed: false, reply: 'Thanks; it fails.' });
    expect(run.store.snapshot().agents.a?.problem).toMatchObject({
      kind: 'failed',
      reason: 'task-failed',
    });
  });
});

describe('a waiting attempt held and restored (C7)', () => {
  it('stays waiting as the run is held, restores waiting, and its continuation judges it once resumed', () => {
    const run = setup([step, next]);
    run.store.start();
    const task = run.task();
    run.box.waiting.add(task.attempt);
    run.reply('Asked.');
    run.store.pause();
    // Never an uncertain turn: none was in flight.
    expect(run.store.snapshot().agents.a).toMatchObject({ current: 'build', status: 'running' });
    expect(run.attempt()?.status).toBe('running');
    const restored = setup([step, next], {}, run.box);
    restored.store.restore(run.store.checkpoint());
    expect(restored.store.snapshot()).toEqual(run.store.snapshot());
    restored.store.resume();
    // Resumed, it still waits: nothing is sent again.
    expect(restored.sent).toHaveLength(0);
    expect(restored.store.snapshot().agents.a?.problem).toBeUndefined();
    run.box.waiting.delete(task.attempt);
    restored.store.continued(task, { failed: false, reply: 'SUCCEEDED' });
    expect(restored.store.snapshot().agents.a?.outcomes).toEqual({ build: 'succeeded' });
    expect(restored.sent.map(({ text }) => text)).toEqual(['Ship it']);
  });

  it('restores uncertain one whose answer had reached its agent, or whose agent had reported, saying so', () => {
    const answered = setup([step]);
    answered.store.start();
    const task = answered.task();
    answered.box.waiting.add(task.attempt);
    answered.reply('Asked.');
    // As a crash leaves it: still running, its continuation in flight.
    const checkpoint = answered.store.checkpoint();
    answered.box.answered.add(task.attempt);
    const restored = setup([step], {}, answered.box);
    restored.store.restore(checkpoint);
    expect(restored.store.snapshot().agents.a?.problem).toMatchObject({ kind: 'uncertain' });
    expect(restored.store.snapshot().agents.a?.problem?.text).toContain(
      'An answer to a question it asked had reached the agent.',
    );
    expect(restored.attempt()?.status).toBe('uncertain');

    const reported = setup([step]);
    reported.store.start();
    reported.box.reported.set(reported.task().attempt, 'failed');
    const again = setup([step], {}, reported.box);
    again.store.restore(reported.store.checkpoint());
    expect(again.store.snapshot().agents.a?.problem?.text).toContain(
      'The agent had reported this step failed.',
    );
    // As quitting holds it too.
    reported.store.pause();
    expect(reported.store.snapshot().agents.a?.problem?.text).toContain(
      'The agent had reported this step failed.',
    );
  });
});
