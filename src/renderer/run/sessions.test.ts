import { afterEach, expect, it, vi } from 'vitest';
import { newCanvasId } from '../../shared/canvas';
import { fakeCore } from '../test-api';
import { sessionCommands } from './sessions';

afterEach(() => vi.unstubAllGlobals());

it('keeps manual sends on the transitional fixed channel, including images, without a window message op', async () => {
  const sendToSession = vi.fn().mockResolvedValue(null);
  vi.stubGlobal('window', { api: { sendToSession } });
  const core = fakeCore();
  const failed = vi.fn();
  const controls = sessionCommands(core.api, newCanvasId(), 'a', core.topics, failed);
  const images = [{ mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' }];
  controls.send('Fix it', images);
  await Promise.resolve();
  expect(sendToSession).toHaveBeenCalledExactlyOnceWith('a', {
    id: expect.any(String) as unknown,
    text: 'Fix it',
    images,
  });
  expect(core.operations).toEqual([]);
  expect(failed).not.toHaveBeenCalled();
  core.dispose();
});

it('records a view-handled command through the fixed bridge without sending a CLI turn', async () => {
  const recordSessionCommand = vi.fn().mockResolvedValue(null);
  vi.stubGlobal('window', { api: { recordSessionCommand } });
  const core = fakeCore();
  const failed = vi.fn();
  sessionCommands(core.api, newCanvasId(), 'a', core.topics, failed).recordSubmission?.('/mcp');
  await Promise.resolve();
  expect(recordSessionCommand).toHaveBeenCalledExactlyOnceWith('a', {
    id: expect.any(String) as unknown,
    text: '/mcp',
  });
  expect(core.operations).toEqual([]);
  core.dispose();
});

it('answers each native prompt through exactly one typed reply', async () => {
  const { expectOneOp } = await import('../test-api');
  const core = fakeCore();
  const canvas = newCanvasId();
  core.snapshot(`needs:${canvas}`, {
    items: [
      {
        id: 'prompt/a/0/p',
        canvas,
        agent: 'a',
        kind: 'prompt',
        for: 'you',
        by: ['you'],
        title: 'A prompt',
        choices: [],
        questions: [
          { id: 'q', header: 'Branch', text: 'Which?', multiple: false, other: false, options: [] },
        ],
        answerIn: 'api',
      },
    ],
  });
  const stop = core.topics.subscribe(`needs:${canvas}`, () => undefined);
  await core.topics.whenAt(`needs:${canvas}`, 0);
  const failed = vi.fn();
  const controls = sessionCommands(core.api, canvas, 'a', core.topics, failed);
  for (const [answer, send] of [
    [
      { permission: 'deny', feedback: 'Try another way' },
      () => {
        controls.answer('p', 'deny', 'Try another way');
      },
    ],
    [
      { answers: { q: 'main' } },
      () => {
        controls.answerQuestion('p', 0, 'main');
      },
    ],
    [
      { plan: { approve: false, feedback: 'Keep planning' } },
      () => {
        controls.answerPlan('p', { approve: false, feedback: 'Keep planning' });
      },
    ],
    [
      { form: { action: 'accept', values: { approved: true } } },
      () => {
        controls.answerElicitation('p', 'accept', { approved: true });
      },
    ],
  ] as const) {
    core.operations.length = 0;
    send();
    await Promise.resolve();
    await Promise.resolve();
    expectOneOp(core, 'reply', { canvas, to: 'prompt/a/0/p', answer });
  }
  expect(failed).not.toHaveBeenCalled();
  stop();
  core.dispose();
});

it('a view-only draft flush also awaits an admitted manual send before the window closes', async () => {
  const { flushDrafts } = await import('../useDraft');
  const pending = Promise.withResolvers<null>();
  vi.stubGlobal('window', { api: { sendToSession: vi.fn(() => pending.promise) } });
  const core = fakeCore();
  sessionCommands(core.api, newCanvasId(), 'a', core.topics, vi.fn()).send('Keep it');
  let done = false;
  const flushing = flushDrafts().then(() => {
    done = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(done).toBe(false);
  pending.resolve(null);
  await flushing;
  expect(done).toBe(true);
  core.dispose();
});
