import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { GraphEditor } from './GraphEditor';
import { PADDING } from './graph';
import type { Graph, GraphNode } from './graph';

const item = (id: string, x: number, y: number, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  type: 'item',
  position: { x, y },
  data: { label: id },
  ...extra,
});

const frame: GraphNode = {
  id: 'F',
  type: 'frame',
  position: { x: 0, y: 0 },
  data: { label: 'Group 1' },
  width: 400,
  height: 300,
  measured: { width: 400, height: 300 },
};

function setup(initialGraph?: Graph) {
  const { container } = render(
    initialGraph ? <GraphEditor initialGraph={initialGraph} /> : <GraphEditor />,
  );
  const nodes = (selector = '.react-flow__node') => [
    ...container.querySelectorAll<HTMLElement>(selector),
  ];
  const node = (id: string) => {
    const element = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
    if (!element) throw new Error(`no node ${id}`);
    return element;
  };
  const pane = container.querySelector('.react-flow__pane');
  if (!pane) throw new Error('no pane');
  return { container, nodes, node, pane };
}

const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });
const labelInput = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Label' });
/** The actions shown for a node, group or selection. */
const actions = (id: string) => {
  const toolbar = document.querySelector<HTMLElement>(`.react-flow__node-toolbar[data-id="${id}"]`);
  if (!toolbar) throw new Error(`no actions for ${id}`);
  return within(toolbar);
};

describe('GraphEditor', () => {
  it('adds a node on double-click on the empty canvas', () => {
    const { nodes, pane } = setup();
    fireEvent.doubleClick(pane, { clientX: 200, clientY: 100 });
    expect(nodes().map((n) => n.textContent)).toEqual(['Node 1']);
  });

  it('adds a node inside a group when double-clicking its body', () => {
    const { nodes, pane } = setup({ nodes: [frame], edges: [] });
    // The frame's body lets the double-click through to the pane, as in the browser.
    fireEvent.doubleClick(pane, { clientX: 200, clientY: 150 });
    expect(nodes('.react-flow__node-frame.parent')).toHaveLength(1);
  });

  it('renames a node in place on F2: Enter keeps the text, Escape restores it', () => {
    const { node } = setup({ nodes: [item('a', 0, 0, { selected: true })], edges: [] });
    fireEvent.keyDown(document.body, { key: 'F2' });
    expect(document.activeElement).toBe(labelInput());
    fireEvent.change(labelInput(), { target: { value: 'Alpha' } });
    fireEvent.keyDown(labelInput(), { key: 'Enter' });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(node('a').textContent).toBe('Alpha');

    fireEvent.keyDown(document.body, { key: 'F2' });
    fireEvent.change(labelInput(), { target: { value: 'Beta' } });
    fireEvent.keyDown(labelInput(), { key: 'Escape' });
    expect(node('a').textContent).toBe('Alpha');
  });

  it('edits text instead of deleting while typing in a label', () => {
    const { nodes } = setup({ nodes: [item('a', 0, 0, { selected: true })], edges: [] });
    fireEvent.keyDown(document.body, { key: 'F2' });
    fireEvent.keyDown(labelInput(), { key: 'Backspace' });
    expect(nodes()).toHaveLength(1);
  });

  it('renames a group in place on a double-click on its label bar', () => {
    const { node } = setup({ nodes: [frame], edges: [] });
    fireEvent.doubleClick(node('F'));
    fireEvent.change(labelInput(), { target: { value: 'Team' } });
    fireEvent.keyDown(labelInput(), { key: 'Enter' });
    expect(node('F').textContent).toBe('Team');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a double-clicked node in a panel, where its queue is edited', () => {
    const { node, nodes } = setup({ nodes: [item('a', 0, 0), item('b', 0, 100)], edges: [] });
    fireEvent.doubleClick(node('a'));
    const panel = within(screen.getByRole('dialog', { name: 'a' }));
    const queued = () => panel.queryAllByRole('listitem').map((li) => li.textContent);
    fireEvent.click(panel.getByRole('button', { name: 'Add Placeholder B' }));
    fireEvent.click(panel.getByRole('button', { name: 'Add Placeholder A' }));
    expect(queued()).toEqual(['Placeholder B', 'Placeholder A']);
    fireEvent.click(panel.getByRole('button', { name: 'Remove Placeholder B' }));
    expect(queued()).toEqual(['Placeholder A']);

    // The graph's shortcuts are off while the panel is open; Escape closes it.
    fireEvent.keyDown(document.body, { key: 'Delete' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(nodes().map((n) => n.dataset.id)).toEqual(['a', 'b']);
    expect(node('a').querySelector('.graph-queue-count')?.getAttribute('data-count')).toBe('1');
  });

  it('opens only a double-clicked node that is part of a multi-selection', () => {
    const { node, nodes } = setup({
      nodes: [item('a', 0, 0, { selected: true }), item('b', 0, 100, { selected: true })],
      edges: [],
    });
    fireEvent.doubleClick(node('a'));
    expect(nodes('.react-flow__node.selected').map((n) => n.dataset.id)).toEqual(['a']);
    expect(screen.getByRole('dialog', { name: 'a' })).toBeTruthy();
  });

  it("groups a selection from its actions, and ungroups from the group's", () => {
    const { nodes } = setup({
      nodes: [item('a', 0, 0, { selected: true }), item('b', 0, 100, { selected: true })],
      edges: [],
    });
    fireEvent.click(actions('a b').getByRole('button', { name: 'Group' }));
    const [group] = nodes('.react-flow__node-frame');
    expect(group?.textContent).toBe('Group 1');
    expect(group?.classList.contains('selected')).toBe(true);

    const title = group?.querySelector('.graph-frame-title');
    if (!title) throw new Error('no title bar');
    fireEvent.mouseEnter(title);
    fireEvent.click(actions(group?.dataset.id ?? '').getByRole('button', { name: 'Ungroup' }));
    expect(nodes('.react-flow__node-frame')).toHaveLength(0);
    expect(nodes('.react-flow__node.selected').map((n) => n.dataset.id)).toEqual(['a', 'b']);
  });

  it('groups with the keyboard shortcut', () => {
    const { nodes } = setup({
      nodes: [item('a', 0, 0, { selected: true }), item('b', 0, 100, { selected: true })],
      edges: [],
    });
    fireEvent.keyDown(document.body, { key: 'g', code: 'KeyG', ctrlKey: true });
    expect(nodes('.react-flow__node-frame').map((n) => n.textContent)).toEqual(['Group 1']);
  });

  it("cannot group nodes from different groups, and the selection's Group button says why", () => {
    setup({
      nodes: [
        frame,
        item('a', 20, 52, { parentId: 'F', selected: true }),
        item('b', 500, 0, { selected: true }),
      ],
      edges: [],
    });
    const group = actions('a b').getByRole<HTMLButtonElement>('button', { name: 'Group' });
    expect(group.disabled).toBe(true);
    expect(group.title).toBe('Only nodes in the same group can be grouped');
  });

  it("gives a group a parent node from the '+' on its top border", () => {
    const { node, nodes } = setup({
      nodes: [frame, item('a', 20, 52, { parentId: 'F' })],
      edges: [],
    });
    fireEvent.click(button('Add a parent node'));
    expect(nodes('.react-flow__node-item.parent').map((n) => n.dataset.id)).toEqual(['F']);
    expect(node('F').textContent).toBe('Node 1');
    expect(node('F').classList.contains('selected')).toBe(true);
  });

  it("shows a node's actions on hover: Delete, and Remove from group inside a group", () => {
    const { node, nodes } = setup({
      nodes: [frame, item('a', 20, 52, { parentId: 'F' }), item('b', 500, 0)],
      edges: [],
    });
    const card = (id: string) => node(id).querySelector('.graph-card') ?? node(id);
    fireEvent.mouseEnter(card('a'));
    fireEvent.click(actions('a').getByRole('button', { name: 'Remove from group' }));
    expect(nodes('.react-flow__node.parent')).toHaveLength(0);

    fireEvent.mouseEnter(card('b'));
    fireEvent.click(actions('b').getByRole('button', { name: 'Delete' }));
    expect(nodes().map((n) => n.dataset.id)).toEqual(['F', 'a']);
  });

  it('deletes a selected edge from its button', () => {
    const { container } = setup({
      nodes: [item('a', 0, 0), item('b', 0, 100)],
      edges: [{ id: 'a->b', source: 'a', target: 'b', selected: true }],
    });
    fireEvent.click(button('Delete edge'));
    expect(container.querySelector('[data-testid="rf__edge-a->b"]')).toBeNull();
  });

  it('deletes a group but keeps its contents, and removes edges of deleted nodes', () => {
    const { container, nodes } = setup({
      nodes: [
        { ...frame, selected: true },
        item('a', 20, 52, { parentId: 'F' }),
        item('b', 500, 0, { selected: true }),
      ],
      edges: [{ id: 'a->b', source: 'a', target: 'b' }],
    });
    expect(container.querySelector('[data-testid="rf__edge-a->b"]')).not.toBeNull();
    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(nodes().map((n) => n.textContent)).toEqual(['a']);
    expect(container.querySelector('[data-testid="rf__edge-a->b"]')).toBeNull();
  });

  it('fits every container to its children when React Flow reports changes', () => {
    const { container } = setup({
      nodes: [
        { ...frame, id: 'H', width: 300, height: 300, measured: { width: 300, height: 300 } },
        {
          ...frame,
          id: 'G',
          parentId: 'H',
          position: { x: 20, y: 40 },
          width: 200,
          height: 200,
          measured: { width: 200, height: 200 },
        },
        item('c', 400, 50, { parentId: 'G' }),
      ],
      edges: [],
    });
    // React Flow measures c on mount; G must shrink around it and H around G.
    const width = (id: string) =>
      parseFloat(container.querySelector<HTMLElement>(`[data-id="${id}"]`)?.style.width ?? '');
    expect(width('G')).toBeLessThan(200);
    expect(width('H')).toBe(width('G') + 2 * PADDING);
  });

  it('names edges by the labels of their nodes, and follows renames', () => {
    const { container, node } = setup({
      nodes: [
        item('a', 0, 0, { data: { label: 'Alpha' } }),
        item('b', 0, 100, { data: { label: 'Beta' } }),
      ],
      edges: [{ id: 'a->b', source: 'a', target: 'b' }],
    });
    const edge = () => container.querySelector('[data-testid="rf__edge-a->b"]');
    expect(edge()?.getAttribute('aria-label')).toBe('Edge from Alpha to Beta');
    // Renamed in the panel a double-click opens.
    fireEvent.doubleClick(node('a'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Gamma' } });
    expect(screen.getByRole('dialog', { name: 'Gamma' })).toBeTruthy();
    expect(edge()?.getAttribute('aria-label')).toBe('Edge from Gamma to Beta');
  });
});
