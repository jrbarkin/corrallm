import { afterEach, expect, it, vi } from 'vitest';
import { newCanvasId } from '../../shared/canvas';
import { fakeCore } from '../test-api';
import {
  imagePreviews,
  keepPreview,
  MAX_PREVIEW_BYTES,
  nativeQueries,
  sessionCommands,
  sessionDisplay,
} from './sessions';
import { MAX_IMAGE_BYTES } from '../../shared/api/limits';
import { imageBytes } from '../../shared/session';
import { NEW_SESSION } from '../../shared/model/session';
import { sessionView } from '../../shared/model/views';
import type { MessageView } from '../../shared/model/views';
import { AgentId } from '../../shared/api/ids';
import { catalog } from '../catalog';
import { ApiError } from '../api/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useDisplayedSession } from './sessions';
import { expectOneOp, expectOneRead } from '../test-api';
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
    await waitFor(() => {
      expect(hook.result.current.entries).toHaveLength(1);
    });
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
      [
        'session.interrupt',
        {},
        () => {
          controls.stop();
        },
      ],
      [
        'session.setMode',
        { mode: 'plan' },
        () => {
          controls.setMode('plan');
        },
      ],
      [
        'session.setModel',
        { model: 'opus' },
        () => {
          controls.setModel('opus');
        },
      ],
      ['session.setEffort', { effort: null }, () => controls.setEffort?.(null)],
      ['session.stopTask', { task: 'task-1' }, () => controls.stopTask?.('task-1')],
      [
        'session.restart',
        {},
        () => {
          controls.restart();
        },
      ],
    ] as const) {
      core.operations.length = 0;
      gesture();
      await waitFor(() => {
        expectOneOp(core, op, { canvas, agent: 'a', ...args });
      });
    }
    core.operations.length = 0;
    core.respond('session.rewind', { conversation: true });
    await controls.rewind('native-message', 'conversation');
    expectOneOp(core, 'session.rewind', {
      canvas,
      agent: 'a',
      message: 'native-message',
      restore: 'conversation',
    });
    expect(failed).not.toHaveBeenCalled();
  } finally {
    core.dispose();
  }
});

it('reads options in the displayed agent’s workspace through one session.options read', async () => {
  const options = { models: [], defaults: { model: null, effort: null, mode: null } };
  const core = fakeCore();
  const canvas = newCanvasId();
  core.respond('session.options', options);
  try {
    const controls = sessionCommands(core.api, canvas, 'member', core.topics, vi.fn());
    expect(await controls.settingsOptions('codex')).toEqual(options);
    expectOneRead(core, 'session.options', { canvas, agent: 'member', adapter: 'codex' });
  } finally {
    core.dispose();
  }
});

it('lists MCP servers with one read, and changes one with one operation that answers them all', async () => {
  const core = fakeCore();
  const canvas = newCanvasId();
  const failed = { name: 'sentry', status: 'failed' as const, error: 'Connection refused' };
  const connected = { name: 'sentry', status: 'connected' as const, tools: 2 };
  core.respond('session.mcpServers', { items: [failed] });
  core.respond('session.changeMcpServer', { items: [connected], revs: {} });
  try {
    const controls = sessionCommands(core.api, canvas, 'member', core.topics, vi.fn());
    expect(await controls.mcpServers()).toEqual([failed]);
    expectOneRead(core, 'session.mcpServers', { canvas, agent: 'member' });
    expect(await controls.changeMcpServer('sentry', 'reconnect')).toEqual([connected]);
    expectOneOp(core, 'session.changeMcpServer', {
      canvas,
      agent: 'member',
      server: 'sentry',
      change: 'reconnect',
    });
  } finally {
    core.dispose();
  }
});

it('lists and resumes conversations as one operation each, for the displayed agent', async () => {
  const core = fakeCore();
  const canvas = newCanvasId();
  const item = {
    id: '6e2f8d4b-0c3a-4f7e-9b2d-4a5f6e7d8c9b',
    title: 'Earlier work',
    modified: 1,
    current: false,
  };
  core.respond('session.conversations', { items: [item] });
  try {
    const controls = sessionCommands(core.api, canvas, 'member', core.topics, vi.fn());
    expect(await controls.pastSessions()).toEqual([item]);
    expectOneRead(core, 'session.conversations', { canvas, agent: 'member' });
    await controls.resume(item.id);
    expectOneOp(core, 'session.resumeConversation', {
      canvas,
      agent: 'member',
      conversation: item.id,
    });
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
    expectOneRead(core, 'project.files', { canvas, agent: 'member', query: 'src/' });
  } finally {
    core.dispose();
  }
});

it('sends your message, its images too, as one message operation, and previews them in this window only', async () => {
  const core = fakeCore();
  const canvas = newCanvasId();
  const failed = vi.fn();
  const id = crypto.randomUUID();
  core.respond('message', { id });
  const controls = sessionCommands(core.api, canvas, 'a', core.topics, failed);
  const images = [{ mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' }];
  try {
    controls.send('Fix it', images);
    await waitFor(() => {
      expect(imagePreviews().get(id)).toEqual(images);
    });
    expectOneOp(core, 'message', { canvas, to: 'a', body: 'Fix it', images });
    // The transcript's entry shows them; the topic only ever counts them.
    const view = sessionView(AgentId.parse('a'), connection, {
      ...NEW_SESSION,
      entries: [{ kind: 'user', id: 'native-1', text: 'Fix it', images: [...images] }],
    });
    const message: MessageView = {
      id,
      canvas,
      from: 'you',
      to: 'agent:a',
      kind: 'text',
      body: 'Fix it',
      state: 'delivered',
      delivery: { at: 1, as: 'native-1', attempt: 1 },
      at: 1,
      origin: 'manual',
    };
    expect(view.entries['native-1']).toMatchObject({ images: 1 });
    expect(
      sessionDisplay(view.summary, view, [message], { images: imagePreviews() }).entries[0],
    ).toMatchObject({ images });
    expect(failed).not.toHaveBeenCalled();
  } finally {
    core.dispose();
  }
});

it('keeps only the newest pasted images’ previews, within its byte budget', () => {
  const big = 'A'.repeat(4 * Math.floor(MAX_IMAGE_BYTES / 3));
  const ids = Array.from({ length: Math.ceil(MAX_PREVIEW_BYTES / MAX_IMAGE_BYTES) + 2 }, () =>
    crypto.randomUUID(),
  );
  for (const id of ids) keepPreview(id, [{ mediaType: 'image/png', data: big }]);
  const kept = imagePreviews();
  expect(kept.has(ids.at(-1) ?? '')).toBe(true);
  expect(kept.has(ids[0] ?? '')).toBe(false);
  const bytes = [...kept.values()].flat().reduce((sum, { data }) => sum + imageBytes(data), 0);
  expect(bytes).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
});

it('takes back a queued message through one caller-checked withdraw operation', async () => {
  vi.stubGlobal('window', {
    api: { unqueueSession: vi.fn().mockResolvedValue({ ok: true, value: null }) },
  });
  const core = fakeCore();
  const canvas = newCanvasId();
  const id = crypto.randomUUID();
  try {
    sessionCommands(core.api, canvas, 'a', core.topics, vi.fn()).unqueue(id);
    await vi.waitFor(() => {
      expectOneOp(core, 'withdraw', { canvas, id });
    });
  } finally {
    core.dispose();
  }
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
  const { answerDraftFlushes, flushDrafts } = await import('../useDraft');
  const pending = Promise.withResolvers<undefined>();
  const core = fakeCore();
  core.reply('message', async () => {
    await pending.promise;
    return { ok: true, value: { id: crypto.randomUUID(), revs: {} } };
  });
  let flush: (() => Promise<void>) | undefined;
  const stop = answerDraftFlushes({
    draftsOnFlush: (answer) => {
      flush = answer;
      return () => undefined;
    },
  });
  try {
    sessionCommands(core.api, newCanvasId(), 'a', core.topics, vi.fn()).send('Keep it');
    // An operation's own draft flush never waits for it: a second send would not wait on it.
    await flushDrafts();
    let done = false;
    const flushing = flush?.().then(() => {
      done = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    pending.resolve(undefined);
    await flushing;
    expect(done).toBe(true);
  } finally {
    stop();
    core.dispose();
  }
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
