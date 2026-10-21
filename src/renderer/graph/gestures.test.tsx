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
import type { QueueItem } from '../../shared/model/queue';
import type { CanvasDocument } from '../../shared/model/canvas';
import { toFile } from '../../shared/model/file';
import { absolutePosition } from '../../shared/model/geometry';
import { move } from '../../shared/model/structure';
import { OPS } from '../../shared/api/registry';
import { fakeCanvas } from '../test-canvas';
import { expectOneOp } from '../test-api';
import { GraphEditor } from './GraphEditor';

const seen = vi.hoisted(() => ({
  props: undefined as ComponentProps<typeof ReactFlow> | undefined,
  fits: [] as unknown[],
  nodeLists: [] as NonNullable<ComponentProps<typeof ReactFlow>['nodes']>[],
}));
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof XYFlow>();
  const { useCallback } = await import('react');
  return {
    ...actual,
    useReactFlow: () => {
      const flow = actual.useReactFlow();
      const originalFit = flow.fitView;
      const fitView = useCallback(
        (options: Parameters<typeof originalFit>[0]) => {
          seen.fits.push(options);
          return originalFit(options);
        },
        [originalFit],
      );
      return { ...flow, fitView };
    },
    ReactFlow: (props: ComponentProps<typeof ReactFlow>) => {
      seen.props = props;
      if (props.nodes) seen.nodeLists.push(props.nodes);
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
  seen.fits = [];
  seen.nodeLists = [];
});
function setup({
  arrange = false,
  group = false,
  linked = false,
  selected = ['a', 'b'],
  approval = false,
  files = false,
  empty = false,
  restored = false,
  project = false,
  queue = [] as QueueItem[],
} = {}) {
  const doc: CanvasDocument = {
    id: newCanvasId(),
    arrange,
    nodes: empty
      ? []
      : [
          ...(group
            ? [
                {
                  id: 'F',
                  type: 'frame' as const,
                  position: { x: 0, y: 0 },
                  data: { label: 'Group' },
                },
              ]
            : []),
          ...['a', 'b'].map((id, i) => ({
            id,
            type: 'agent' as const,
            position: { x: i * 220 + 20, y: 52 },
            ...(group ? { parentId: 'F' } : {}),
            data: {
              label: id,
              ...(id === 'a'
                ? { queue: approval ? [{ id: 'ok', approve: 'Review' }] : queue }
                : {}),
            },
          })),
        ],
    links: linked ? [{ source: 'a', target: 'b' }] : [],
  };
  const canvas = fakeCanvas(doc);
  if (project) canvas.meta({ project: { name: 'Old project', path: '/old/project' } });
  cleanups.push(() => {
    canvas.core.dispose();
  });
  const save = vi.fn(() => Promise.resolve({ ok: true as const, value: { name: null, revs: {} } }));
  canvas.core.reply('canvas.saveAs', save);
  const view = render(
    <GraphEditor
      canvas={doc.id}
      client={canvas.core.api}
      mirror={canvas.core.topics}
      initialSelection={{ nodes: new Set(selected), edges: new Set() }}
      {...(restored
        ? {
            runSource: {
              get: () => Promise.resolve({ id: doc.id, token: 'test', checkpoint: null }),
              save: () => Promise.resolve(null),
              ready: () => Promise.resolve(null),
              onStopping: () => () => undefined,
            },
          }
        : {})}
      files={files}
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
const button = (name: string | RegExp) => {
  if (
    typeof name === 'string' &&
    ['New', 'Open…', 'Save', 'Save as…'].includes(name) &&
    !screen.queryByRole('button', { name })
  )
    fireEvent.click(screen.getByRole('button', { name: 'Canvas menu' }));
  return screen.getByRole('button', { name });
};
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
  // Includes its first projection and the selected copy when add's promise resolves, before
  // ResizeObserver necessarily runs. Later observations may supply different dimensions.
  for (const nodes of seen.nodeLists)
    for (const node of nodes) {
      expect(node.measured?.width).toBeGreaterThan(0);
      expect(node.measured?.height).toBeGreaterThan(0);
    }
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
    view.node('a').querySelector('.adapter-logo') ??
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
  fireEvent.click(button('Needs you'));
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

it('keeps a dropped child where it was dropped while the mirror holds the move that refits its group', async () => {
  const view = setup({ group: true, selected: ['a'] });
  // The core's commit reaches the mirror before the move resolves (its topic batch, or a reply
  // that waits for its write), and the overlay is cleared only once the move resolves.
  const held = Promise.withResolvers<undefined>();
  view.core.reply('canvas.move', async (raw) => {
    const rev = await view.edit(
      toFile(move(view.document, OPS['canvas.move'].input.parse(raw)).next),
      view.rev,
    );
    await held.promise;
    return { ok: true, value: { revs: { [`canvas:${view.canvas}`]: rev } } };
  });
  const shown = (nodes: XYFlow.Node[]) => {
    const byId = new Map(
      nodes.map(({ id, position, parentId }) => [
        id,
        { id, position, data: { label: id }, ...(parentId === undefined ? {} : { parentId }) },
      ]),
    );
    const at = (id: string) => {
      const node = byId.get(id);
      if (!node) throw new Error(`No ${id}`);
      return absolutePosition(node, byId);
    };
    return { a: at('a'), b: at('b'), frame: at('F') };
  };
  // Past the group's top-left corner: the group grows up and left once the card is dropped.
  const dropped = { x: -100, y: -60 };
  act(() => {
    seen.props?.onNodesChange?.([{ id: 'a', type: 'position', position: dropped, dragging: true }]);
  });
  act(() => {
    seen.props?.onNodesChange?.([
      { id: 'a', type: 'position', position: dropped, dragging: false },
    ]);
  });
  const shownA = seen.props?.nodes?.find((one) => one.id === 'a');
  if (!shownA) throw new Error('No dragged node');
  const fromDrop = seen.nodeLists.length - 1;
  // React Flow's own dragged node, placed in its parent as the drag left it.
  const node = { ...shownA, position: dropped };
  act(() => {
    seen.props?.onNodeDragStop?.({} as MouseEvent, node, [node]);
  });
  await waitFor(() => {
    expect(view.document.nodes.find((one) => one.id === 'F')?.position).toEqual({
      x: -120,
      y: -112,
    });
  });
  await waitFor(() => {
    expect(seen.props?.nodes && shown(seen.props.nodes).frame).toEqual({ x: -120, y: -112 });
  });
  held.resolve(undefined);
  await waitFor(() => {
    expect(seen.props?.nodes?.find((one) => one.id === 'a')).not.toHaveProperty('dragging', false);
  });
  // Every view since the drop agrees: the overlay's, then the mirror's under the overlay, then
  // the mirror's alone.
  for (const nodes of seen.nodeLists.slice(fromDrop))
    expect(shown(nodes)).toEqual({ a: dropped, b: { x: 240, y: 52 }, frame: { x: -120, y: -112 } });
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
  expect(view.save).toHaveBeenCalledWith({ canvas: view.canvas });
  expect(view.document.nodes[0]?.data.label).toBe('After');
});

it('does not leave a viewport fit queued for the first node of an empty restored canvas', async () => {
  const view = setup({ empty: true, selected: [], restored: true });
  await act(() => Promise.resolve());
  expect(seen.fits).toEqual([]);
  const pane = view.container.querySelector('.react-flow__pane');
  if (!pane) throw new Error('No pane');
  fireEvent.doubleClick(pane, { clientX: 300, clientY: 200 });
  await called(view.core);
  expect(view.document.nodes[0]?.position).toEqual({ x: 207, y: 164 });
  expect(seen.fits).toEqual([]);
  fireEvent.doubleClick(pane, { clientX: 650, clientY: 380 });
  await waitFor(() => {
    expect(view.document.nodes).toHaveLength(2);
  });
  expect(view.core.operations.map(({ op }) => op)).toEqual(['canvas.addAgent', 'canvas.addAgent']);
});

it('keeps nested group cards inside the new frame through a reparenting operation', async () => {
  const doc: CanvasDocument = { id: newCanvasId(), arrange: false, links: [], nodes: [] };
  const canvas = fakeCanvas(doc);
  cleanups.push(() => {
    canvas.core.dispose();
  });
  const view = render(
    <GraphEditor canvas={doc.id} client={canvas.core.api} mirror={canvas.core.topics} />,
  );
  const flow = view.container.querySelector<HTMLElement>('.react-flow');
  if (!flow) throw new Error('No flow');
  vi.spyOn(flow, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 800));
  const pane = view.container.querySelector('.react-flow__pane');
  if (!pane) throw new Error('No pane');
  const pointer = (type: string, x: number, y: number) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
    });
    Object.defineProperties(event, {
      isPrimary: { value: true },
      pointerId: { value: 1 },
      pointerType: { value: 'mouse' },
    });
    fireEvent(pane, event);
  };
  const group = async (ids: string[]) => {
    const boxes = ids.map((id) => {
      const element = view.container.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${id}"]`,
      );
      if (!element) throw new Error(`No ${id}`);
      const match = /translate\(([-.\d]+)px,\s*([-.\d]+)px\)/.exec(element.style.transform);
      if (!match) throw new Error(element.style.transform);
      return {
        x: Number(match[1]),
        y: Number(match[2]),
        width: element.offsetWidth,
        height: element.offsetHeight,
      };
    });
    pointer(
      'pointerdown',
      Math.min(...boxes.map((b) => b.x)) - 30,
      Math.min(...boxes.map((b) => b.y)) - 30,
    );
    pointer(
      'pointermove',
      Math.max(...boxes.map((b) => b.x + b.width)) + 30,
      Math.max(...boxes.map((b) => b.y + b.height)) + 30,
    );
    pointer(
      'pointerup',
      Math.max(...boxes.map((b) => b.x + b.width)) + 30,
      Math.max(...boxes.map((b) => b.y + b.height)) + 30,
    );
    expect(seen.props?.nodes?.filter((n) => n.selected).map((n) => n.id)).toEqual(
      expect.arrayContaining(ids),
    );
    const prior = new Set(canvas.document.nodes.map((n) => n.id));
    const count = canvas.core.operations.length;
    fireEvent.keyDown(document.body, { key: 'g', ctrlKey: true });
    await waitFor(() => {
      expect(canvas.core.operations.length).toBeGreaterThan(count);
    });
    await act(() => Promise.resolve());
    const made = canvas.document.nodes.find((n) => n.type === 'frame' && !prior.has(n.id));
    if (!made) throw new Error('Grouping made no frame');
    return made.id;
  };
  const add = async (x: number, y: number) => {
    const before = canvas.document.nodes.length;
    fireEvent.doubleClick(pane, { clientX: x, clientY: y });
    await waitFor(() => {
      expect(canvas.document.nodes).toHaveLength(before + 1);
    });
    await act(() => Promise.resolve());
    const node = canvas.document.nodes.at(-1);
    if (!node) throw new Error('No added agent');
    return node.id;
  };
  const a = await add(300, 200);
  const b = await add(300, 320);
  const first = await group([a, b]);
  const c = await add(700, 200);
  const d = await add(700, 320);
  const second = await group([c, d]);
  const outer = await group([first, second]);
  const box = (id: string) => {
    const node = view.container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
    if (!node) throw new Error(`No ${id}`);
    const match = /translate\(([-.\d]+)px,\s*([-.\d]+)px\)/.exec(node.style.transform);
    if (!match) throw new Error(node.style.transform);
    return { x: Number(match[1]), y: Number(match[2]) };
  };
  for (const inner of [first, second]) {
    expect(seen.props?.nodes?.find((n) => n.id === inner)?.parentId).toBe(outer);
    expect(box(inner).x).toBeGreaterThan(box(outer).x);
    expect(box(inner).y).toBeGreaterThan(box(outer).y);
  }
});

it('creates a template as the new canvas, retaining its node ids and choosing a fresh project', async () => {
  const example = EXAMPLES[0];
  if (!example) throw new Error('No template');
  const template = templateInfo(example, catalog(), 'claude-code');
  vi.spyOn(api, 'templatesList').mockResolvedValue({ items: [template] });
  const view = setup({ files: true, project: true });
  expect(button('Project folder: Old project')).toBeDefined();
  fireEvent.click(button('Templates…'));
  const gallery = within(await screen.findByRole('dialog', { name: 'Templates' }));
  fireEvent.click(await gallery.findByRole('button', { name: new RegExp(`^${example.name}`) }));
  const agents: Record<string, string> = {},
    connections: Record<string, string> = {};
  for (const role of template.agents) {
    const adapter = gallery.getByRole<HTMLSelectElement>('combobox', {
      name: `${role.name}'s agent`,
    }).value;
    if (adapter) agents[role.id] = adapter;
    connections[role.id] = gallery.getByRole<HTMLSelectElement>('combobox', {
      name: `How ${role.name} runs`,
    }).value;
  }
  fireEvent.click(gallery.getByRole('button', { name: 'Create canvas' }));
  await called(view.core);
  expectOneOp(view.core, 'canvas.create', {
    template: template.id,
    values: Object.fromEntries(template.fields.map((field) => [field.key, field.example])),
    agents,
    connections,
  });
  await waitFor(() => {
    expect(view.document.id).not.toBe(view.canvas);
  });
  expect(view.document.nodes.every((node) => node.type === 'agent')).toBe(true);
  expect(view.document.nodes.map((node) => node.id)).toEqual(
    template.agents.map((agent) => agent.id),
  );
  expect(button('Choose a project folder')).toBeDefined();
});

it('saves the core’s live document with one operation after a concurrent edit', async () => {
  const view = setup({ files: true });
  view.save.mockImplementationOnce(async () => {
    await view.edit(
      toFile({
        ...view.document,
        nodes: view.document.nodes.map((node) =>
          node.id === 'a' ? { ...node, data: { ...node.data, label: 'Core edit' } } : node,
        ),
      }),
      view.rev,
    );
    return { ok: true, value: { name: null, revs: {} } };
  });
  fireEvent.click(button('Save'));
  await waitFor(() => {
    expect(view.save).toHaveBeenCalledOnce();
  });
  expectOneOp(view.core, 'canvas.saveAs', { canvas: view.canvas });
  expect(view.document.nodes[0]?.data.label).toBe('Core edit');
});

it('adds a queue step with one op and renders its core id', async () => {
  const view = setup();
  fireEvent.doubleClick(view.node('a'));
  fireEvent.click(button('Add to queue'));
  fireEvent.click(screen.getByRole('option', { name: /^Read / }));
  fireEvent.click(screen.getByRole('option', { name: 'This agent' }));
  await called(view.core);
  expectOneOp(view.core, 'queue.add', {
    canvas: view.canvas,
    agent: 'a',
    entry: { action: 'Read' },
  });
  const row = await screen.findByRole('button', { name: 'Move Read' });
  expect(row.closest('[data-item]')?.getAttribute('data-item')).toBe(
    view.document.nodes[0]?.type === 'agent'
      ? view.document.nodes[0].data.queue?.[0]?.id
      : undefined,
  );
});
it('removes a queue row with one op', async () => {
  const view = setup({ queue: [{ id: 'work', action: 'Read' }] });
  fireEvent.doubleClick(view.node('a'));
  fireEvent.click(button('Remove Read'));
  await called(view.core);
  expectOneOp(view.core, 'queue.remove', { canvas: view.canvas, agent: 'a', item: 'work' });
});
it('commits a queue message draft with one op', async () => {
  const view = setup({ queue: [{ id: 'work', message: 'Before' }] });
  fireEvent.doubleClick(view.node('a'));
  const field = screen.getByRole('textbox', { name: 'Message to the agent' });
  fireEvent.focus(field);
  fireEvent.change(field, { target: { value: 'After' } });
  expect(view.core.operations).toEqual([]);
  fireEvent.blur(field);
  await called(view.core);
  expectOneOp(view.core, 'queue.update', {
    canvas: view.canvas,
    agent: 'a',
    item: 'work',
    change: { kind: 'message', message: 'After' },
  });
  await waitFor(() => {
    expect((field as HTMLTextAreaElement).value).toBe('After');
  });
});
it.each(['message', 'instruction'] as const)(
  'keeps a refused queue %s draft with its field error',
  async (kind) => {
    const entry =
      kind === 'message'
        ? { id: 'work', message: 'Before' }
        : { id: 'work', action: 'Read', instruction: 'Before' };
    const view = setup({ queue: [entry] });
    view.core.reply('queue.update', {
      ok: false,
      error: { code: 'refused', sentence: 'Held by the run.' },
    });
    fireEvent.doubleClick(view.node('a'));
    const field = screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: kind === 'message' ? 'Message to the agent' : 'What Read is to do',
    });
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: 'Keep this draft' } });
    fireEvent.blur(field);
    await called(view.core);
    const row = field.closest<HTMLElement>('.graph-queue-row');
    if (!row) throw new Error('No queue row');
    await waitFor(() => {
      expect(within(row).getByRole('alert').textContent).toBe('Held by the run.');
    });
    expect(field.value).toBe('Keep this draft');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expectOneOp(view.core, 'queue.update', {
      canvas: view.canvas,
      agent: 'a',
      item: 'work',
      change:
        kind === 'message'
          ? { kind, message: 'Keep this draft' }
          : { kind, instruction: 'Keep this draft' },
    });
  },
);
it.each(['agent', 'All queues'] as const)('sends one queue.move at drop from %s', async (where) => {
  const view = setup({
    queue: [
      { id: 'first', action: 'Read' },
      { id: 'second', action: 'Bash' },
      { id: 'third', action: 'Edit' },
    ],
  });
  if (where === 'agent') fireEvent.doubleClick(view.node('a'));
  else fireEvent.click(button('Show all queues'));
  const boxes = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      const all =
        where === 'agent'
          ? [...view.container.querySelectorAll('.graph-queue > li')]
          : [...view.container.querySelectorAll('.queues-cell[data-lane="a"]')];
      const top = all.findIndex((row) => row === this) * 40;
      return { top, bottom: top + 40, height: 40 } as DOMRect;
    });
  fireEvent.pointerDown(button('Move Read'), { button: 0 });
  fireEvent.pointerMove(window, { clientY: 115 });
  fireEvent.pointerMove(window, { clientY: 45 });
  expect(view.core.operations).toEqual([]);
  fireEvent.pointerUp(window);
  await called(view.core);
  expectOneOp(view.core, 'queue.move', {
    canvas: view.canvas,
    agent: 'a',
    item: 'first',
    before: 'third',
  });
  await waitFor(() => {
    const node = view.document.nodes.find((node) => node.id === 'a');
    expect(node?.type === 'agent' ? node.data.queue?.map((item) => item.id) : []).toEqual([
      'second',
      'first',
      'third',
    ]);
  });
  boxes.mockRestore();
});

it('drops by the previewed neighbour when another writer inserts a row during the drag', async () => {
  const view = setup({
    queue: [
      { id: 'first', action: 'Read' },
      { id: 'second', action: 'Bash' },
      { id: 'third', action: 'Edit' },
    ],
  });
  fireEvent.doubleClick(view.node('a'));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const rows = [...view.container.querySelectorAll('.graph-queue > li')];
    const top = rows.findIndex((row) => row === this) * 40;
    return { top, bottom: top + 40, height: 40 } as DOMRect;
  });
  fireEvent.pointerDown(button('Move Read'), { button: 0 });
  fireEvent.pointerMove(window, { clientY: 115 });
  fireEvent.pointerMove(window, { clientY: 45 });
  const next = {
    ...view.document,
    nodes: view.document.nodes.map((node) =>
      node.id === 'a' && node.type === 'agent'
        ? {
            ...node,
            data: {
              ...node.data,
              queue: [{ id: 'incoming', action: 'Read' }, ...(node.data.queue ?? [])],
            },
          }
        : node,
    ),
  };
  await act(async () => {
    await view.edit(toFile(next), view.rev);
  });
  fireEvent.pointerUp(window);
  await called(view.core);
  expectOneOp(view.core, 'queue.move', {
    canvas: view.canvas,
    agent: 'a',
    item: 'first',
    before: 'third',
  });
});
