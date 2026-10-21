import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { automaticBackend } from '../../shared/engine/test-backend';
import type { RunCheckpoint, RunRestore } from '../../shared/run';
import { newCanvasId } from '../../shared/canvas';
import { EXAMPLES } from '../../shared/examples';
import { templateInfo } from '../../shared/templates';
import { api } from '../api/client';
import { catalog } from '../catalog';
import { DEFAULT_AGENT } from './agents';
import type { AgentNode } from '../../shared/model/canvas';
import type { RunSource } from '../run/persistence';
import { fakeCanvas } from '../test-canvas';
import { expectOneOp } from '../test-api';
import { events } from '../test-render';
import { GraphEditor } from './GraphEditor';

vi.mock('../terminal/screen', async () => ({
  createScreen: (await import('../terminal/test-screen')).fakeScreens.create,
}));

const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.spyOn(api, 'templatesList').mockResolvedValue({
    items: EXAMPLES.map((example) => templateInfo(example, catalog(), DEFAULT_AGENT)),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  cleanups.splice(0).forEach((stop) => {
    stop();
  });
});
function setup(saved = true) {
  const canvas = fakeCanvas({
    id: newCanvasId(),
    arrange: false,
    links: [],
    nodes: [{ id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Writer' } }],
  });
  if (saved) canvas.meta({ name: 'work.corral' });
  cleanups.push(() => {
    canvas.core.dispose();
  });
  render(
    <GraphEditor
      canvas={canvas.document.id}
      client={canvas.core.api}
      mirror={canvas.core.topics}
      files
    />,
  );
  return canvas;
}
const click = async (name: string) => {
  if (
    ['New', 'Open…', 'Save', 'Save as…'].includes(name) &&
    !screen.queryByRole('button', { name })
  )
    await events.click(screen.getByRole('button', { name: 'Canvas menu' }));
  await events.click(await screen.findByRole('button', { name }));
};
/** Opens the agent view of the canvas's one agent. */
const openWriter = async () => {
  await events.doubleClick(screen.getByText('Writer'));
};
const writer = (canvas: ReturnType<typeof fakeCanvas>) =>
  canvas.document.nodes.find((node): node is AgentNode => node.id === 'a' && node.type === 'agent');

it.each([
  ['Save', 'canvas.save', true],
  ['Save', 'canvas.saveAs', false],
  ['Save as…', 'canvas.saveAs', true],
  ['Choose a project folder', 'project.choose', true],
] as const)('%s calls only %s (saved=%s)', async (button, op, saved) => {
  const canvas = setup(saved);
  canvas.core.respond(op, op === 'project.choose' ? { project: null } : { name: null });
  await click(button);
  await waitFor(() => {
    expectOneOp(canvas.core, op, { canvas: canvas.document.id });
  });
});

it.each(['New', 'Open…'])('%s keeps edited work without a discard question', async (button) => {
  const canvas = setup();
  canvas.meta({ edited: true });
  const before = canvas.document.id;
  const op = button === 'New' ? 'canvas.create' : 'canvas.open';
  if (op === 'canvas.open')
    canvas.core.reply(op, () => {
      canvas.open({ id: newCanvasId(), arrange: false, nodes: [], links: [] });
      return Promise.resolve({ ok: true, value: { canvas: canvas.document.id, revs: {} } });
    });
  await click(button);
  expect(screen.queryByRole('alertdialog')).toBeNull();
  await waitFor(() => {
    expectOneOp(canvas.core, op, {});
  });
  await waitFor(() => {
    expect(screen.queryByText('Writer')).toBeNull();
  });
  expect(canvas.document.id).not.toBe(before);
  expect(screen.getByRole('status').textContent).toContain(
    'work.corral stays open with its changes.',
  );
});

it('a template’s New is one canvas.create, keeping edited work open as New and Open do', async () => {
  const canvas = setup();
  canvas.meta({ edited: true });
  const before = canvas.document.id;
  await click('Templates…');
  const gallery = within(await screen.findByRole('dialog', { name: 'Templates' }));
  await events.click(await gallery.findByRole('button', { name: /^Review loop/ }));
  await events.click(gallery.getByRole('button', { name: 'Create canvas' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  await waitFor(() => {
    expect(canvas.core.operations).toEqual([
      {
        op: 'canvas.create',
        args: expect.objectContaining({ template: expect.any(String) as unknown }) as unknown,
      },
    ]);
  });
  await waitFor(() => {
    expect(screen.queryByText('Writer')).toBeNull();
  });
  expect(canvas.document.id).not.toBe(before);
  expect(screen.getByText('Reviewer')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain(
    'work.corral stays open with its changes.',
  );
});

it('says nothing of the canvas before when it had no changes', async () => {
  const canvas = setup();
  await click('New');
  await waitFor(() => {
    expectOneOp(canvas.core, 'canvas.create', {});
  });
  await waitFor(() => {
    expect(screen.queryByText('Writer')).toBeNull();
  });
  expect(screen.queryByRole('status')).toBeNull();
});

it('a cancelled Open keeps the canvas and its selection', async () => {
  const canvas = setup();
  canvas.core.respond('canvas.open', { canvas: null });
  await click('Open…');
  await waitFor(() => {
    expectOneOp(canvas.core, 'canvas.open', {});
  });
  expect(screen.getByText('Writer')).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
});

it('a role draft commits as one agent.setRole and a refusal stays at the field', async () => {
  const canvas = setup();
  await openWriter();
  await click('Agent settings: Writer');
  const role = await screen.findByRole('textbox', { name: 'Role' });
  canvas.core.reply('agent.setRole', {
    ok: false,
    error: { code: 'unavailable', sentence: 'Not saved' },
  });
  await events.focus(role);
  await events.change(role, { target: { value: 'Review carefully' } });
  await events.blur(role);
  await waitFor(() => {
    expectOneOp(canvas.core, 'agent.setRole', {
      canvas: canvas.document.id,
      agent: 'a',
      role: 'Review carefully',
    });
  });
  expect(await screen.findByText('Not saved')).toBeTruthy();
  expect((role as HTMLTextAreaElement).value).toBe('Review carefully');
});

it.each([
  ['Claude · Agent SDK', 'agent.setConnection', { connection: 'claude-code.sdk' }],
  ['Codex · App Server', 'agent.setType', { adapter: 'codex', connection: 'codex.app-server' }],
] as const)('the agent chip chooses %s with one %s', async (choice, op, args) => {
  const canvas = setup();
  await openWriter();
  await click('Agent: Claude · Terminal');
  await events.click(await screen.findByRole('option', { name: new RegExp(`^${choice}`) }));
  await waitFor(() => {
    expectOneOp(canvas.core, op, { canvas: canvas.document.id, agent: 'a', ...args });
  });
  expect(await screen.findByRole('button', { name: `Agent: ${choice}` })).toBeTruthy();
});

it('the settings sheet’s chip changes the agent’s CLI with one agent.setType', async () => {
  const canvas = setup();
  await openWriter();
  await click('Agent settings: Writer');
  const sheet = await screen.findByRole('dialog', { name: 'Agent settings: Writer' });
  await events.click(within(sheet).getByRole('button', { name: 'Agent: Claude · Terminal' }));
  await events.click(await screen.findByRole('option', { name: /^Codex · Terminal/ }));
  await waitFor(() => {
    expectOneOp(canvas.core, 'agent.setType', {
      canvas: canvas.document.id,
      agent: 'a',
      adapter: 'codex',
      connection: 'codex.terminal',
    });
  });
  expect(writer(canvas)?.data).toMatchObject({ adapter: 'codex', connection: 'codex.terminal' });
});

it('a settings-sheet choice commits one agent.setSettings', async () => {
  const canvas = setup();
  await openWriter();
  await click('Agent settings: Writer');
  const sheet = await screen.findByRole('dialog', { name: 'Agent settings: Writer' });
  await events.click(within(sheet).getByRole('button', { name: /^Mode:/ }));
  await events.click(await screen.findByRole('menuitemradio', { name: /^Plan/ }));
  await waitFor(() => {
    expectOneOp(canvas.core, 'agent.setSettings', {
      canvas: canvas.document.id,
      agent: 'a',
      adapter: 'claude-code',
      settings: { model: null, effort: null, mode: 'plan' },
    });
  });
  expect(writer(canvas)?.data.settings?.['claude-code']?.mode).toBe('plan');
});

it('waits for the initial canvas mirror before reading run progress', async () => {
  const canvas = fakeCanvas({ id: newCanvasId(), arrange: false, nodes: [], links: [] });
  cleanups.push(() => {
    canvas.core.dispose();
  });
  const mirrored = Promise.withResolvers<undefined>();
  vi.spyOn(canvas.core.topics, 'whenAt').mockReturnValue(mirrored.promise);
  const get = vi.fn<RunSource['get']>(() =>
    Promise.resolve({
      id: canvas.document.id,
      token: 'run',
      checkpoint: null,
      notices: ['Restored from a snapshot.'],
    }),
  );
  render(
    <GraphEditor
      canvas={canvas.document.id}
      client={canvas.core.api}
      mirror={canvas.core.topics}
      runSource={{
        get,
        save: () => Promise.resolve(null),
        ready: () => Promise.resolve(null),
        onStopping: () => () => undefined,
      }}
    />,
  );
  await act(() => Promise.resolve());
  expect(get).not.toHaveBeenCalled();
  await act(() => {
    mirrored.resolve(undefined);
    return Promise.resolve();
  });
  await waitFor(() => {
    expect(get).toHaveBeenCalledOnce();
  });
  expect(await screen.findByText('Restored from a snapshot.')).toBeTruthy();
});

it('keeps a failed restore’s recovery after a cancelled Open, until New switches canvases', async () => {
  const canvas = fakeCanvas({ id: newCanvasId(), arrange: false, nodes: [], links: [] });
  cleanups.push(() => {
    canvas.core.dispose();
  });
  // The canvas shown can't be restored; the one a switch shows can.
  let restored = 0;
  render(
    <GraphEditor
      canvas={canvas.document.id}
      client={canvas.core.api}
      mirror={canvas.core.topics}
      files
      runSource={{
        get: () =>
          restored++ === 0
            ? Promise.reject(new Error('Unreadable journal'))
            : Promise.resolve({ id: canvas.document.id, token: 'new', checkpoint: null }),
        save: () => Promise.resolve(null),
        ready: () => Promise.resolve(null),
        onStopping: () => () => undefined,
      }}
    />,
  );
  expect(await screen.findByRole('toolbar', { name: 'Canvas recovery' })).toBeTruthy();
  // The Open dialog cancelled: still the canvas that could not be restored.
  await click('Open…');
  await waitFor(() => {
    expectOneOp(canvas.core, 'canvas.open', {});
  });
  expect(screen.getByRole('toolbar', { name: 'Canvas recovery' })).toBeTruthy();
  await click('New');
  await waitFor(() => {
    expect(screen.queryByRole('toolbar', { name: 'Canvas recovery' })).toBeNull();
  });
});

it('blocks input through a switch’s late restore, then preserves the next manual message', async () => {
  const canvas = fakeCanvas({ id: newCanvasId(), arrange: false, nodes: [], links: [] });
  cleanups.push(() => {
    canvas.core.dispose();
  });
  const initial = canvas.document.id,
    next = newCanvasId();
  const sessions = automaticBackend();
  const held = Promise.withResolvers<RunRestore>();
  const save = vi.fn<RunSource['save']>(() => Promise.resolve(null));
  let reads = 0;
  canvas.core.reply('canvas.open', () => {
    canvas.open({
      id: next,
      arrange: false,
      nodes: [
        {
          id: 'b',
          type: 'agent',
          position: { x: 0, y: 0 },
          data: { label: 'Fresh', adapter: 'claude-code', connection: 'claude-code.sdk' },
        },
      ],
      links: [],
    });
    return Promise.resolve({ ok: true, value: { canvas: next, revs: {} } });
  });
  const view = render(
    <GraphEditor
      canvas={initial}
      client={canvas.core.api}
      mirror={canvas.core.topics}
      sessionBackend={sessions.backend}
      runSource={{
        get: () =>
          ++reads === 1
            ? Promise.resolve({ id: initial, token: 'old', checkpoint: null })
            : held.promise,
        save,
        ready: () => Promise.resolve(null),
        onStopping: () => () => undefined,
      }}
    />,
  );
  await waitFor(() => {
    expect(save).toHaveBeenCalled();
  });
  await click('Open…');
  await waitFor(() => {
    expect(reads).toBe(2);
  });
  try {
    const root = view.container.querySelector('.graph-editor');
    expect(root?.hasAttribute('inert')).toBe(true);
    expect(root?.getAttribute('aria-busy')).toBe('true');
    await events.doubleClick(await screen.findByText('Fresh'));
    await events.keyDown(document.body, { key: 'n', ctrlKey: true });
    await events.keyDown(document.body, { key: 's', ctrlKey: true });
    expect(screen.queryByRole('dialog', { name: 'Fresh' })).toBeNull();
    expect(sessions.backend.start).not.toHaveBeenCalled();
    expectOneOp(canvas.core, 'canvas.open', {});
  } finally {
    await act(() => {
      held.resolve({ id: next, token: 'new', checkpoint: null });
      return Promise.resolve();
    });
  }
  await waitFor(() => {
    expect(view.container.querySelector('.graph-editor')?.hasAttribute('inert')).toBe(false);
  });
  await events.doubleClick(await screen.findByText('Fresh'));
  const input = await screen.findByRole('textbox', { name: 'Message Fresh' });
  await events.change(input, { target: { value: 'Sent after the switch' } });
  await events.keyDown(input, { key: 'Enter' });
  await waitFor(() => {
    expect(sessions.backend.send).toHaveBeenCalledOnce();
  });
  await waitFor(() => {
    expect(save).toHaveBeenLastCalledWith(
      'new',
      expect.objectContaining({
        messages: expect.stringContaining('Sent after the switch') as unknown,
      }),
    );
  });
  expect(sessions.backend.close).not.toHaveBeenCalledWith('b');
});

it.each(['cancelled', 'refused'] as const)(
  'a %s Open leaves a running queue and its turn unchanged',
  async (outcome) => {
    const canvas = fakeCanvas({
      id: newCanvasId(),
      arrange: false,
      nodes: [
        {
          id: 'a',
          type: 'agent',
          position: { x: 0, y: 0 },
          data: {
            label: 'A',
            connection: 'claude-code.sdk',
            queue: [{ id: 'work', message: 'Keep working' }],
          },
        },
      ],
      links: [],
    });
    cleanups.push(() => {
      canvas.core.dispose();
    });
    const id = canvas.document.id;
    const sessions = automaticBackend();
    // Keep this native turn open explicitly; the regression must not depend on a one-second timer.
    sessions.backend.send.mockImplementation((agent, message) => {
      sessions.emit(
        agent,
        'claude-code.sdk',
        { type: 'user', id: message.id, text: message.text },
        { type: 'status', status: 'working' },
      );
      return Promise.resolve(null);
    });
    const save = vi.fn<(_token: string, checkpoint: RunCheckpoint | null) => Promise<null>>(() =>
      Promise.resolve(null),
    );
    if (outcome === 'refused')
      canvas.core.reply('canvas.open', {
        ok: false,
        error: { code: 'invalid', sentence: 'Not a canvas' },
      });
    render(
      <GraphEditor
        canvas={id}
        client={canvas.core.api}
        mirror={canvas.core.topics}
        sessionBackend={sessions.backend}
        runSource={{
          get: () => Promise.resolve({ id, token: 'same', checkpoint: null }),
          save,
          ready: () => Promise.resolve(null),
          onStopping: () => () => undefined,
        }}
      />,
    );
    await waitFor(() => {
      expect(save).toHaveBeenCalled();
    });
    await click('Show all queues');
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    await events.click(queues.getByRole('button', { name: 'Run' }));
    await waitFor(() => {
      expect(sessions.backend.send).toHaveBeenCalledOnce();
    });
    const before = JSON.parse(save.mock.calls.at(-1)?.[1]?.state ?? '{}') as unknown;
    await events.click(queues.getByRole('button', { name: 'Back' }));
    await click('Open…');
    await waitFor(() => {
      expectOneOp(canvas.core, 'canvas.open', {});
    });
    if (outcome === 'refused')
      expect(await screen.findByRole('alert')).toHaveProperty(
        'textContent',
        expect.stringContaining('Not a canvas'),
      );
    expect(sessions.backend.interrupt).not.toHaveBeenCalled();
    expect(sessions.backend.close).not.toHaveBeenCalled();
    const after = JSON.parse(save.mock.calls.at(-1)?.[1]?.state ?? '{}') as unknown;
    expect(after).toEqual(before);
    expect(canvas.document.id).toBe(id);
  },
);
