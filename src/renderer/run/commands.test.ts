import { it } from 'vitest';
import { newCanvasId } from '../../shared/canvas';
import { runView } from '../../shared/model/views';
import { fakeCore, expectOneOp } from '../test-api';
import { runCommands } from './commands';

it('sends each run and target control as exactly one operation', async () => {
  const core = fakeCore();
  const canvas = newCanvasId();
  const commands = runCommands(core.api, () => canvas, core.topics);
  for (const [gesture, op, args] of [
    [() => commands.start(), 'run.start', { canvas }],
    [() => commands.stop(), 'run.stop', { canvas }],
    [() => commands.resume(), 'run.resume', { canvas }],
    [() => commands.pauseAgent('a'), 'run.pause', { canvas, target: { agent: 'a' } }],
    [() => commands.killAgent('a'), 'run.kill', { canvas, target: { agent: 'a' } }],
    [() => commands.resumeAgent('a'), 'run.unpause', { canvas, target: { agent: 'a' } }],
    [() => commands.pauseGroup('g'), 'run.pause', { canvas, target: { group: 'g' } }],
    [() => commands.killGroup('g'), 'run.kill', { canvas, target: { group: 'g' } }],
    [() => commands.resumeGroup('g'), 'run.unpause', { canvas, target: { group: 'g' } }],
  ] as const) {
    core.operations.length = 0;
    await gesture();
    expectOneOp(core, op, args);
  }
  core.dispose();
});

it('takes Go on’s exact deadline and a hold’s current id from the mirror', async () => {
  const core = fakeCore();
  const canvas = newCanvasId();
  core.snapshot(
    `run:${canvas}`,
    runView({
      running: true,
      agents: { a: { status: 'waiting', current: 'delay', until: 1234, outcomes: {} } },
    }),
  );
  core.snapshot(`needs:${canvas}`, {
    items: [
      {
        id: 'hold/a/generation/ok',
        canvas,
        agent: 'a',
        kind: 'hold',
        for: 'you',
        by: ['you'],
        title: 'Approve?',
        choices: [],
        answerIn: 'api',
      },
    ],
  });
  const stops = [
    core.topics.subscribe(`run:${canvas}`, () => undefined),
    core.topics.subscribe(`needs:${canvas}`, () => undefined),
  ];
  await Promise.all([
    core.topics.whenAt(`run:${canvas}`, 0),
    core.topics.whenAt(`needs:${canvas}`, 0),
  ]);
  const commands = runCommands(core.api, () => canvas, core.topics);
  await commands.goOn('a', 'delay');
  expectOneOp(core, 'run.goOn', { canvas, agent: 'a', item: 'delay', until: 1234 });
  core.operations.length = 0;
  await commands.decide('a', 'ok', { choice: 'approve' });
  expectOneOp(core, 'reply', { canvas, to: 'hold/a/generation/ok', answer: { choice: 'approve' } });
  stops.forEach((stop) => {
    stop();
  });
  core.dispose();
});
