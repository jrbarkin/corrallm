import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type * as XYFlow from '@xyflow/react';
import type { ReactFlow } from '@xyflow/react';
import { api } from '../api/client';
import { EXAMPLES } from '../../shared/examples';
import { templateInfo } from '../../shared/templates';
import { catalog } from '../catalog';
import { newCanvasId } from '../../shared/canvas';
import type { CanvasDocument } from '../../shared/model/canvas';
import { toFile } from '../../shared/model/file';
import { fakeCanvas } from '../test-canvas';
import { expectOneOp } from '../test-api';
import { GraphEditor } from './GraphEditor';

const seen = vi.hoisted(() => ({
  props: undefined as ComponentProps<typeof ReactFlow> | undefined,
}));
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof XYFlow>();
  return {
    ...actual,
    ReactFlow: (props: ComponentProps<typeof ReactFlow>) => {
      seen.props = props;
      return <actual.ReactFlow {...props} />;
    },
  };
});
vi.mock('../terminal/screen', async () => ({
  createScreen: (await import('../terminal/test-screen')).fakeScreens.create,
}));
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((stop) => {
    stop();
  });
  vi.restoreAllMocks();
});
function setup({
  arrange = false,
  group = false,
  linked = false,
  selected = ['a', 'b'],
  approval = false,
  files = false,
} = {}) {
  const doc: CanvasDocument = {
    id: newCanvasId(),
    arrange,
    nodes: [
      ...(group
        ? [{ id: 'F', type: 'frame' as const, position: { x: 0, y: 0 }, data: { label: 'Group' } }]
        : []),
      ...['a', 'b'].map((id, i) => ({
        id,
        type: 'agent' as const,
        position: { x: i * 220 + 20, y: 52 },
        ...(group ? { parentId: 'F' } : {}),
        data: {
          label: id,
          ...(approval && id === 'a' ? { queue: [{ id: 'ok', approve: 'Review' }] } : {}),
        },
      })),
    ],
    links: linked ? [{ source: 'a', target: 'b' }] : [],
  };
  const canvas = fakeCanvas(doc);
  cleanups.push(() => {
    canvas.core.dispose();
  });
  const save = vi.fn(() => Promise.resolve(null));
  const view = render(
    <GraphEditor
      canvas={doc.id}
      client={canvas.core.api}
      mirror={canvas.core.topics}
      initialSelection={{ nodes: new Set(selected), edges: new Set() }}
      {...(files
        ? {
            files: {
              open: () => Promise.resolve(null),
              save,
              forget: () => Promise.resolve(newCanvasId()),
            },
          }
        : {})}
    />,
  );
  return {
    ...view,
    save,
    core: canvas.core,
    edit: (text: string, rev: number) => canvas.edit(text, rev),
    get document() {
      return canvas.document;
    },
    get rev() {
      return canvas.rev;
    },
    canvas: doc.id,
    node: (id: string) => {
      const node = view.container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
      if (!node) throw new Error(`No ${id}`);
      return node;
    },
  };
}
const button = (name: string | RegExp) => screen.getByRole('button', { name });
async function called(core: ReturnType<typeof fakeCanvas>['core']) {
  await waitFor(() => {
    expect(core.operations).toHaveLength(1);
  });
}

it('adds with one operation and uses the id from the core', async () => {
  const view = setup({ selected: [] });
  const pane = view.container.querySelector('.react-flow__pane');
  if (!pane) throw new Error('No pane');
  fireEvent.doubleClick(pane, { clientX: 100, clientY: 200 });
  await called(view.core);
  expectOneOp(view.core, 'canvas.addAgent', {
    canvas: view.canvas,
    adapter: 'claude-code',
    at: { x: expect.any(Number) as unknown, y: expect.any(Number) as unknown },
  });
  await waitFor(() => {
    expect(view.container.querySelectorAll('.react-flow__node-agent')).toHaveLength(3);
  });
});
it('renames with one operation', async () => {
  const view = setup({ selected: ['a'] });
  fireEvent.keyDown(document.body, { key: 'F2' });
  const label = await screen.findByRole('textbox', { name: 'Label' });
  fireEvent.change(label, { target: { value: 'Renamed' } });
  fireEvent.blur(label);
  await called(view.core);
  expectOneOp(view.core, 'canvas.rename', { canvas: view.canvas, node: 'a', label: 'Renamed' });
});
it.each([
  ['group', false, false, 'frame'],
  ['groupUnderParent', false, true, 'agent'],
  ['ungroup', true, false, undefined],
] as const)('sends one %s operation', async (command, shiftKey, altKey, kind) => {
  const view = setup({
    group: command === 'ungroup',
    selected: command === 'ungroup' ? ['F'] : ['a', 'b'],
  });
  fireEvent.keyDown(document.body, { key: 'g', ctrlKey: true, shiftKey, altKey });
  await called(view.core);
  if (kind)
    expectOneOp(view.core, 'canvas.group', { canvas: view.canvas, nodes: ['a', 'b'], kind });
  else expectOneOp(view.core, 'canvas.ungroup', { canvas: view.canvas, nodes: ['F'] });
});
it('deletes with one operation and shows cleared queue references', async () => {
  const view = setup({ selected: ['a'] });
  view.core.respond('canvas.delete', { cleared: ['b’s wait no longer waits for a.'], revs: {} });
  fireEvent.keyDown(document.body, { key: 'Delete' });
  await called(view.core);
  expectOneOp(view.core, 'canvas.delete', { canvas: view.canvas, nodes: ['a'], links: [] });
  expect((await screen.findByRole('status')).textContent).toContain(
    'b’s wait no longer waits for a.',
  );
});
it('adds a parent with one operation', async () => {
  const view = setup({ group: true, selected: [] });
  fireEvent.click(button('Add a parent agent'));
  await called(view.core);
  expectOneOp(view.core, 'canvas.addParent', { canvas: view.canvas, frame: 'F' });
});
it('links with one operation', async () => {
  const view = setup();
  act(() => {
    seen.props?.onConnect?.({
      source: 'a',
      target: 'b',
      sourceHandle: 'bottom',
      targetHandle: 'top',
    });
  });
  fireEvent.click(button(/Let them talk/));
  await called(view.core);
  expectOneOp(view.core, 'canvas.link', {
    canvas: view.canvas,
    a: 'a',
    b: 'b',
    dots: ['bottom', 'top'],
  });
});
it('unlinks with one operation', async () => {
  const view = setup({ linked: true });
  act(() => {
    seen.props?.onEdgesChange?.([{ id: 'a->b', type: 'select', selected: true }]);
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Delete link' }));
  await called(view.core);
  expectOneOp(view.core, 'canvas.unlink', { canvas: view.canvas, a: 'a', b: 'b' });
});
it('sends no move during a drag and one move at drop', async () => {
  const view = setup({ selected: ['a'] });
  act(() => {
    seen.props?.onNodesChange?.([
      { id: 'a', type: 'position', position: { x: 700, y: 800 }, dragging: true },
    ]);
  });
  expect(view.core.operations).toEqual([]);
  expect(view.document.nodes[0]?.position).toEqual({ x: 20, y: 52 });
  const node = seen.props?.nodes?.find((node) => node.id === 'a');
  if (!node) throw new Error('No dragged node');
  act(() => {
    seen.props?.onNodeDragStop?.({} as MouseEvent, node, [node]);
  });
  await called(view.core);
  expectOneOp(view.core, 'canvas.move', {
    canvas: view.canvas,
    moves: [{ node: 'a', position: { x: 700, y: 800 } }],
  });
});
it('toggles Arrange with one operation', async () => {
  const view = setup();
  fireEvent.click(button('Arrange automatically'));
  await called(view.core);
  expectOneOp(view.core, 'canvas.setArrange', { canvas: view.canvas, on: true });
});
it.each(['delete', 'ungroup'] as const)(
  'keeps Arrange through %s without editing selection into the document',
  async (what) => {
    const view = setup({
      arrange: true,
      group: what === 'ungroup',
      selected: what === 'ungroup' ? ['F'] : ['a'],
    });
    fireEvent.keyDown(
      document.body,
      what === 'delete' ? { key: 'Delete' } : { key: 'g', ctrlKey: true, shiftKey: true },
    );
    await called(view.core);
    await waitFor(() => {
      expect(button('Arrange automatically').getAttribute('aria-pressed')).toBe('true');
    });
    expect(view.document.arrange).toBe(true);
    expect(view.document.nodes.every((node) => !('selected' in node))).toBe(true);
  },
);

it.each(['peer', 'linked'] as const)('spawns a %s with one operation', async (relation) => {
  const view = setup();
  fireEvent.doubleClick(view.node('a'));
  const dialog = within(await screen.findByRole('dialog', { name: 'a' }));
  if (relation === 'peer') fireEvent.click(dialog.getByRole('button', { name: 'New agent' }));
  else {
    fireEvent.click(dialog.getByRole('button', { name: 'Ways to add an agent' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New agent, linked to a' }));
  }
  await called(view.core);
  expectOneOp(view.core, 'canvas.spawnAgent', { canvas: view.canvas, from: 'a', relation });
});
it('inserts the chosen shipped template with one operation and core-minted ids', async () => {
  const example = EXAMPLES[0];
  if (!example) throw new Error('No template');
  const template = templateInfo(example, catalog(), 'claude-code');
  vi.spyOn(api, 'templatesList').mockResolvedValue({ items: [template] });
  const view = setup({ files: true });
  fireEvent.click(button('Templates…'));
  const gallery = within(await screen.findByRole('dialog', { name: 'Templates' }));
  fireEvent.click(await gallery.findByRole('button', { name: new RegExp(`^${example.name}`) }));
  const agents = Object.fromEntries(
    template.agents.map((role) => [
      role.id,
      gallery.getByRole<HTMLSelectElement>('combobox', { name: `${role.name}'s agent` }).value ||
        null,
    ]),
  );
  const connections = Object.fromEntries(
    template.agents.map((role) => [
      role.id,
      document.querySelector<HTMLSelectElement>(`#template-connection-${role.id}`)?.value,
    ]),
  );
  // The form's labelled connection selectors are the explicit choices sent to the core.
  for (const role of template.agents) {
    const select = gallery.getByRole<HTMLSelectElement>('combobox', {
      name: `How ${role.name} runs`,
    });
    connections[role.id] = select.value;
  }
  fireEvent.click(gallery.getByRole('button', { name: 'Insert into this canvas' }));
  await called(view.core);
  expectOneOp(view.core, 'canvas.insertTemplate', {
    canvas: view.canvas,
    template: template.id,
    values: Object.fromEntries(template.fields.map((field) => [field.key, field.example])),
    agents,
    connections,
  });
  await waitFor(() => {
    expect(view.document.nodes.length).toBe(3 + template.agents.length);
  });
  expect(
    view.document.nodes.some((node) => template.agents.some((role) => role.id === node.id)),
  ).toBe(false);
});
it('keeps Arrange when deleting an unselected agent from its controls', async () => {
  const view = setup({ arrange: true, selected: ['b'] });
  fireEvent.mouseEnter(
    view.node('a').querySelector('.graph-agent') ??
      view.node('a').firstElementChild ??
      view.node('a'),
  );
  const toolbar = await waitFor(() => {
    const node = document.querySelector('.react-flow__node-toolbar[data-id="a"]');
    if (!node) throw new Error('No toolbar');
    return node as HTMLElement;
  });
  fireEvent.click(within(toolbar).getByRole('button', { name: 'Delete' }));
  await called(view.core);
  expect(view.document.arrange).toBe(true);
  expect(view.core.operations[0]).toMatchObject({ op: 'canvas.delete', args: { nodes: ['a'] } });
});
it('keeps Arrange when opening an agent from Needs, without a document operation', async () => {
  const view = setup({ arrange: true, approval: true, selected: ['b'] });
  fireEvent.click(button('Show all queues'));
  fireEvent.click(button('Run'));
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(button('Back'));
  fireEvent.click(await screen.findByRole('button', { name: 'Open a' }));
  expect(await screen.findByRole('dialog', { name: 'a' })).toBeTruthy();
  expect(view.document.arrange).toBe(true);
  expect(view.core.operations).toEqual([]);
});
it('keeps an untouched rendered node object when another queue changes', async () => {
  const view = setup();
  const before = seen.props?.nodes?.find((node) => node.id === 'b');
  await act(async () => {
    await view.edit(
      JSON.stringify({
        format: 'corrallm',
        version: 2,
        id: view.canvas,
        nodes: [
          {
            id: 'a',
            kind: 'agent',
            label: 'a',
            position: { x: 20, y: 52 },
            queue: [{ id: 'work', message: 'Changed' }],
          },
          { id: 'b', kind: 'agent', label: 'b', position: { x: 240, y: 52 } },
        ],
        links: [],
      }),
      view.rev,
    );
  });
  expect(seen.props?.nodes?.find((node) => node.id === 'b')).toBe(before);
});

it('removes a rejected drag overlay so the view returns to the mirror', async () => {
  const view = setup({ selected: ['a'] });
  view.core.reply('canvas.move', {
    ok: false,
    error: { code: 'refused', sentence: 'The move was refused.' },
  });
  act(() => {
    seen.props?.onNodesChange?.([
      { id: 'a', type: 'position', position: { x: 700, y: 800 }, dragging: true },
    ]);
  });
  const node = seen.props?.nodes?.find((node) => node.id === 'a');
  if (!node) throw new Error('No a');
  act(() => {
    seen.props?.onNodeDragStop?.({} as MouseEvent, node, [node]);
  });
  await screen.findByRole('alert');
  expect(seen.props?.nodes?.find((node) => node.id === 'a')?.position).toEqual({ x: 20, y: 52 });
});
it('writes one move for a keyboard position change, without waiting for a drag stop', async () => {
  const view = setup({ selected: ['a'] });
  act(() => {
    seen.props?.onNodesChange?.([{ id: 'a', type: 'position', position: { x: 25, y: 52 } }]);
  });
  await called(view.core);
  expectOneOp(view.core, 'canvas.move', {
    canvas: view.canvas,
    moves: [{ node: 'a', position: { x: 25, y: 52 } }],
  });
});

it('waits for a label operation and its mirror before saving from the file button', async () => {
  const view = setup({ files: true, selected: ['a'] });
  const held = Promise.withResolvers<undefined>();
  view.core.reply('canvas.rename', async () => {
    await held.promise;
    const next = {
      ...view.document,
      nodes: view.document.nodes.map((node) =>
        node.id === 'a' ? { ...node, data: { ...node.data, label: 'After' } } : node,
      ),
    };
    const rev = await view.edit(toFile(next), view.rev);
    return { ok: true, value: { revs: { [`canvas:${view.canvas}`]: rev } } };
  });
  fireEvent.keyDown(document.body, { key: 'F2' });
  const label = await screen.findByRole('textbox', { name: 'Label' });
  fireEvent.change(label, { target: { value: 'After' } });
  fireEvent.blur(label);
  await called(view.core);
  fireEvent.click(button('Save'));
  await act(() => Promise.resolve());
  try {
    expect(view.save).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      held.resolve(undefined);
      await held.promise;
    });
  }
  await waitFor(() => {
    expect(view.save).toHaveBeenCalledOnce();
  });
  expect(view.save).toHaveBeenCalledWith(toFile(view.document), false, view.rev);
  expect(view.document.nodes[0]?.data.label).toBe('After');
});
