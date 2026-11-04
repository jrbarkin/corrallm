import { within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionDescriptor } from '../../shared/adapter';
import { expectOneOp } from '../test-api';
import { events } from '../test-render';
import type { SessionEvent } from '../../shared/session';
import { made, open, settle } from './test-agent-view';

// jsdom cannot draw xterm.js: a fake terminal stands in.
vi.mock('../terminal/screen', async () => {
  const { fakeScreens } = await import('../terminal/test-screen');
  return { createScreen: fakeScreens.create };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/*
 * The live controls an unfamiliar connection declares (`live`), offered only where its ready
 * generation's features say they work: a model's efforts, a task's Stop.
 */

const MODEL_WITH_EFFORTS = {
  value: 'm',
  label: 'Model M',
  efforts: [
    { value: 'low', label: 'Low' },
    { value: 'high', label: 'High' },
  ],
};
const started = (extra: Partial<Extract<SessionEvent, { type: 'started' }>>): SessionEvent => ({
  type: 'started',
  role: 'append',
  resume: true,
  list: true,
  model: null,
  mode: null,
  models: [],
  ...extra,
});
const STARTED_MODELS = started({ model: 'm', models: [MODEL_WITH_EFFORTS] });
const TASKS = {
  type: 'tasks' as const,
  tasks: [{ id: 't1', description: 'Survey the code', kind: 'agent' as const }],
};

const withLive = (live: ConnectionDescriptor['live']) =>
  made((connections) => {
    const acp = connections['zed.acp'];
    if (!acp) throw new Error('The fixture needs its connection.');
    acp.live = live;
  });

const effort = (view: {
  queryByRole: (role: 'button', o: { name: RegExp }) => HTMLElement | null;
}) => view.queryByRole('button', { name: /^Effort: / });
const strip = (view: { queryByRole: (role: 'group', o: { name: string }) => HTMLElement | null }) =>
  view.queryByRole('group', { name: 'Background tasks' });

describe('a declared live control', () => {
  it('is absent until its generation is ready, then offered', async () => {
    const { view, emit } = await open('zed.acp', withLive({ effort: true, stopTask: true }));
    emit(TASKS);
    expect(strip(view)).toBeNull();
    emit(STARTED_MODELS);
    expect(effort(view)).not.toBeNull();
    expect(strip(view)).not.toBeNull();
  });

  it('is absent when its report was refused, though the session shows models and tasks', async () => {
    const { view, emit } = await open('zed.acp', withLive({ effort: true, stopTask: true }));
    // A report that can't be read leaves the generation without features.
    emit({ ...STARTED_MODELS, role: 'bogus' } as unknown as SessionEvent, TASKS);
    expect(effort(view)).toBeNull();
    expect(strip(view)).toBeNull();
    expect(view.queryByRole('button', { name: /^Stop Survey/ })).toBeNull();
  });

  it('is absent where the connection doesn’t declare it, however the session looks', async () => {
    const { view, emit } = await open('zed.acp', withLive({ effort: false, stopTask: false }));
    emit(STARTED_MODELS, TASKS);
    expect(effort(view)).toBeNull();
    expect(strip(view)).toBeNull();
  });

  it('offers effort without Stop where only effort is declared', async () => {
    const first = await open('zed.acp', withLive({ effort: true, stopTask: false }));
    first.emit(STARTED_MODELS, TASKS);
    expect(effort(first.view)).not.toBeNull();
    expect(strip(first.view)).toBeNull();
  });

  it('offers Stop without effort where only Stop is declared', async () => {
    const { view, emit } = await open('zed.acp', withLive({ effort: false, stopTask: true }));
    emit(STARTED_MODELS, TASKS);
    expect(effort(view)).toBeNull();
    expect(strip(view)).not.toBeNull();
  });

  it('offers no effort for a model that has none to choose', async () => {
    const { view, emit } = await open('zed.acp', withLive({ effort: true, stopTask: true }));
    emit(started({ model: 'm', models: [{ value: 'm', label: 'Plain' }] }));
    expect(effort(view)).toBeNull();
  });

  it('sets the effort as one session.setEffort operation', async () => {
    const { view, emit, canvas, since } = await open(
      'zed.acp',
      withLive({ effort: true, stopTask: true }),
    );
    emit(STARTED_MODELS);
    const sent = since();
    await events.click(effort(view) ?? document.body);
    await events.click(view.getByRole('menuitemradio', { name: /^High/ }));
    await settle();
    expectOneOp(sent, 'session.setEffort', {
      canvas: canvas.document.id,
      agent: 'a',
      effort: 'high',
    });
  });

  it('stops a task as one session.stopTask operation, naming its id', async () => {
    const { view, emit, canvas, since } = await open(
      'zed.acp',
      withLive({ effort: true, stopTask: true }),
    );
    emit(STARTED_MODELS, TASKS);
    const sent = since();
    await events.click(
      within(strip(view) ?? document.body).getByRole('button', { name: 'Stop Survey the code' }),
    );
    await settle();
    expectOneOp(sent, 'session.stopTask', { canvas: canvas.document.id, agent: 'a', task: 't1' });
  });
});
