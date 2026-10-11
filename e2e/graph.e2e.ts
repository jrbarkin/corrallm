import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';

import { launchApp } from './launch';

interface Point {
  x: number;
  y: number;
}

/** Height of a frame's title bar and a container's padding (src/renderer/graph/graph.ts). */
const HEADER = 32;
const PADDING = 20;

let app: ElectronApplication;
let closeApp: () => Promise<void>;
let page: Page;
let problems: string[];

test.beforeEach(async () => {
  ({ app, close: closeApp } = await launchApp());
  page = await app.firstWindow();
  problems = [];
  // Warnings too: the only React Flow diagnostic left in a production build is a console.warn
  // ("Parent node … not found": a child placed before its parent in the nodes array).
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      problems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    problems.push(error.message);
  });
  // Reload so that errors during page load (e.g. CSP violations) are collected too.
  await page.waitForLoadState('load');
  await page.reload();
  await expect(pane()).toBeVisible();
  // The tests use fixed canvas offsets that need the 1200×800 window at page zoom 1.
  const { width, height } = await box(pane());
  expect(
    width >= 1100 && height >= 640,
    `the canvas must be at least 1100×640 CSS px, but is ${String(width)}×${String(height)}`,
  ).toBe(true);
});

test.afterEach(async () => {
  await closeApp();
  expect(problems).toEqual([]);
});

const pane = () => page.locator('.react-flow__pane');
const nodes = () => page.locator('.react-flow__node');
const edges = () => page.locator('.react-flow__edge');
/** A node by its exact label. Children are DOM siblings of their container, not descendants. */
const node = (label: string) =>
  page.locator('.react-flow__node', { hasText: new RegExp(`^${label}$`) });
/** What you grab a group by: a frame's label bar, or a parent node's card. */
const titleBar = (label: string) => node(label).locator('.graph-frame-title');
const card = (label: string) => node(label).locator('.graph-card');
const labelInput = () => page.getByRole('textbox', { name: 'Label' });
/** The actions shown next to a hovered or selected node or group. */
async function actionsFor(target: Locator) {
  const id = await target.getAttribute('data-id');
  return page.locator(`.react-flow__node-toolbar[data-id="${String(id)}"]`);
}
/** The actions shown above a multi-node selection. */
const selectionActions = () =>
  page.locator('.react-flow__node-toolbar', {
    has: page.getByRole('button', { name: 'Group', exact: true }),
  });

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('element has no box');
  return b;
}

async function center(locator: Locator): Promise<Point> {
  const b = await box(locator);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** A point on the canvas, as an offset from its top-left corner. */
async function at(dx: number, dy: number): Promise<Point> {
  const p = await box(pane());
  return { x: p.x + dx, y: p.y + dy };
}

async function addNodeAt(label: string, dx: number, dy: number) {
  const p = await at(dx, dy);
  await page.mouse.dblclick(p.x, p.y);
  await expect(node(label)).toBeVisible();
  return node(label);
}

async function drag(from: Point, to: Point, button: 'left' | 'right' = 'left') {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button });
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up({ button });
}

type Dot = 'top' | 'bottom';
const dot = (n: Locator, which: Dot) => n.locator(`.react-flow__handle[data-handleid="${which}"]`);

/** Drags from one node's dot to another's: an edge from the first node to the second. */
async function connect(source: Locator, target: Locator, from: Dot = 'bottom', to: Dot = 'top') {
  await drag(await center(dot(source, from)), await center(dot(target, to)));
}

/** Drags a selection box 30px around the given nodes, starting on empty space. */
async function marquee(...targets: Locator[]) {
  const boxes = await Promise.all(targets.map(box));
  const left = Math.min(...boxes.map((b) => b.x)) - 30;
  const top = Math.min(...boxes.map((b) => b.y)) - 30;
  const right = Math.max(...boxes.map((b) => b.x + b.width)) + 30;
  const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + 30;
  await drag({ x: left, y: top }, { x: right, y: bottom });
}

/** The client coordinates of the middle of an edge's path. */
async function edgeMidpoint(edge: Locator): Promise<Point> {
  return edge.locator('path.react-flow__edge-path').evaluate((path: SVGPathElement) => {
    const point = path.getPointAtLength(path.getTotalLength() / 2);
    const matrix = path.getScreenCTM();
    if (!matrix) throw new Error('edge is not rendered');
    const screen = point.matrixTransform(matrix);
    return { x: screen.x, y: screen.y };
  });
}

type Box = Awaited<ReturnType<typeof box>>;

function expectInside(inner: Box, outer: Box) {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y);
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width);
  expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height);
}

function expectSamePlace(after: Point, before: Point) {
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
}

function expectNear(a: Point, b: Point, tolerance = 6) {
  expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThanOrEqual(tolerance);
}

/** `steps` evenly spaced points from `from` (exclusive) to `to` (inclusive). */
function path(from: Point, to: Point, steps: number): Point[] {
  return Array.from({ length: steps }, (_, i) => ({
    x: from.x + ((to.x - from.x) * (i + 1)) / steps,
    y: from.y + ((to.y - from.y) * (i + 1)) / steps,
  }));
}

/**
 * Drags from `from` through `points`, checking after every move that the dragged element stays
 * under the pointer (its offset from the pointer never changes) and running `check`. Starts with
 * a 2px nudge, because React Flow begins a drag on the first move without moving the node for it:
 * the node then ends up exactly where the last point says.
 */
async function dragAlong(from: Point, points: Point[], check?: () => Promise<void>) {
  const dragged = page.locator('.react-flow__node.dragging');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 2, from.y);
  let offset: Point | undefined;
  for (const point of points) {
    await page.mouse.move(point.x + 2, point.y, { steps: 2 });
    const now = await center(dragged);
    const off = { x: now.x - point.x, y: now.y - point.y };
    offset ??= off;
    expectSamePlace(off, offset);
    await check?.();
  }
  await page.mouse.up();
}

/** The client coordinates where an edge's path starts or ends. */
async function edgeEnd(edge: Locator, which: 'start' | 'end'): Promise<Point> {
  return edge.locator('path.react-flow__edge-path').evaluate((path: SVGPathElement, end) => {
    const point = path.getPointAtLength(end === 'end' ? path.getTotalLength() : 0);
    const matrix = path.getScreenCTM();
    if (!matrix) throw new Error('edge is not rendered');
    const screen = point.matrixTransform(matrix);
    return { x: screen.x, y: screen.y };
  }, which);
}

/** Node 1 and Node 3 in frame Group 2, which sits in frame Group 1 next to Node 2. */
async function nestedFrames() {
  const a = await addNodeAt('Node 1', 500, 280);
  const b = await addNodeAt('Node 2', 750, 340);
  const c = await addNodeAt('Node 3', 500, 400);
  await marquee(a, b, c);
  await page.keyboard.press('ControlOrMeta+g');
  const outer = node('Group 1');
  await expect(outer).toBeVisible();

  await marquee(a, c);
  await expect(b).not.toHaveClass(/selected/);
  await expect(outer).not.toHaveClass(/selected/);
  await page.keyboard.press('ControlOrMeta+g');
  const inner = node('Group 2');
  await expect(inner).toBeVisible();
  expectInside(await box(a), await box(inner));
  expectInside(await box(inner), await box(outer));
  expectInside(await box(b), await box(outer));
  return { a, b, c, inner, outer };
}

test('creates, selects, renames and deletes nodes', async () => {
  // React Flow's stylesheet loaded under the production CSP (its own "styles loaded" check).
  expect(await pane().evaluate((el) => getComputedStyle(el).zIndex)).toBe('1');

  await addNodeAt('Node 1', 300, 200);
  await addNodeAt('Node 2', 600, 300);

  await node('Node 1').click();
  await node('Node 2').click({ modifiers: ['Shift'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  const empty = await at(800, 500);
  await page.mouse.click(empty.x, empty.y);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);

  // F2 renames the selected node in place: type over the selected text, Enter.
  await node('Node 1').click();
  await page.keyboard.press('F2');
  await expect(labelInput()).toBeFocused();
  await page.keyboard.type('Alpha');
  await page.keyboard.press('Enter');
  await expect(node('Alpha')).toBeVisible();

  await node('Alpha').click();
  await page.keyboard.press('Delete');
  await expect(node('Alpha')).toHaveCount(0);

  // Backspace while renaming edits the text only, and Escape restores the label.
  await node('Node 2').click();
  await page.keyboard.press('F2');
  await page.keyboard.press('Backspace');
  await expect(labelInput()).toHaveValue('');
  await expect(nodes()).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(node('Node 2')).toBeVisible();

  // Hovering a node shows its actions.
  await page.mouse.click(empty.x, empty.y);
  await node('Node 2').hover();
  await (await actionsFor(node('Node 2'))).getByRole('button', { name: 'Delete' }).click();
  await expect(nodes()).toHaveCount(0);
});

test('connects nodes in both directions, and deletes edges', async () => {
  const a = await addNodeAt('Node 1', 400, 150);
  const b = await addNodeAt('Node 2', 400, 350);
  const [idA, idB] = await Promise.all([a.getAttribute('data-id'), b.getAttribute('data-id')]);
  const ab = page.getByTestId(`rf__edge-${String(idA)}->${String(idB)}`);
  const ba = page.getByTestId(`rf__edge-${String(idB)}->${String(idA)}`);

  await connect(a, b);
  await expect(ab).toHaveCount(1);
  await expect(ab.locator('path.react-flow__edge-path')).toHaveAttribute('marker-end', /url\(/);

  // An edge runs from where the drag starts to where it ends: dragging back from b's top dot to
  // a's bottom dot adds b -> a along the same line, so the pair shows an arrowhead at each end.
  await connect(b, a, 'top', 'bottom');
  await expect(ba).toHaveCount(1);
  expectNear(await edgeEnd(ba, 'start'), await edgeEnd(ab, 'end'));
  expectNear(await edgeEnd(ba, 'end'), await edgeEnd(ab, 'start'));

  await connect(a, a); // self-loop: rejected
  await connect(a, b); // duplicate: rejected
  await expect(edges()).toHaveCount(2);

  // A selected edge shows a button that deletes it; Backspace works too.
  const selected = page.locator('.react-flow__edge.selected');
  const mid = await edgeMidpoint(ab);
  await page.mouse.click(mid.x, mid.y);
  await expect(selected).toHaveCount(1);
  await page.getByRole('button', { name: 'Delete edge' }).click();
  await expect(edges()).toHaveCount(1);
  await page.mouse.click(mid.x, mid.y);
  await expect(selected).toHaveCount(1);
  await page.keyboard.press('Backspace');
  await expect(edges()).toHaveCount(0);
  await expect(nodes()).toHaveCount(2);
});

test('frames a marquee selection, works inside the frame, and ungroups', async () => {
  const a = await addNodeAt('Node 1', 400, 200);
  const b = await addNodeAt('Node 2', 650, 300);

  await marquee(a, b);
  await expect(a).toHaveClass(/selected/);
  await expect(b).toHaveClass(/selected/);

  // A multi-node selection offers to group it.
  await selectionActions().getByRole('button', { name: 'Group', exact: true }).click();
  const frame = node('Group 1');
  await expect(frame).toHaveClass(/selected/);
  await expect(page.locator('.react-flow__nodesselection')).toHaveCount(0);
  expectInside(await box(a), await box(frame));
  expectInside(await box(b), await box(frame));

  // The frame's body lets clicks through to the canvas: this deselects everything.
  const f = await box(frame);
  await page.mouse.click(f.x + f.width / 2, f.y + f.height - 10);
  await expect(frame).not.toHaveClass(/selected/);

  // Dragging a child past the frame's edge grows the frame.
  await drag(await center(b), { x: f.x + f.width + 100, y: (await center(b)).y });
  const grown = await box(frame);
  expect(grown.width).toBeGreaterThan(f.width);
  expectInside(await box(b), grown);

  // Double-clicking the frame's body (here its top-left padding) adds a node inside it.
  await page.mouse.dblclick(grown.x + PADDING / 2, grown.y + HEADER + PADDING / 2);
  const c = node('Node 3');
  await expect(c).toBeVisible();
  const withC = await box(frame);
  expectInside(await box(c), withC);

  // Dragging the frame by its title bar moves everything inside it.
  const before = await Promise.all([a, b, c].map(box));
  const handle = await center(titleBar('Group 1'));
  await drag(handle, { x: handle.x + 50, y: handle.y + 40 });
  const moved = await box(frame);
  // It moved (by about 45, 36: React Flow's drag threshold swallows the first 5, 4 step).
  expect(moved.x - withC.x).toBeGreaterThan(30);
  expect(moved.y - withC.y).toBeGreaterThan(30);
  const after = await Promise.all([a, b, c].map(box));
  for (const [i, prev] of before.entries()) {
    expect(after[i]?.x).toBeCloseTo(prev.x + moved.x - withC.x, 0);
    expect(after[i]?.y).toBeCloseTo(prev.y + moved.y - withC.y, 0);
  }

  // Ungroup, from the frame's actions, removes it and leaves its children in place, selected.
  await titleBar('Group 1').hover();
  await (await actionsFor(frame)).getByRole('button', { name: 'Ungroup' }).click();
  await expect(frame).toHaveCount(0);
  for (const [i, n] of [a, b, c].entries()) {
    await expect(n).toHaveClass(/selected/);
    const current = after[i];
    if (current) expectSamePlace(await box(n), current);
  }
});

test("gives a group a parent from the '+' on its top border, then connects and deletes it", async () => {
  const a = await addNodeAt('Node 1', 450, 330);
  const b = await addNodeAt('Node 2', 450, 460);
  const c = await addNodeAt('Node 3', 900, 200);

  await marquee(a, b);
  await page.keyboard.press('ControlOrMeta+g');
  const frame = node('Group 1');
  await expect(frame).toBeVisible();
  const empty = await at(900, 500);
  await page.mouse.click(empty.x, empty.y);

  // The '+' shows when the pointer is on the middle of the group's top border.
  const plus = page.getByRole('button', { name: 'Add a parent node' });
  const opacity = () => plus.evaluate((el) => getComputedStyle(el).opacity);
  await expect.poll(opacity).toBe('0');
  const f = await box(frame);
  const topMiddle = { x: f.x + f.width / 2, y: f.y };
  await page.mouse.move(topMiddle.x, topMiddle.y);
  await expect.poll(opacity).toBe('1');
  expectNear(await center(plus), topMiddle, 1);
  const boxA = await box(a);
  await plus.click();

  // The group's new parent node: its card where the '+' was, the group's nodes where they were.
  const parent = node('Node 4');
  await expect(parent).toHaveClass(/parent/);
  await expect(parent).toHaveClass(/selected/);
  expectNear(await center(card('Node 4')), topMiddle, 1);
  expectSamePlace(await box(a), boxA);
  expectInside(boxA, await box(parent));

  await page.keyboard.press('F2');
  await page.keyboard.type('Team');
  await page.keyboard.press('Enter');
  const team = node('Team');

  // A selection box started on the parent's body selects only what it encloses.
  const start = { x: boxA.x + boxA.width + PADDING / 2, y: boxA.y + boxA.height + PADDING / 2 };
  expect(
    await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className, start),
  ).toMatch(/react-flow__pane/);
  await drag(start, { x: boxA.x - 30, y: boxA.y - 30 });
  await expect(a).toHaveClass(/selected/);
  await expect(b).not.toHaveClass(/selected/);
  await expect(team).not.toHaveClass(/selected/);

  // Framing a: the parent grows around the new frame, and nothing moves.
  await page.keyboard.press('ControlOrMeta+g');
  const inner = node('Group 1');
  await expect(inner).toBeVisible();
  expectSamePlace(await box(a), boxA);
  expectInside(await box(a), await box(inner));
  expectInside(await box(inner), await box(team));
  const teamCard = await box(card('Team'));
  expect((await box(inner)).y).toBeGreaterThanOrEqual(teamCard.y + teamCard.height);

  // The parent node connects to nodes outside its group, both ways.
  await connect(c, team);
  await connect(team, c);
  await expect(edges()).toHaveCount(2);
  const [idC, idTeam] = await Promise.all([
    c.getAttribute('data-id'),
    team.getAttribute('data-id'),
  ]);
  const into = page.getByTestId(`rf__edge-${String(idC)}->${String(idTeam)}`);
  const outOf = page.getByTestId(`rf__edge-${String(idTeam)}->${String(idC)}`);
  expectNear(await edgeEnd(into, 'end'), await center(dot(team, 'top')));
  expectNear(await edgeEnd(outOf, 'start'), await center(dot(team, 'bottom')));

  // Deleting the parent, from its actions, keeps what was inside it in place and removes its edges.
  const kept = await Promise.all([a, b, inner].map(box));
  await card('Team').hover();
  await (await actionsFor(team)).getByRole('button', { name: 'Delete' }).click();
  await expect(team).toHaveCount(0);
  await expect(edges()).toHaveCount(0);
  for (const [i, n] of [a, b, inner].entries()) {
    const previous = kept[i];
    if (previous) expectSamePlace(await box(n), previous);
  }
  await expect(nodes()).toHaveCount(4);
});

test('double-clicking a node opens it in a panel that grows out of it, to edit its queue', async () => {
  const a = await addNodeAt('Node 1', 300, 200);
  const from = await box(card('Node 1'));
  await a.dblclick();

  // Rewound to its first frame, the panel sits exactly on the node's card...
  const first = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const [grow] = dialog?.getAnimations() ?? [];
    if (!dialog || !grow) return null;
    grow.pause();
    grow.currentTime = 0;
    const { x, y, width, height } = dialog.getBoundingClientRect();
    grow.finish();
    return { x, y, width, height };
  });
  if (!first) throw new Error('the panel did not animate open');
  expectSamePlace(first, from);
  expectSamePlace({ x: first.width, y: first.height }, { x: from.width, y: from.height });

  // ...and opens to most of the editor, centred.
  const panel = page.getByRole('dialog', { name: 'Node 1' });
  const [editor, opened] = await Promise.all([box(page.locator('.graph-editor')), box(panel)]);
  expect(opened.width).toBeGreaterThan(editor.width * 0.8);
  expect(opened.height).toBeGreaterThan(editor.height * 0.8);
  expectNear(await center(panel), await center(page.locator('.graph-editor')), 1);

  await panel.getByRole('button', { name: 'Add Placeholder A' }).click();
  await panel.getByRole('button', { name: 'Add Placeholder C' }).click();
  await expect(panel.getByRole('listitem')).toHaveText(['Placeholder A', 'Placeholder C']);
  await panel.getByRole('button', { name: 'Remove Placeholder A' }).click();
  await expect(panel.getByRole('listitem')).toHaveText(['Placeholder C']);

  // Escape shrinks it back into the node, which shows how many items are queued.
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(card('Node 1').locator('.graph-queue-count')).toHaveAttribute('data-count', '1');

  // The queue is kept; a click outside the panel closes it too.
  await a.dblclick();
  await expect(panel.getByRole('listitem')).toHaveText(['Placeholder C']);
  await page.mouse.click(editor.x + 10, editor.y + 10);
  await expect(panel).toHaveCount(0);
});

test('groups fit their contents as a nested node is dragged out of them and back', async () => {
  const { a, b, c, inner, outer } = await nestedFrames();
  const [outerBefore, innerBefore, bBefore, cBefore] = await Promise.all([
    box(outer),
    box(inner),
    box(b),
    box(c),
  ]);
  const others = async () => {
    expectSamePlace(await box(b), bBefore);
    expectSamePlace(await box(c), cBefore);
  };
  const home = await center(a);

  // Out past the outer frame's right edge: both frames follow on every step.
  await dragAlong(
    home,
    [...path(home, { x: outerBefore.x + outerBefore.width + 60, y: home.y + 40 }, 6)],
    async () => {
      expectInside(await box(a), await box(inner));
      expectInside(await box(inner), await box(outer));
    },
  );
  expectInside(await box(inner), await box(outer));
  await others();

  // Out past the outer frame's top-left corner: the frames fit once the node is dropped.
  await dragAlong(
    await center(a),
    path(await center(a), { x: outerBefore.x - 60, y: outerBefore.y - 60 }, 6),
  );
  expectInside(await box(a), await box(inner));
  expectInside(await box(inner), await box(outer));
  await others();

  // Back home: both frames shrink to their original boxes.
  await dragAlong(await center(a), path(await center(a), home, 6));
  for (const [now, was] of [
    [await box(inner), innerBefore],
    [await box(outer), outerBefore],
  ] as const) {
    expectSamePlace(now, was);
    expectSamePlace({ x: now.width, y: now.height }, { x: was.width, y: was.height });
  }
  await others();
});

test('left-drag selects; right-drag and Space-drag pan', async () => {
  const viewport = page.locator('.react-flow__viewport');
  const transform = () => viewport.evaluate((el) => getComputedStyle(el).transform);
  const start = await transform();

  await drag(await at(300, 300), await at(500, 450));
  expect(await transform()).toBe(start);

  await drag(await at(300, 300), await at(400, 350), 'right');
  const panned = await transform();
  expect(panned).not.toBe(start);

  await page.keyboard.down('Space');
  await drag(await at(300, 300), await at(350, 400));
  await page.keyboard.up('Space');
  expect(await transform()).not.toBe(panned);
});

test('shows which node or frame has keyboard focus', async () => {
  const a = await addNodeAt('Node 1', 400, 200);
  const b = await addNodeAt('Node 2', 650, 300);
  await marquee(a, b);
  await page.keyboard.press('ControlOrMeta+g');
  await expect(node('Group 1')).toBeVisible();

  // Click empty canvas, then Tab: the frame (first in the node layer), its '+', then Node 1.
  const empty = await at(800, 500);
  await page.mouse.click(empty.x, empty.y);
  const focused = page.locator('.react-flow__node:focus-visible');
  const outline = () => focused.evaluate((el) => getComputedStyle(el).outlineStyle);
  await page.keyboard.press('Tab');
  await expect(focused).toHaveText('Group 1');
  await expect(focused).not.toHaveClass(/selected/);
  expect(await outline()).toBe('dashed');

  // The '+' that gives the group a parent is reachable, and shows while focused.
  await page.keyboard.press('Tab');
  const plus = page.getByRole('button', { name: 'Add a parent node' });
  await expect(plus).toBeFocused();
  expect(await plus.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

  await page.keyboard.press('Tab');
  await expect(focused).toHaveText('Node 1');
  expect(await outline()).toBe('dashed');
});

test('double-click works inside the rectangle a marquee leaves around the selection', async () => {
  const a = await addNodeAt('Node 1', 400, 200);
  const b = await addNodeAt('Node 2', 650, 350);
  const rect = page.locator('.react-flow__nodesselection-rect');

  // On a node: opens that node alone.
  await marquee(a, b);
  await expect(rect).toHaveCount(1);
  const onA = await center(a);
  await page.mouse.dblclick(onA.x, onA.y);
  await expect(page.getByRole('dialog', { name: 'Node 1' })).toBeVisible();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // On empty space inside the rectangle: adds a node.
  await marquee(a, b);
  await expect(rect).toHaveCount(1);
  const [boxA, boxB] = await Promise.all([box(a), box(b)]);
  const between = { x: (boxA.x + boxA.width + boxB.x) / 2, y: (boxA.y + boxA.height + boxB.y) / 2 };
  expectInside({ ...between, width: 0, height: 0 }, await box(rect));
  await page.mouse.dblclick(between.x, between.y);
  await expect(node('Node 3')).toBeVisible();
});
