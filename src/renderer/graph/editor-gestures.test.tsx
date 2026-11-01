// Canvas gestures whose outcome is an operation, or none, and not a drawn geometry: selection,
// renaming, deleting, links, groups of groups, Arrange, panning and the floats. They drive the
// editor by role and label against the fake core (test-canvas.ts); e2e/graph.e2e.ts keeps what a
// real window alone can show (drag geometry, animations, CSS under the production CSP).
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type * as XYFlow from '@xyflow/react';
import type { ReactFlow } from '@xyflow/react';
import { newCanvasId } from '../../shared/canvas';
import type { CanvasDocument, CanvasNode, Link } from '../../shared/model/canvas';
import { arrange } from '../../shared/model/layout';
import { fakeCanvas } from '../test-canvas';
import { renderReady } from '../test-render';
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
// jsdom cannot draw xterm.js: a fake terminal stands in for a Terminal agent's (test-screen.ts).
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

const agent = (id: string, x: number, y: number, parentId?: string): CanvasNode => ({
  id,
  type: 'agent',
  position: { x, y },
  ...(parentId === undefined ? {} : { parentId }),
  data: { label: id },
});
const frame = (id: string, x: number, y: number, color: number): CanvasNode => ({
  id,
  type: 'frame',
  position: { x, y },
  data: { label: id, color },
});

/** The `buttons` bit a held mouse button sets, by its `button` number. */
const BUTTONS = [1, 4, 2];

async function setup({
  nodes = [agent('a', 20, 52), agent('b', 240, 52)],
  links = [] as Link[],
  selected = [] as string[],
  edges = [] as string[],
  arranged = false,
  files = false,
}: {
  nodes?: CanvasNode[];
  links?: Link[];
  selected?: string[];
  edges?: string[];
  arranged?: boolean;
  files?: boolean;
} = {}) {
  const doc: CanvasDocument = { id: newCanvasId(), arrange: arranged, nodes, links };
  const canvas = fakeCanvas(doc);
  cleanups.push(() => {
    canvas.core.dispose();
  });
  const view = await renderReady(
    <GraphEditor
      canvas={doc.id}
      client={canvas.core.api}
      mirror={canvas.core.topics}
      initialSelection={{ nodes: new Set(selected), edges: new Set(edges) }}
      files={files}
    />,
  );
  const flow = view.container.querySelector<HTMLElement>('.react-flow');
  const pane = view.container.querySelector<HTMLElement>('.react-flow__pane');
  if (!flow || !pane) throw new Error('No flow');
  // React Flow places a selection box and a pan by the canvas's box, which jsdom does not lay out.
  vi.spyOn(flow, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 800));
  const node = (id: string) => {
    const element = view.container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
    if (!element) throw new Error(`No ${id}`);
    return element;
  };
  /**
   * One pointer event as a mouse sends it. React Flow's selection box hears pointer events on the
   * pane; d3-zoom, its pan, hears a mouse press there and follows the move on the window.
   */
  const press = (type: string, x: number, y: number, button = 0) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button,
      buttons: type.endsWith('up') ? 0 : (BUTTONS[button] ?? 0),
    });
    // jsdom refuses its window as the event's view, which d3-zoom follows the drag on.
    Object.defineProperty(event, 'view', { value: window });
    if (type.startsWith('pointer'))
      Object.defineProperties(event, {
        isPrimary: { value: true },
        pointerId: { value: 1 },
        pointerType: { value: 'mouse' },
      });
    fireEvent(type === 'mousemove' || type === 'mouseup' ? window : pane, event);
  };
  return {
    ...view,
    core: canvas.core,
    canvas: doc.id,
    get document() {
      return canvas.document;
    },
    pane,
    node,
    press,
    /** A click on empty canvas: a press and release where it was pressed. */
    clickPane: (x = 900, y = 700) => {
      act(() => {
        press('pointerdown', x, y);
        press('mousedown', x, y);
        press('pointerup', x, y);
        press('mouseup', x, y);
        fireEvent.click(pane, { clientX: x, clientY: y });
      });
    },
    label: (id: string) => node(id).querySelector('.graph-label')?.textContent,
    selected: () =>
      [...view.container.querySelectorAll<HTMLElement>('.react-flow__node.selected')].map(
        (element) => element.dataset.id,
      ),
    /** Where React Flow draws a node, in canvas coordinates (its inline transform). */
    at: (id: string) => {
      const match = /translate\(([-.\d]+)px,\s*([-.\d]+)px\)/.exec(node(id).style.transform);
      if (!match) throw new Error(node(id).style.transform);
      return { x: Number(match[1]), y: Number(match[2]) };
    },
    viewport: () =>
      view.container.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform,
  };
}

/** The operations' arrival: a gesture's write is asynchronous. */
async function called(core: ReturnType<typeof fakeCanvas>['core']) {
  await waitFor(() => {
    expect(core.operations).toHaveLength(1);
  });
}

it('selects by click and Shift-click, and clears on a click on the canvas, writing nothing', async () => {
  const view = await setup();
  fireEvent.click(view.node('a'));
  // React Flow hears Shift held (multiSelectionKeyCode) from the key itself, as a real press sends.
  fireEvent.keyDown(document, { key: 'Shift' });
  fireEvent.click(view.node('b'), { shiftKey: true });
  fireEvent.keyUp(document, { key: 'Shift' });
  await waitFor(() => {
    expect(view.selected()).toEqual(['a', 'b']);
  });
  view.clickPane();
  await waitFor(() => {
    expect(view.selected()).toEqual([]);
  });
  // Clicking one alone replaces the selection.
  fireEvent.click(view.node('a'));
  fireEvent.click(view.node('b'));
  await waitFor(() => {
    expect(view.selected()).toEqual(['b']);
  });
  await act(() => Promise.resolve());
  expect(view.core.operations).toEqual([]);
});

it('renames the selected node on F2 and Enter, with one operation', async () => {
  const view = await setup({ selected: ['a'] });
  fireEvent.keyDown(document.body, { key: 'F2' });
  const label = await screen.findByRole('textbox', { name: 'Label' });
  expect(document.activeElement).toBe(label);
  fireEvent.change(label, { target: { value: 'Alpha' } });
  fireEvent.keyDown(label, { key: 'Enter' });
  await called(view.core);
  expectOneOp(view.core, 'canvas.rename', { canvas: view.canvas, node: 'a', label: 'Alpha' });
  await waitFor(() => {
    expect(view.label('a')).toBe('Alpha');
  });
});

it('edits only the text on Backspace while renaming, and Escape restores the label, writing nothing', async () => {
  const view = await setup({ selected: ['b'] });
  fireEvent.keyDown(document.body, { key: 'F2' });
  const label = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Label' });
  fireEvent.keyDown(label, { key: 'Backspace' });
  fireEvent.change(label, { target: { value: '' } });
  expect(label.value).toBe('');
  expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(2);
  fireEvent.keyDown(label, { key: 'Escape' });
  await waitFor(() => {
    expect(screen.queryByRole('textbox', { name: 'Label' })).toBeNull();
  });
  expect(view.label('b')).toBe('b');
  await act(() => Promise.resolve());
  expect(view.core.operations).toEqual([]);
});

it.each(['Delete', 'hover'] as const)('deletes a node by %s, one operation', async (how) => {
  const view = await setup({ selected: how === 'Delete' ? ['a'] : [] });
  if (how === 'Delete') fireEvent.keyDown(document.body, { key: 'Delete' });
  else {
    fireEvent.mouseEnter(view.node('a').querySelector('.graph-card') ?? view.node('a'));
    const toolbar = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('.react-flow__node-toolbar[data-id="a"]');
      if (!found) throw new Error('No actions');
      return found;
    });
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Delete' }));
  }
  await called(view.core);
  expectOneOp(view.core, 'canvas.delete', {
    canvas: view.canvas,
    nodes: ['a'],
    ...(how === 'Delete' ? { links: [] } : {}),
  });
  await waitFor(() => {
    expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(1);
  });
});

it('asks nothing for a self-loop: React Flow is told it is no connection', async () => {
  await setup();
  const valid = seen.props?.isValidConnection;
  if (!valid) throw new Error('No connection check');
  const ends = { sourceHandle: 'bottom', targetHandle: 'top' };
  expect(valid({ source: 'a', target: 'a', ...ends })).toBe(false);
  expect(valid({ source: 'a', target: 'b', ...ends })).toBe(true);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it.each(['button', 'Backspace'] as const)(
  'selects a clicked link and removes it by its %s, one operation',
  async (how) => {
    const view = await setup({ links: [{ source: 'a', target: 'b' }] });
    const link = view.container.querySelector<HTMLElement>('[data-testid="rf__edge-a->b"]');
    if (!link) throw new Error('No link');
    fireEvent.click(link);
    await waitFor(() => {
      expect(link.classList.contains('selected')).toBe(true);
    });
    if (how === 'button')
      fireEvent.click(await screen.findByRole('button', { name: 'Delete link' }));
    else fireEvent.keyDown(document.body, { key: 'Backspace' });
    await called(view.core);
    // Its own button unlinks it; Backspace deletes the selection, which is the link alone.
    if (how === 'button')
      expectOneOp(view.core, 'canvas.unlink', { canvas: view.canvas, a: 'a', b: 'b' });
    else
      expectOneOp(view.core, 'canvas.delete', {
        canvas: view.canvas,
        nodes: [],
        links: [{ a: 'a', b: 'b' }],
      });
    await waitFor(() => {
      expect(view.container.querySelector('[data-testid="rf__edge-a->b"]')).toBeNull();
    });
    expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(2);
  },
);

it('groups two groups in a third, which takes a parent that links like any agent, one operation each', async () => {
  const view = await setup({
    nodes: [
      frame('F1', 0, 0, 0),
      agent('a', 20, 52, 'F1'),
      agent('b', 20, 152, 'F1'),
      frame('F2', 400, 0, 1),
      agent('c', 20, 52, 'F2'),
      agent('d', 20, 152, 'F2'),
      agent('e', 300, 500),
    ],
    selected: ['F1', 'F2'],
  });
  // Each group colours its nodes, in a colour of its own.
  const color = (id: string) => /group-color-(\d+)/.exec(view.node(id).className)?.[1];
  expect(color('a')).toBe(color('b'));
  expect(color('c')).not.toBe(color('a'));

  fireEvent.keyDown(document.body, { key: 'g', ctrlKey: true });
  await called(view.core);
  expectOneOp(view.core, 'canvas.group', {
    canvas: view.canvas,
    nodes: ['F1', 'F2'],
    kind: 'frame',
  });
  const outer = await waitFor(() => {
    const made = view.document.nodes.find((node) => node.type === 'frame' && !node.parentId);
    if (!made || made.id === 'F1' || made.id === 'F2') throw new Error('No outer group');
    return made.id;
  });
  await waitFor(() => {
    expect(
      view.document.nodes.filter((node) => node.parentId === outer).map(({ id }) => id),
    ).toEqual(['F1', 'F2']);
  });

  view.core.operations.length = 0;
  fireEvent.mouseEnter(view.node(outer).querySelector('.graph-frame-title') ?? view.node(outer));
  fireEvent.click(within(view.node(outer)).getByRole('button', { name: 'Add a parent agent' }));
  await called(view.core);
  expectOneOp(view.core, 'canvas.addParent', { canvas: view.canvas, frame: outer });
  await waitFor(() => {
    expect(view.node(outer).classList.contains('parent')).toBe(true);
    expect(view.node(outer).classList.contains('react-flow__node-agent')).toBe(true);
  });

  view.core.operations.length = 0;
  act(() => {
    seen.props?.onConnect?.({
      source: outer,
      target: 'e',
      sourceHandle: 'bottom',
      targetHandle: 'top',
    });
  });
  fireEvent.click(await screen.findByRole('button', { name: /^Let them talk/ }));
  await called(view.core);
  expectOneOp(view.core, 'canvas.link', {
    canvas: view.canvas,
    a: outer,
    b: 'e',
    dots: ['bottom', 'top'],
  });
});

it('draws an agent added while Arranging where the arrangement puts it, from one operation', async () => {
  const view = await setup({
    nodes: [agent('a', 650, 450), agent('b', 300, 150), agent('c', 900, 200)],
    links: [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'c' },
    ],
    arranged: true,
  });
  fireEvent.doubleClick(view.pane, { clientX: 150, clientY: 560 });
  await called(view.core);
  expectOneOp(view.core, 'canvas.addAgent', {
    canvas: view.canvas,
    adapter: 'claude-code',
    at: { x: expect.any(Number) as unknown, y: expect.any(Number) as unknown },
  });
  await waitFor(() => {
    expect(view.document.nodes).toHaveLength(4);
  });
  // The core commits the arranged positions (core/ops/canvas-structure.test.ts); the view draws
  // every node, the new one included, where they put it.
  const expected = arrange(view.document).nodes.map(({ id, position }) => ({ id, ...position }));
  await waitFor(() => {
    expect(view.document.nodes.map(({ id }) => ({ id, ...view.at(id) }))).toEqual(expected);
  });
  // Arranged nodes stay put: React Flow is told none is draggable.
  for (const { id } of view.document.nodes)
    expect(view.node(id).classList.contains('draggable')).toBe(false);
});

it('selects with a left drag on empty canvas; a right or middle drag, or Space and a left drag, pans; none writes', async () => {
  const view = await setup();
  // A drag as Chromium sends it: each pointer event, then its mouse event.
  const drag = (button: number, [x0, y0]: [number, number], [x1, y1]: [number, number]) => {
    act(() => {
      view.press('pointerdown', x0, y0, button);
      view.press('mousedown', x0, y0, button);
      for (const step of [0.5, 1]) {
        const [x, y] = [x0 + (x1 - x0) * step, y0 + (y1 - y0) * step];
        view.press('pointermove', x, y, button);
        view.press('mousemove', x, y, button);
      }
      view.press('pointerup', x1, y1, button);
      view.press('mouseup', x1, y1, button);
    });
  };
  const start = view.viewport();
  expect(start).toBeTruthy();

  // A left drag around both agents (the view fits them in, the first just past its left edge)
  // selects them and leaves the view where it was.
  drag(0, [-200, -200], [900, 700]);
  await waitFor(() => {
    expect(view.selected()).toEqual(['a', 'b']);
  });
  expect(view.viewport()).toBe(start);

  let previous = start;
  for (const button of [2, 1]) {
    drag(button, [300, 300], [400, 350]);
    await waitFor(() => {
      expect(view.viewport()).not.toBe(previous);
    });
    previous = view.viewport();
  }

  fireEvent.keyDown(document, { key: ' ', code: 'Space' });
  drag(0, [300, 300], [350, 400]);
  fireEvent.keyUp(document, { key: ' ', code: 'Space' });
  await waitFor(() => {
    expect(view.viewport()).not.toBe(previous);
  });
  await act(() => Promise.resolve());
  expect(view.core.operations).toEqual([]);
});

it('keeps three floats and no React Flow controls, its commands behind the canvas menu', async () => {
  const view = await setup({ files: true });
  for (const name of ['Canvas file', 'Run controls', 'Canvas zoom'])
    expect(screen.getByRole('toolbar', { name })).toBeTruthy();
  expect(view.container.querySelector('.react-flow__controls')).toBeNull();
  expect(screen.queryByRole('button', { name: 'New' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Canvas menu' }));
  expect(screen.getByRole('button', { name: 'New' })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('button', { name: 'New' }), { key: 'Escape' });
  await waitFor(() => {
    expect(screen.queryByRole('dialog', { name: 'Canvas menu' })).toBeNull();
  });
  const zoom = within(screen.getByRole('toolbar', { name: 'Canvas zoom' }));
  fireEvent.click(zoom.getByRole('button', { name: 'Arrange automatically' }));
  await called(view.core);
  expectOneOp(view.core, 'canvas.setArrange', { canvas: view.canvas, on: true });
  await waitFor(() => {
    expect(
      zoom.getByRole('button', { name: 'Arrange automatically' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });
});
