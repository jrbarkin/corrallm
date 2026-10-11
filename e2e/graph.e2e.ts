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

async function addAgentAt(label: string, dx: number, dy: number) {
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

/** Drags from one node's dot to another's, which asks what the edge makes (a link or work). */
async function draw(source: Locator, target: Locator, from: Dot = 'bottom', to: Dot = 'top') {
  await drag(await center(dot(source, from)), await center(dot(target, to)));
}

/** Draws an edge from one node's dot to another's, and makes it a link: the two can talk. */
async function connect(source: Locator, target: Locator, from: Dot = 'bottom', to: Dot = 'top') {
  await draw(source, target, from, to);
  await page
    .getByRole('dialog', { name: /^Connect / })
    .getByRole('button', { name: /^Let them talk/ })
    .click();
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

/** Agent 1 and Agent 3 in frame Group 2, which sits in frame Group 1 next to Agent 2. */
async function nestedFrames() {
  const a = await addAgentAt('Agent 1', 500, 280);
  const b = await addAgentAt('Agent 2', 750, 340);
  const c = await addAgentAt('Agent 3', 500, 400);
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

  await addAgentAt('Agent 1', 300, 200);
  await addAgentAt('Agent 2', 600, 300);

  await node('Agent 1').click();
  await node('Agent 2').click({ modifiers: ['Shift'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  const empty = await at(800, 500);
  await page.mouse.click(empty.x, empty.y);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);

  // F2 renames the selected node in place: type over the selected text, Enter.
  await node('Agent 1').click();
  await page.keyboard.press('F2');
  await expect(labelInput()).toBeFocused();
  await page.keyboard.type('Alpha');
  await page.keyboard.press('Enter');
  await expect(node('Alpha')).toBeVisible();

  await node('Alpha').click();
  await page.keyboard.press('Delete');
  await expect(node('Alpha')).toHaveCount(0);

  // Backspace while renaming edits the text only, and Escape restores the label.
  await node('Agent 2').click();
  await page.keyboard.press('F2');
  await page.keyboard.press('Backspace');
  await expect(labelInput()).toHaveValue('');
  await expect(nodes()).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(node('Agent 2')).toBeVisible();

  // Hovering a node shows its actions.
  await page.mouse.click(empty.x, empty.y);
  await node('Agent 2').hover();
  await (await actionsFor(node('Agent 2'))).getByRole('button', { name: 'Delete' }).click();
  await expect(nodes()).toHaveCount(0);
});

test('a drawn edge lets two agents talk, or queues work, which their queues then draw', async () => {
  const a = await addAgentAt('Agent 1', 400, 150);
  const b = await addAgentAt('Agent 2', 400, 350);
  const [idA, idB] = await Promise.all([a.getAttribute('data-id'), b.getAttribute('data-id')]);
  const link = page.getByTestId(`rf__edge-${String(idA)}->${String(idB)}`);
  const work = page.getByTestId(`rf__edge-work:${String(idB)}->${String(idA)}`);
  const arrowhead = (edge: Locator) =>
    edge.locator('path.react-flow__edge-path').getAttribute('marker-end');

  // Drawing from a to b asks what the edge makes, just above where the drag ended (clear of b's
  // card). A link lets them talk: dashed, with no arrowhead.
  await draw(a, b);
  const menu = page.getByRole('dialog', { name: 'Connect Agent 1 to Agent 2' });
  const placed = await box(menu);
  expectNear(
    { x: placed.x + placed.width / 2, y: placed.y + placed.height },
    await center(dot(b, 'top')),
    16,
  );
  await menu.getByRole('button', { name: /^Let them talk/ }).click();
  await expect(menu).toHaveCount(0);
  await expect(link).toHaveCount(1);
  expect(await arrowhead(link)).toBeNull();
  expect(
    await link
      .locator('path.react-flow__edge-path')
      .evaluate((el) => getComputedStyle(el).strokeDasharray),
  ).not.toBe('none');

  // Drawing back from b to a: they can talk already, so it queues work for a, from b's queue.
  await draw(b, a, 'top', 'bottom');
  const back = page.getByRole('dialog', { name: 'Connect Agent 2 to Agent 1' });
  await expect(back.getByRole('button', { name: /^Let them talk/ })).toBeDisabled();
  await back.getByRole('button', { name: /^Queue work for Agent 1/ }).click();
  const panel = page.getByRole('dialog', { name: 'Work from Agent 2 for Agent 1' });
  await panel.getByRole('button', { name: 'Queue work for Agent 1' }).click();
  await page.keyboard.type('read');
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('button', { name: 'Change the agent Read acts on' })).toHaveText(
    '→ Agent 1',
  );
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // The work is an arrow from b to a, with how much is queued, in place of the link it implies.
  expect(await arrowhead(work)).toMatch(/url\(/);
  await expect(link).toHaveCount(0);
  const count = page.getByRole('button', { name: 'Open the work from Agent 2 for Agent 1' });
  await expect(count).toHaveText('1');

  // Removing the work, from the panel its count opens, brings the link back.
  await count.click();
  await panel.getByRole('button', { name: 'Remove Read' }).click();
  await page.keyboard.press('Escape');
  await expect(work).toHaveCount(0);
  await expect(link).toHaveCount(1);

  // A self-loop asks nothing.
  await draw(a, a);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // A selected link shows a button that deletes it; Backspace works too.
  const selected = page.locator('.react-flow__edge.selected');
  const mid = await edgeMidpoint(link);
  await page.mouse.click(mid.x, mid.y);
  await expect(selected).toHaveCount(1);
  await page.getByRole('button', { name: 'Delete link' }).click();
  await expect(edges()).toHaveCount(0);
  await connect(a, b);
  await page.mouse.click(mid.x, mid.y);
  await expect(selected).toHaveCount(1);
  await page.keyboard.press('Backspace');
  await expect(edges()).toHaveCount(0);
  await expect(nodes()).toHaveCount(2);
});

test('frames a marquee selection, works inside the frame, and ungroups', async () => {
  const a = await addAgentAt('Agent 1', 400, 200);
  const b = await addAgentAt('Agent 2', 650, 300);

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

  // A click anywhere on the frame selects it, like a node; a click on the canvas deselects it.
  const f = await box(frame);
  await page.mouse.click(f.x + f.width / 2, f.y + f.height - 10);
  await expect(frame).toHaveClass(/selected/);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  const outside = await at(900, 560);
  await page.mouse.click(outside.x, outside.y);
  await expect(frame).not.toHaveClass(/selected/);

  // Dragging a child past the frame's edge grows the frame.
  await drag(await center(b), { x: f.x + f.width + 100, y: (await center(b)).y });
  const grown = await box(frame);
  expect(grown.width).toBeGreaterThan(f.width);
  expectInside(await box(b), grown);

  // Double-clicking the frame's body (here its top-left padding) adds a node inside it.
  await page.mouse.dblclick(grown.x + PADDING / 2, grown.y + HEADER + PADDING / 2);
  const c = node('Agent 3');
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

test('moves a group like one node: drag it anywhere, and what is inside comes along', async () => {
  const a = await addAgentAt('Agent 1', 350, 200);
  const b = await addAgentAt('Agent 2', 600, 320);
  await marquee(a, b);
  await page.keyboard.press('ControlOrMeta+g');
  const frame = node('Group 1');
  await expect(frame).toBeVisible();

  /**
   * Drags `group` by a point on its body (its bottom-right padding) and checks everything moved
   * together.
   */
  const dragBody = async (group: Locator, inside: Locator[]) => {
    const g = await box(group);
    const before = await Promise.all(inside.map(box));
    const grip = { x: g.x + g.width - PADDING / 2, y: g.y + g.height - PADDING / 2 };
    await drag(grip, { x: grip.x + 120, y: grip.y + 80 });
    const moved = await box(group);
    expect(moved.x - g.x).toBeGreaterThan(100);
    expect(moved.y - g.y).toBeGreaterThan(60);
    for (const [i, n] of inside.entries()) {
      const was = before[i];
      if (was)
        expectSamePlace(await box(n), { x: was.x + moved.x - g.x, y: was.y + moved.y - g.y });
    }
  };
  await dragBody(frame, [a, b]);

  // A group with a parent node moves the same way.
  await titleBar('Group 1').hover();
  await page.getByRole('button', { name: 'Add a parent agent' }).click();
  await dragBody(node('Agent 3'), [a, b]);
});

test("gives a group a parent from the '+' on its top border, then connects and deletes it", async () => {
  const a = await addAgentAt('Agent 1', 450, 330);
  const b = await addAgentAt('Agent 2', 450, 460);
  const c = await addAgentAt('Agent 3', 900, 200);

  await marquee(a, b);
  await page.keyboard.press('ControlOrMeta+g');
  const frame = node('Group 1');
  await expect(frame).toBeVisible();
  const empty = await at(900, 500);
  await page.mouse.click(empty.x, empty.y);

  // The '+' shows when the pointer is on the middle of the group's top border.
  const plus = page.getByRole('button', { name: 'Add a parent agent' });
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
  const parent = node('Agent 4');
  await expect(parent).toHaveClass(/parent/);
  await expect(parent).toHaveClass(/selected/);
  expectNear(await center(card('Agent 4')), topMiddle, 1);
  expectSamePlace(await box(a), boxA);
  expectInside(boxA, await box(parent));

  await page.keyboard.press('F2');
  await page.keyboard.type('Team');
  await page.keyboard.press('Enter');
  const team = node('Team');

  // Inside a group, a click selects just that node.
  await a.click();
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

  // The parent node links to nodes outside its group, and gives them work, from its own dots.
  await connect(c, team);
  const [idC, idTeam] = await Promise.all([
    c.getAttribute('data-id'),
    team.getAttribute('data-id'),
  ]);
  const link = page.getByTestId(`rf__edge-${String(idC)}->${String(idTeam)}`);
  expectNear(await edgeEnd(link, 'end'), await center(dot(team, 'top')));
  await draw(team, c);
  await page.getByRole('button', { name: /^Queue work for Agent 3/ }).click();
  await page.getByRole('button', { name: 'Queue work for Agent 3' }).click();
  await page.keyboard.type('read');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  // Agent 3 is above the group: the work goes up, out of the parent's top dot.
  const work = page.getByTestId(`rf__edge-work:${String(idTeam)}->${String(idC)}`);
  expectNear(await edgeEnd(work, 'start'), await center(dot(team, 'top')));
  expectNear(await edgeEnd(work, 'end'), await center(dot(c, 'bottom')));
  await expect(edges()).toHaveCount(1);

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
  const a = await addAgentAt('Agent 1', 300, 200);
  await addAgentAt('Agent 2', 800, 500);
  const from = await box(card('Agent 1'));
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
  const panel = page.getByRole('dialog', { name: 'Agent 1' });
  const [editor, opened] = await Promise.all([box(page.locator('.graph-editor')), box(panel)]);
  expect(opened.width).toBeGreaterThan(editor.width * 0.8);
  expect(opened.height).toBeGreaterThan(editor.height * 0.8);
  expectNear(await center(panel), await center(page.locator('.graph-editor')), 1);

  // A new agent's queue starts with a message, to tell it what to do. ⊕ adds one of the agent's
  // actions and the agent it acts on, each picked by typing (or clicking). Agent 1 is a Claude
  // agent, so these are Claude Code's tools.
  const plus = panel.getByRole('button', { name: 'Add to queue' });
  const handles = panel.getByRole('button', { name: /^Move / });
  const order = () => handles.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
  await expect.poll(order).toEqual(['Move Message']);
  await plus.click();
  await panel.getByRole('option', { name: /^Read / }).click();
  await page.keyboard.press('Enter'); // this agent
  await plus.click();
  await page.keyboard.type('run shell');
  await page.keyboard.press('Enter');
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  await expect.poll(order).toEqual(['Move Message', 'Move Read', 'Move Bash']);
  await expect(panel.getByRole('button', { name: 'Change the agent Bash acts on' })).toHaveText(
    '→ Agent 2',
  );

  // Dragging an item's handle reorders the queue.
  const grip = await center(panel.getByRole('button', { name: 'Move Bash', exact: true }));
  await drag(grip, { x: grip.x, y: (await box(handles.first())).y - 4 });
  await expect.poll(order).toEqual(['Move Bash', 'Move Message', 'Move Read']);
  await panel.getByRole('button', { name: 'Remove Read' }).click();
  await expect.poll(order).toEqual(['Move Bash', 'Move Message']);

  // Escape shrinks it back into the node, which shows how many items are queued (a message with
  // nothing written in it does not count).
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(card('Agent 1').locator('.graph-queue-count')).toHaveAttribute('data-count', '1');

  // The queue is kept; a click outside the panel closes it too.
  await a.dblclick();
  await expect(panel.getByRole('button', { name: 'Change the agent Bash acts on' })).toHaveText(
    '→ Agent 2',
  );

  // A queued message shows all of its text, however many lines it wraps to.
  const message = panel.getByRole('textbox', { name: 'Message to the agent' });
  await message.fill(
    'Keep the diff small, explain each change, and run the tests before handing it back.',
  );
  expect(await message.evaluate((el) => el.scrollHeight - el.clientHeight)).toBe(0);

  // A new message is typed into a box that looks like the search field it replaces.
  const look = (field: Locator) =>
    field.evaluate((el) => {
      const style = getComputedStyle(el);
      const { fontFamily, fontSize, borderTopColor, borderRadius } = style;
      return { fontFamily, fontSize, borderTopColor, borderRadius, width: el.clientWidth };
    });
  await plus.click();
  const search = await look(panel.getByRole('combobox', { name: 'Add to queue' }));
  await page.keyboard.type('message');
  await page.keyboard.press('Enter');
  const prompt = panel.getByRole('textbox', { name: 'New message to the agent' });
  expect(await look(prompt)).toEqual(search);
  await page.keyboard.press('Escape');
  await expect(prompt).toHaveCount(0);

  await page.mouse.click(editor.x + 10, editor.y + 10);
  await expect(panel).toHaveCount(0);
});

test('agents show their type and ask questions, which a sidebar lists until answered', async () => {
  const a = await addAgentAt('Agent 1', 300, 200);
  await addAgentAt('Agent 2', 650, 380);
  const tagColor = (label: string) =>
    card(label)
      .locator('.graph-agent')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
  const stripe = (label: string) =>
    card(label).evaluate((el) => getComputedStyle(el).borderLeftColor);

  // Every agent has a type, colour-coded on its card; its panel changes it.
  await expect(card('Agent 1').locator('.graph-agent')).toHaveAttribute('data-agent', 'Claude');
  const claude = await tagColor('Agent 1');
  expect(await stripe('Agent 1')).toBe(claude);
  await a.dblclick();
  const panel = page.getByRole('dialog', { name: 'Agent 1' });
  await panel.getByRole('button', { name: 'Agent: Claude' }).click();
  // Its dropdown fits in the panel, which does not scroll to show it.
  await expect(panel.getByRole('listbox', { name: 'Agent' })).toBeVisible();
  expect(await panel.evaluate((el) => [el.scrollLeft, el.scrollWidth - el.clientWidth])).toEqual([
    0, 0,
  ]);
  await page.keyboard.type('codex');
  await page.keyboard.press('Enter');
  await expect(card('Agent 1').locator('.graph-agent')).toHaveAttribute('data-agent', 'Codex');
  expect(await tagColor('Agent 1')).not.toBe(claude);
  expect(await stripe('Agent 1')).toBe(await tagColor('Agent 1'));

  // An agent asks a question (simulated until agents are connected): it glows, and a sidebar
  // lists the question, labelled by agent, until it is answered there.
  await panel.getByRole('button', { name: 'Simulate a question' }).click();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(a).toHaveClass(/asking/);
  const sidebar = page.getByRole('complementary', { name: 'Questions from agents' });
  await expect(sidebar.getByRole('button', { name: 'Open Agent 1' })).toBeVisible();
  await sidebar.getByRole('button', { name: 'Fix them first' }).click();
  await expect(sidebar).toHaveCount(0);
  await expect(a).not.toHaveClass(/asking/);
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

test('groups nest and take a parent node just like nodes do', async () => {
  const a = await addAgentAt('Agent 1', 300, 200);
  const b = await addAgentAt('Agent 2', 300, 320);
  await marquee(a, b);
  await page.keyboard.press('ControlOrMeta+g');
  const c = await addAgentAt('Agent 3', 700, 200);
  const d = await addAgentAt('Agent 4', 700, 320);
  await marquee(c, d);
  await page.keyboard.press('ControlOrMeta+g');
  const [first, second] = [node('Group 1'), node('Group 2')];
  await expect(second).toBeVisible();

  // Each group colours its nodes, in a colour of its own.
  const border = (label: string) =>
    card(label).evaluate((el) => getComputedStyle(el).borderTopColor);
  expect(await border('Agent 1')).toBe(await border('Agent 2'));
  expect(await border('Agent 3')).not.toBe(await border('Agent 1'));

  // Two groups, grouped.
  await marquee(first, second);
  await page.keyboard.press('ControlOrMeta+g');
  const outer = node('Group 3');
  await expect(outer).toBeVisible();
  expectInside(await box(first), await box(outer));
  expectInside(await box(second), await box(outer));

  // The group of groups takes a parent node, which connects like any node.
  await outer.locator('.graph-frame-title').hover();
  await outer.getByRole('button', { name: 'Add a parent agent' }).click();
  const parent = node('Agent 5');
  await expect(parent).toHaveClass(/parent/);
  expectInside(await box(first), await box(parent));
  expectInside(await box(second), await box(parent));
  const e = await addAgentAt('Agent 6', 500, 620);
  await connect(parent, e);
  await expect(edges()).toHaveCount(1);
});

test('opens each example from the gallery, drawing its agents and the work between them', async () => {
  await page.getByRole('button', { name: 'Start from an example…' }).click();
  for (const name of [
    'Independent cross-check',
    'Review loop',
    'Team lead',
    'Fan-out research',
    'Release checks',
  ]) {
    const gallery = page.getByRole('dialog', { name: 'Examples' });
    if ((await gallery.count()) === 0)
      await page.getByRole('button', { name: 'Examples…' }).click();
    await gallery.getByRole('button', { name: new RegExp(`^${name}`) }).click();
    await expect(gallery).toHaveCount(0);
    await expect(nodes().nth(1), name).toBeVisible();
    // Attached rather than visible: a straight vertical edge has no width.
    await expect(page.locator('[data-testid^="rf__edge-work:"]').first(), name).toBeAttached();
    // Fitted into view, clear of the file bar.
    const bar = await box(page.getByRole('toolbar', { name: 'Canvas file' }));
    for (const n of await nodes().all())
      expect((await box(n)).y, name).toBeGreaterThan(bar.y + bar.height);
  }
});

test('keeps work both ways readable, gives messages room, and shows the menus of long queues', async () => {
  await page.getByRole('button', { name: 'Start from an example…' }).click();
  await page
    .getByRole('dialog', { name: 'Examples' })
    .getByRole('button', { name: /^Independent cross-check/ })
    .click();

  // Work both ways between two agents: each arrow's count stays clear of the other's, and of the
  // agents' cards.
  const there = await box(
    page.getByRole('button', { name: 'Open the work from Builder for Checker' }),
  );
  const back = await box(
    page.getByRole('button', { name: 'Open the work from Checker for Builder' }),
  );
  const cards = await Promise.all([box(card('Builder')), box(card('Checker'))]);
  const overlap = (a: Box, b: Box) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  expect(overlap(there, back)).toBe(false);
  for (const count of [there, back]) {
    for (const one of cards) expect(overlap(count, one)).toBe(false);
  }

  await node('Checker').dblclick();
  const panel = page.getByRole('dialog', { name: 'Checker' });
  await expect.poll(() => panel.evaluate((el) => el.getAnimations().length)).toBe(0);

  // A message's text gets the width of its row.
  const widths = await panel
    .getByRole('textbox', { name: 'Message to the agent' })
    .first()
    .evaluate((el) => ({
      text: el.getBoundingClientRect().width,
      row: el.closest('.graph-queue-row')?.getBoundingClientRect().width ?? 0,
    }));
  expect(widths.text).toBeGreaterThan(widths.row * 0.8);

  // The ⊕ under a long queue brings its menu into view.
  await panel.getByRole('button', { name: 'Add to queue' }).click();
  expectInside(await box(panel.getByRole('listbox', { name: 'Add to queue' })), await box(panel));
});

test('arranges the graph automatically while the toggle is on', async () => {
  const a = await addAgentAt('Agent 1', 650, 450);
  const b = await addAgentAt('Agent 2', 300, 150);
  const c = await addAgentAt('Agent 3', 900, 200);
  await connect(a, b);
  await connect(a, c);
  const toggle = page.getByRole('button', { name: 'Arrange automatically' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  // Top to bottom along the edges: Agent 1 above the two it points to, which share a row.
  const [boxA, boxB, boxC] = await Promise.all([box(a), box(b), box(c)]);
  expect(boxA.y + boxA.height).toBeLessThan(boxB.y);
  expect(boxB.y).toBeCloseTo(boxC.y, 0);

  // A new node joins the arrangement, clear of the others.
  const d = await addAgentAt('Agent 4', 150, 560);
  const boxes = await Promise.all([a, b, c, d].map(box));
  for (const [i, one] of boxes.entries()) {
    for (const other of boxes.slice(i + 1)) {
      const overlap =
        one.x < other.x + other.width &&
        other.x < one.x + one.width &&
        one.y < other.y + other.height &&
        other.y < one.y + one.height;
      expect(overlap).toBe(false);
    }
  }

  // Nodes stay where the arrangement puts them; turning it off lets them be dragged again.
  const held = await box(b);
  await drag(await center(b), { x: held.x + 200, y: held.y + 150 });
  expectSamePlace(await box(b), held);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await drag(await center(b), { x: held.x + 200, y: held.y + 150 });
  expect((await box(b)).x).toBeGreaterThan(held.x + 100);
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
  const a = await addAgentAt('Agent 1', 400, 200);
  const b = await addAgentAt('Agent 2', 650, 300);
  await marquee(a, b);
  await page.keyboard.press('ControlOrMeta+g');
  await expect(node('Group 1')).toBeVisible();

  // Click empty canvas, then Tab: the frame (first in the node layer), its '+', then Agent 1.
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
  const plus = page.getByRole('button', { name: 'Add a parent agent' });
  await expect(plus).toBeFocused();
  await expect.poll(() => plus.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

  await page.keyboard.press('Tab');
  await expect(focused).toHaveText('Agent 1');
  expect(await outline()).toBe('dashed');
});

test('double-click works inside the rectangle a marquee leaves around the selection', async () => {
  const a = await addAgentAt('Agent 1', 400, 200);
  const b = await addAgentAt('Agent 2', 650, 350);
  const rect = page.locator('.react-flow__nodesselection-rect');

  // On a node: opens that node alone.
  await marquee(a, b);
  await expect(rect).toHaveCount(1);
  const onA = await center(a);
  await page.mouse.dblclick(onA.x, onA.y);
  await expect(page.getByRole('dialog', { name: 'Agent 1' })).toBeVisible();
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
  await expect(node('Agent 3')).toBeVisible();
});
