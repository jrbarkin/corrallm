import { afterEach, expect, it, vi } from 'vitest';
import { newCanvasId } from '../../shared/canvas';
import { fakeCore } from '../test-api';
import { nativeQueries, sessionCommands, sessionDisplay } from './sessions';
import { NEW_SESSION } from '../../shared/model/session';
import { sessionView } from '../../shared/model/views';
import type { MessageView } from '../../shared/model/views';
import { AgentId } from '../../shared/api/ids';
import { catalog } from '../catalog';
import { ApiError } from '../api/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useDisplayedSession } from './sessions';
import { expectOneOp } from '../test-api';
const connection = catalog().adapters[0]?.connections[0]?.id;
if (!connection) throw new Error('The fixture needs a connection.');

afterEach(() => vi.unstubAllGlobals());

it('uses the foreground session topic summary with its entries, even before the canvas summary arrives', async () => {
  const core = fakeCore();
  const canvas = newCanvasId();
  const view = sessionView(AgentId.parse('a'), connection, {
    ...NEW_SESSION,
    status: 'working',
    model: 'native-model',
    entries: [{ kind: 'text', id: 'reply', text: 'Streaming' }],
  });
  core.snapshot(`session:${canvas}:a`, view);
  const presentation = { snapshot: () => undefined, subscribe: () => () => undefined };
  const hook = renderHook(() =>
    useDisplayedSession(canvas, 'a', core.topics, undefined, undefined, {
      ...nativeQueries,
      presentation,
    }),
  );
  try {
    await waitFor(() => expect(hook.result.current.entries).toHaveLength(1));
    expect(hook.result.current).toMatchObject({ status: 'working', model: 'native-model' });
    act(() => {
      core.change({
        topic: `session:${canvas}:a`,
        rev: 1,
        summary: { ...view.summary, status: 'idle', model: 'changed-model' },
        entries: {},
      });
    });
    expect(hook.result.current).toMatchObject({ status: 'idle', model: 'changed-model' });
    expect(core.operations).toEqual([]);
  } finally {
    hook.unmount();
    core.dispose();
  }
});

it('keeps each native control one operation, including lifecycle composites', async () => {
  const core = fakeCore();
  const canvas = newCanvasId();
  const failed = vi.fn();
  const controls = sessionCommands(core.api, canvas, 'a', core.topics, failed);
  try {
    for (const [op, args, gesture] of [
      ['session.interrupt', {}, () => controls.stop()],
      ['session.setMode', { mode: 'plan' }, () => controls.setMode('plan')],
      ['session.setModel', { model: 'opus' }, () => controls.setModel('opus')],
      ['session.setEffort', { effort: null }, () => controls.setEffort?.(null)],
      ['session.stopTask', { task: 'task-1' }, () => controls.stopTask?.('task-1')],
      ['session.restart', {}, () => controls.restart()],
    ] as const) {
      core.operations.length = 0;
      gesture();
      await waitFor(() => expectOneOp(core, op, { canvas, agent: 'a', ...args }));
    }
    core.operations.length = 0;
    core.respond('session.rewind', { conversation: true });
    await controls.rewind('native-message', 'conversation');
    expectOneOp(core, 'session.rewind', {
      canvas, agent: 'a', message: 'native-message', restore: 'conversation',
    });
    expect(failed).not.toHaveBeenCalled();
  } finally {
    core.dispose();
  }
});

it('keeps the foreground agent context through the pending options query', async () => {
  const options = { models: [], defaults: { model: null, effort: null, mode: null } };
  const settingsOptions = vi.fn().mockResolvedValue({ ok: true, value: options });
  vi.stubGlobal('window', { api: { settingsOptions } });
  const core = fakeCore();
  try {
    const controls = sessionCommands(core.api, newCanvasId(), 'member', core.topics, vi.fn());
    await controls.settingsOptions('codex');
    expect(settingsOptions).toHaveBeenCalledExactlyOnceWith('codex', 'member');
    settingsOptions.mockClear();
    await nativeQueries.options('codex');
    expect(settingsOptions).toHaveBeenCalledExactlyOnceWith('codex');
  } finally {
    core.dispose();
  }
});

it('completes files with one project.files read bound to the displayed canvas and agent', async () => {
  const core = fakeCore();
  const canvas = newCanvasId();
  core.respond('project.files', { items: ['src/index.ts'] });
  try {
    const controls = sessionCommands(core.api, canvas, 'member', core.topics, vi.fn());
    expect(await controls.findFiles?.('src/')).toEqual(['src/index.ts']);
    expectOneOp(core, 'project.files', { canvas, agent: 'member', query: 'src/' });
  } finally {
    core.dispose();
  }
});

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

it('keeps a handed-off manual message queued until the native user receipt arrives', () => {
  const message: MessageView = {
    id: crypto.randomUUID(),
    canvas: newCanvasId(),
    from: 'you',
    to: 'agent:a',
    kind: 'text',
    origin: 'manual',
    body: 'Then update the docs',
    at: 1,
    state: 'delivering',
    delivery: { as: 'native', at: 1, attempt: 1 },
  };
  const view = sessionView(AgentId.parse('a'), connection, { ...NEW_SESSION, status: 'waiting' });
  const shown = sessionDisplay(view.summary, view, [message]);
  expect(shown.queued).toEqual([{ id: message.id, text: message.body }]);
  expect(shown.submissions?.[0]?.status).toBe('queued');
  const received = sessionView(AgentId.parse('a'), connection, {
    ...NEW_SESSION,
    status: 'working',
    entries: [{ kind: 'user', id: 'native', text: message.body, reached: true }],
  });
  expect(sessionDisplay(received.summary, received, [message]).queued).toEqual([]);
});

it('shows a native manual turn still running without confusing its durable restart record for a live cancellation', () => {
  const message: MessageView = {
    id: crypto.randomUUID(),
    canvas: newCanvasId(),
    from: 'you',
    to: 'agent:a',
    kind: 'text',
    origin: 'manual',
    body: 'slow native turn',
    at: 1,
    state: 'unresolved',
    turn: { status: 'cancelled', reason: 'connection-closed' },
    delivery: { as: 'native', at: 1, attempt: 1 },
  };
  const live = sessionView(AgentId.parse('a'), connection, {
    ...NEW_SESSION,
    status: 'working',
    entries: [{ kind: 'user', id: 'native', text: message.body, reached: true }],
  });
  const shown = sessionDisplay(live.summary, live, [message]);
  expect(shown.submissions?.[0]).toMatchObject({ status: 'running' });
  expect(shown.submissions?.[0]?.unresolved).not.toBe(true);
  const stopped = sessionView(AgentId.parse('a'), connection, { ...NEW_SESSION });
  expect(sessionDisplay(stopped.summary, stopped, [message]).submissions?.[0]).toMatchObject({
    status: 'cancelled',
    unresolved: true,
  });
});

it('keeps a Try again startup refusal in its core session, while reporting other failures', async () => {
  const core = fakeCore();
  const failed = vi.fn();
  const open = vi.spyOn(core.api, 'sessionOpen');
  const controls = sessionCommands(core.api, newCanvasId(), 'a', core.topics, failed);
  open.mockRejectedValueOnce(
    new ApiError({ code: 'unavailable', sentence: 'Startup was refused.' }),
  );
  controls.open();
  await Promise.resolve();
  expect(failed).not.toHaveBeenCalled();
  const invalid = new ApiError({ code: 'not-found', sentence: 'The agent is gone.' });
  open.mockRejectedValueOnce(invalid);
  controls.open();
  await Promise.resolve();
  expect(failed).toHaveBeenCalledExactlyOnceWith(invalid);
  core.dispose();
});
