import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { newCanvasId } from '../../shared/canvas';
import { EXAMPLES } from '../../shared/examples';
import { templateInfo } from '../../shared/templates';
import { api } from '../api/client';
import { catalog } from '../catalog';
import { DEFAULT_AGENT } from './agents';
import type { AgentNode } from '../../shared/model/canvas';
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
      sessionQueries={{
        ...canvas.queries,
        manual: canvas.manual,
        presentation: canvas.presentation,
      }}
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
const openWriter = async (canvas: ReturnType<typeof fakeCanvas>) => {
  await events.doubleClick(await screen.findByText('Writer'));
  expect(canvas.core.operations).toEqual([]);
  canvas.core.operations.length = 0;
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

it('the dock opens Start without changing the current canvas', async () => {
  const canvas = setup();
  canvas.meta({ edited: true });
  await events.click(screen.getByRole('button', { name: 'Start a session' }));
  expect(screen.getByRole('dialog', { name: 'Start a session' })).toBeTruthy();
  expect(canvas.core.operations).toEqual([]);
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
  await openWriter(canvas);
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
  ['Claude · Agent SDK', 'session.continueIn', { connection: 'claude-code.sdk' }],
  ['Codex · App Server', 'agent.setType', { adapter: 'codex', connection: 'codex.app-server' }],
] as const)('the agent chip chooses %s with one %s', async (choice, op, args) => {
  const canvas = setup();
  await openWriter(canvas);
  await click('Agent: Claude · Terminal');
  await events.click(await screen.findByRole('option', { name: new RegExp(`^${choice}`) }));
  await waitFor(() => {
    expectOneOp(canvas.core, op, { canvas: canvas.document.id, agent: 'a', ...args });
  });
  expect(await screen.findByRole('button', { name: `Agent: ${choice}` })).toBeTruthy();
});

it('the settings sheet’s chip changes the agent’s CLI with one agent.setType', async () => {
  const canvas = setup();
  await openWriter(canvas);
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
  await openWriter(canvas);
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

it.each(['cancelled', 'refused'] as const)(
  'a %s Open leaves the core run unchanged',
  async (outcome) => {
    const canvas = fakeCanvas({ id: newCanvasId(), arrange: false, nodes: [], links: [] });
    cleanups.push(() => {
      canvas.core.dispose();
    });
    const before = canvas.engine.run.snapshot();
    if (outcome === 'refused')
      canvas.core.reply('canvas.open', {
        ok: false,
        error: { code: 'invalid', sentence: 'Not a canvas' },
      });
    const view = render(
      <GraphEditor
        canvas={canvas.document.id}
        client={canvas.core.api}
        mirror={canvas.core.topics}
        sessionQueries={{
          ...canvas.queries,
          manual: canvas.manual,
          presentation: canvas.presentation,
        }}
        files
      />,
    );
    await waitFor(() => {
      expect(view.container.querySelector('.graph-editor')?.hasAttribute('inert')).toBe(false);
    });
    await click('Open…');
    expectOneOp(canvas.core, 'canvas.open', {});
    if (outcome === 'refused')
      expect((await screen.findByRole('alert')).textContent).toContain('Not a canvas');
    expect(canvas.engine.run.snapshot()).toBe(before);
  },
);
