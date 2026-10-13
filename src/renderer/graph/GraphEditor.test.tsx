import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CanvasFile } from '../../shared/ipc';
import { fromFile, toFile } from './file';
import { GraphEditor } from './GraphEditor';
import type { CanvasFiles } from './GraphEditor';
import { PADDING } from './graph';
import type { Graph, GraphNode } from './graph';

const agentNode = (
  id: string,
  x: number,
  y: number,
  extra: Partial<GraphNode> = {},
): GraphNode => ({
  id,
  type: 'agent',
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

function setup(initialGraph?: Graph, files?: CanvasFiles) {
  const { container } = render(
    <GraphEditor {...(initialGraph ? { initialGraph } : {})} {...(files ? { files } : {})} />,
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

afterEach(() => {
  vi.useRealTimers();
});

describe('GraphEditor', () => {
  it('adds a node on double-click on the empty canvas', () => {
    const { nodes, pane } = setup();
    fireEvent.doubleClick(pane, { clientX: 200, clientY: 100 });
    expect(nodes().map((n) => n.textContent)).toEqual(['Agent 1']);
  });

  it("starts a new agent's queue with a message to write, counted on its card once written", () => {
    const { nodes, pane } = setup();
    fireEvent.doubleClick(pane, { clientX: 200, clientY: 100 });
    const [card] = nodes();
    if (!card) throw new Error('no node');
    const count = () => card.querySelector('.graph-queue-count')?.getAttribute('data-count');
    expect(count()).toBeUndefined();
    fireEvent.doubleClick(card);
    const panel = within(screen.getByRole('dialog', { name: 'Agent 1' }));
    expect(panel.getAllByRole('button', { name: /^Move / }).map((b) => b.ariaLabel)).toEqual([
      'Move Message',
    ]);
    const message = panel.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Message to the agent',
    });
    expect(message.value).toBe('');
    fireEvent.change(message, { target: { value: 'Fix the flaky test' } });
    expect(count()).toBe('1');
  });

  it('adds a node inside a group when double-clicking its body', () => {
    const { nodes, node } = setup({ nodes: [frame], edges: [] });
    fireEvent.doubleClick(node('F'), { clientX: 200, clientY: 150 });
    expect(nodes('.react-flow__node-frame.parent')).toHaveLength(1);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('renames a node in place on F2: Enter keeps the text, Escape restores it', () => {
    const { node } = setup({ nodes: [agentNode('a', 0, 0, { selected: true })], edges: [] });
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
    const { nodes } = setup({ nodes: [agentNode('a', 0, 0, { selected: true })], edges: [] });
    fireEvent.keyDown(document.body, { key: 'F2' });
    fireEvent.keyDown(labelInput(), { key: 'Backspace' });
    expect(nodes()).toHaveLength(1);
  });

  it('renames a group in place on a double-click on its label bar', () => {
    const { node } = setup({ nodes: [frame], edges: [] });
    const title = node('F').querySelector('.graph-frame-title');
    if (!title) throw new Error('no title bar');
    fireEvent.doubleClick(title);
    fireEvent.change(labelInput(), { target: { value: 'Team' } });
    fireEvent.keyDown(labelInput(), { key: 'Enter' });
    expect(node('F').textContent).toBe('Team');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a double-clicked agent in a panel, where its queue is edited', () => {
    const { node, nodes } = setup({
      nodes: [agentNode('a', 0, 0), agentNode('b', 0, 100)],
      edges: [],
    });
    fireEvent.doubleClick(node('a'));
    const panel = within(screen.getByRole('dialog', { name: 'a' }));
    /** The queue, top to bottom, by its rows' handles (an if-then's rows follow it). */
    const order = () =>
      panel.queryAllByRole('button', { name: /^Move / }).map((b) => b.getAttribute('aria-label'));
    const field = () => panel.getByRole('combobox');
    const plus = (name = 'Add to queue') => {
      fireEvent.click(panel.getByRole('button', { name }));
    };

    // An action of the agent (Claude's, by default), then the agent it acts on.
    plus();
    fireEvent.click(panel.getByRole('option', { name: /^Read / }));
    fireEvent.keyDown(field(), { key: 'Enter' }); // this agent
    // Typing finds actions by what they do, after matches on their names: "run shell" finds Bash.
    plus();
    fireEvent.change(field(), { target: { value: 'run shell' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    fireEvent.change(field(), { target: { value: 'b' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(panel.getByRole('button', { name: 'Change the agent Bash acts on' }).textContent).toBe(
      '→ b',
    );

    // An if-then, with a message to the agent inside it.
    plus();
    fireEvent.click(panel.getByRole('option', { name: /^If… then/ }));
    fireEvent.click(panel.getByRole('option', { name: 'the previous step failed' }));
    plus('Add to If the previous step failed');
    fireEvent.click(panel.getByRole('option', { name: /^Message/ }));
    const note = panel.getByRole('textbox', { name: 'New message to the agent' });
    fireEvent.change(note, { target: { value: 'Try again, more carefully' } });
    fireEvent.keyDown(note, { key: 'Enter' });
    expect(order()).toEqual([
      'Move Read',
      'Move Bash',
      'Move If the previous step failed',
      'Move Message',
    ]);
    const message = panel.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Message to the agent',
    });
    expect(message.value).toBe('Try again, more carefully');
    fireEvent.change(message, { target: { value: 'Ask me first' } });
    expect(message.value).toBe('Ask me first');

    // Reorder from a handle (focus stays on it), retarget from a chip, remove.
    const handle = panel.getByRole('button', { name: 'Move Bash' });
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(order().slice(0, 2)).toEqual(['Move Bash', 'Move Read']);
    expect(document.activeElement).toBe(handle);
    fireEvent.click(panel.getByRole('button', { name: 'Change the agent Read acts on' }));
    fireEvent.click(panel.getByRole('option', { name: 'b' }));
    expect(panel.getByRole('button', { name: 'Change the agent Read acts on' }).textContent).toBe(
      '→ b',
    );
    fireEvent.click(panel.getByRole('button', { name: 'Remove Read' }));
    expect(order()).toEqual(['Move Bash', 'Move If the previous step failed', 'Move Message']);

    // Escape closes a dropdown first, then the panel; shortcuts are off while it is open.
    plus();
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(panel.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Delete' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(nodes().map((n) => n.dataset.id)).toEqual(['a', 'b']);
    expect(node('a').querySelector('.graph-queue-count')?.getAttribute('data-count')).toBe('2');
  });

  it('takes an if-then condition in your own words, for the agent to judge, and edits it', () => {
    const { node } = setup({ nodes: [agentNode('a', 0, 0)], edges: [] });
    fireEvent.doubleClick(node('a'));
    const panel = within(screen.getByRole('dialog', { name: 'a' }));
    const field = () => panel.getByRole<HTMLInputElement>('combobox');
    const chip = () => panel.getByRole('button', { name: /^Change the condition: / });
    fireEvent.click(panel.getByRole('button', { name: 'Add to queue' }));
    fireEvent.click(panel.getByRole('option', { name: /^If… then/ }));
    fireEvent.change(field(), { target: { value: 'the tests mention a flaky test' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(chip().textContent).toBe('the tests mention a flaky test');

    // Its chip reopens the dropdown with its words in the field, to change them.
    fireEvent.click(chip());
    expect(field().value).toBe('the tests mention a flaky test');
    fireEvent.change(field(), { target: { value: 'a test is flaky' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(chip().textContent).toBe('a test is flaky');
    expect(panel.getByRole('button', { name: 'Move If a test is flaky' })).toBeTruthy();
  });

  it('queues a delay, picked by typing how long, and changes it from its chip', () => {
    const { node } = setup({ nodes: [agentNode('a', 0, 0)], edges: [] });
    fireEvent.doubleClick(node('a'));
    const panel = within(screen.getByRole('dialog', { name: 'a' }));
    const field = () => panel.getByRole<HTMLInputElement>('combobox');
    const options = () => panel.getAllByRole('option').map((o) => o.firstChild?.textContent);
    fireEvent.click(panel.getByRole('button', { name: 'Add to queue' }));
    // Typing "wait" finds both ways to wait.
    fireEvent.change(field(), { target: { value: 'wait' } });
    expect(options().slice(0, 2)).toEqual(['Wait for…', 'Wait a while…']);
    fireEvent.click(panel.getByRole('option', { name: /^Wait a while…/ }));
    expect(field().getAttribute('aria-label')).toBe('Wait how long?');
    expect(field().placeholder).toBe('10 minutes, 1 hour, until 9:00…');
    expect(options()).toEqual([
      '5 minutes',
      '10 minutes',
      '30 minutes',
      '1 hour',
      '4 hours',
      'Until 9:00 AM',
    ]);
    // What is typed is read as the times it can mean, listed first.
    fireEvent.change(field(), { target: { value: '15' } });
    expect(options()).toEqual(['15 minutes', '15 hours', '15 seconds', 'Until 3:00 PM']);
    fireEvent.click(panel.getByRole('option', { name: '15 minutes' }));
    expect(panel.getByRole('button', { name: 'Move Wait 15 minutes' })).toBeTruthy();

    // Its chip reopens the picker with its time typed in, to change it.
    const chip = () => panel.getByRole('button', { name: /^Change how long it waits: / });
    expect(chip().textContent).toBe('15 minutes');
    fireEvent.click(chip());
    expect(field().value).toBe('15 minutes');
    fireEvent.change(field(), { target: { value: '1h30' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(chip().getAttribute('aria-label')).toBe('Change how long it waits: 1 hour 30 minutes');
    expect(panel.getByRole('button', { name: 'Move Wait 1 hour 30 minutes' })).toBeTruthy();
  });

  it("gives a wait a time limit from its 'at most…' chip, and takes it off again", () => {
    const queue = [{ id: 'w', waitFor: [{ agent: 'a' }] }];
    const { node } = setup({
      nodes: [agentNode('a', 0, 0), agentNode('b', 0, 100, { data: { label: 'b', queue } })],
      edges: [],
    });
    fireEvent.doubleClick(node('b'));
    const panel = within(screen.getByRole('dialog', { name: 'b' }));
    const add = panel.getByRole('button', { name: 'Add a time limit' });
    expect([add.textContent, add.title, add.hasAttribute('data-more')]).toEqual([
      'at most…',
      'Go on anyway if it is not done in time',
      true,
    ]);
    fireEvent.click(add);
    expect(panel.getByRole('combobox').getAttribute('aria-label')).toBe('Go on anyway after…');
    fireEvent.click(panel.getByRole('option', { name: '30 minutes' }));
    const limit = panel.getByRole('button', { name: 'Change the time limit: at most 30 minutes' });
    expect(limit.textContent).toBe('at most 30 minutes');
    expect(panel.getByRole('button', { name: 'Move Wait for a, at most 30 minutes' })).toBeTruthy();
    expect(panel.queryByRole('button', { name: 'Add a time limit' })).toBeNull();

    // Its chip offers to take it off first.
    fireEvent.click(limit);
    expect(panel.getAllByRole('option')[0]?.textContent).toBe('No time limit');
    fireEvent.click(panel.getByRole('option', { name: 'No time limit' }));
    expect(panel.getByRole('button', { name: 'Move Wait for a' })).toBeTruthy();
    expect(panel.getByRole('button', { name: 'Add a time limit' })).toBeTruthy();
  });

  it('checks whether a wait ran out of time, striking the condition out where no wait is before it', () => {
    const { node } = setup({
      nodes: [
        agentNode('a', 0, 0, { data: { label: 'a', queue: [{ id: 'm', message: 'Build it' }] } }),
        agentNode('b', 0, 100, {
          data: {
            label: 'b',
            queue: [
              { id: 'w', waitFor: [{ agent: 'a' }], timeout: { seconds: 60 } },
              { id: 'd', delay: { seconds: 60 } },
              { id: 'late', if: { kind: 'timedOut' }, then: [] },
            ],
          },
        }),
      ],
      edges: [],
    });
    fireEvent.doubleClick(node('a'));
    const panel = within(screen.getByRole('dialog', { name: 'a' }));
    fireEvent.click(panel.getByRole('button', { name: 'Add to queue' }));
    fireEvent.click(panel.getByRole('option', { name: /^If… then/ }));
    expect(panel.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'the previous step succeeded',
      'the previous step failed',
      'the output contains…',
      'the wait ran out of time',
    ]);
    fireEvent.click(panel.getByRole('option', { name: 'the wait ran out of time' }));
    // After a message, there is no wait to run out of time.
    const chip = panel.getByRole('button', {
      name: 'Change the condition: the wait ran out of time',
    });
    expect(chip.hasAttribute('data-unavailable')).toBe(true);
    expect(chip.title).toBe('No wait right before this If');

    // After a wait, it can hold: a delay between the two is passed over.
    fireEvent.click(panel.getByRole('button', { name: 'Back to the canvas' }));
    fireEvent.doubleClick(node('b'));
    const other = within(screen.getByRole('dialog', { name: 'b' }));
    const fits = other.getByRole('button', {
      name: 'Change the condition: the wait ran out of time',
    });
    expect(fits.hasAttribute('data-unavailable')).toBe(false);
    expect(fits.title).toBe('');
  });

  it('queues your OK on the work before it, or on what you name, and changes it from its chip', () => {
    const { node } = setup({ nodes: [agentNode('a', 0, 0)], edges: [] });
    fireEvent.doubleClick(node('a'));
    const panel = within(screen.getByRole('dialog', { name: 'a' }));
    const field = () => panel.getByRole<HTMLInputElement>('combobox');
    const options = () => panel.getAllByRole('option').map((o) => o.firstChild?.textContent);
    const plus = (name = 'Add to queue') => {
      fireEvent.click(panel.getByRole('button', { name }));
    };
    // Typing "wait", "ok" or "approve" finds it.
    plus();
    fireEvent.change(field(), { target: { value: 'wait' } });
    expect(options().slice(0, 3)).toEqual(['Wait for…', 'Wait a while…', 'Wait for your OK…']);
    for (const typed of ['ok', 'approve']) {
      fireEvent.change(field(), { target: { value: typed } });
      expect(options()[0]).toBe('Wait for your OK…');
    }
    const choice = panel.getByRole('option', { name: /^Wait for your OK…/ });
    expect(choice.textContent).toBe(
      'Wait for your OK… Hold here until you approve, ask for changes, or stop',
    );
    fireEvent.click(choice);
    expect(field().getAttribute('aria-label')).toBe('Your OK on…');
    expect(field().placeholder).toBe('What you check, e.g. the spec in SPEC.md…');
    expect(options()).toEqual(['The work before it']);
    fireEvent.click(panel.getByRole('option', { name: 'The work before it' }));
    expect(panel.getByRole('button', { name: 'Move Your OK on the work before it' })).toBeTruthy();

    // Or on what you name, in your own words.
    plus();
    fireEvent.click(panel.getByRole('option', { name: /^Wait for your OK…/ }));
    fireEvent.change(field(), { target: { value: 'the spec in SPEC.md' } });
    expect(panel.getAllByRole('option').map((o) => o.textContent)).toEqual([
      '“the spec in SPEC.md” In your own words',
    ]);
    fireEvent.keyDown(field(), { key: 'Enter' });
    const chip = () => panel.getByRole('button', { name: /^Change what you OK: the spec/ });
    expect(chip().getAttribute('aria-label')).toBe('Change what you OK: the spec in SPEC.md');
    expect(chip().textContent).toBe('the spec in SPEC.md');
    expect(chip().closest('.graph-queue-row')?.getAttribute('data-mark')).toBe('ok');

    // Its chip reopens the picker with its words in the field.
    fireEvent.click(chip());
    expect(field().value).toBe('the spec in SPEC.md');
    fireEvent.change(field(), { target: { value: 'the spec in SPEC.md and its tests' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(chip().textContent).toBe('the spec in SPEC.md and its tests');

    // An if-then holds steps and messages, not OKs.
    plus();
    fireEvent.click(panel.getByRole('option', { name: /^If… then/ }));
    fireEvent.click(panel.getByRole('option', { name: 'the previous step failed' }));
    plus('Add to If the previous step failed');
    expect(options()).not.toContain('Wait for your OK…');
    expect(options()).toContain('Message');
  });

  it('repeats steps until a condition holds, a few rounds at most, changed from its chips', () => {
    const { node } = setup({ nodes: [agentNode('a', 0, 0)], edges: [] });
    fireEvent.doubleClick(node('a'));
    const panel = within(screen.getByRole('dialog', { name: 'a' }));
    const field = () => panel.getByRole<HTMLInputElement>('combobox');
    const options = () => panel.getAllByRole('option').map((o) => o.firstChild?.textContent);
    const plus = (name = 'Add to queue') => {
      fireEvent.click(panel.getByRole('button', { name }));
    };
    // Offered right after If… then; "repeat", "loop" or "round" finds it.
    plus();
    expect(options().slice(0, 6)).toEqual([
      'If… then',
      'Repeat until…',
      'Wait for…',
      'Wait a while…',
      'Wait for your OK…',
      'Message',
    ]);
    for (const typed of ['repeat', 'loop', 'round']) {
      fireEvent.change(field(), { target: { value: typed } });
      expect(options()[0]).toBe('Repeat until…');
    }
    const choice = panel.getByRole('option', { name: /^Repeat until…/ });
    expect(choice.textContent).toBe(
      'Repeat until… Loop: run steps again until a condition holds, a few rounds at most',
    );
    fireEvent.click(choice);
    expect(field().getAttribute('aria-label')).toBe('Repeat until…');
    expect(field().placeholder).toBe('Pick when to stop, or describe it…');
    expect(options()).toEqual([
      'its last step succeeds',
      'its last step fails',
      'the output contains…',
    ]);
    fireEvent.click(panel.getByRole('option', { name: 'the output contains…' }));
    const text = panel.getByRole('textbox', { name: 'Text to look for' });
    fireEvent.change(text, { target: { value: 'Converged' } });
    fireEvent.keyDown(text, { key: 'Enter' });

    // A card: when it stops, up to 3 rounds, then ask me; each a chip.
    expect(
      panel.getByRole('button', { name: 'Move Repeat until the output contains “Converged”' }),
    ).toBeTruthy();
    const until = panel.getByRole('button', {
      name: 'Change when it stops: the output contains “Converged”',
    });
    expect(until.textContent).toBe('the output contains “Converged”');
    const rounds = () => panel.getByRole('button', { name: /^Change how many rounds: / });
    const then = () =>
      panel.getByRole('button', { name: /^Change what happens after the last round: / });
    expect([rounds().textContent, then().textContent]).toEqual(['up to 3 rounds', 'then ask me']);

    // Typing 5 finds 5 rounds; Go on carries on with the queue.
    fireEvent.click(rounds());
    expect(field().getAttribute('aria-label')).toBe('How many rounds at most?');
    expect(options()).toHaveLength(20);
    fireEvent.change(field(), { target: { value: '5' } });
    expect(options()[0]).toBe('5 rounds');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(rounds().getAttribute('aria-label')).toBe('Change how many rounds: up to 5 rounds');
    fireEvent.click(then());
    expect(panel.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Ask me Stop and ask: one more round, or go on',
      'Go on Carry on with the queue; an If after it sees that it failed',
    ]);
    fireEvent.click(panel.getByRole('option', { name: /^Go on/ }));
    expect(then().getAttribute('aria-label')).toBe(
      'Change what happens after the last round: then go on',
    );
    expect(then().textContent).toBe('then go on');

    // Its own ⊕ adds what it runs each round: waits, delays, messages and actions; no if-thens.
    plus('Add to Repeat until the output contains “Converged”');
    expect(options().slice(0, 4)).toEqual(['Wait for…', 'Wait a while…', 'Message', 'Read']);
    expect(options()).not.toContain('If… then');
    expect(options()).not.toContain('Repeat until…');
    expect(options()).not.toContain('Wait for your OK…');
    fireEvent.click(panel.getByRole('option', { name: /^Message/ }));
    const note = panel.getByRole('textbox', { name: 'New message to the agent' });
    fireEvent.change(note, { target: { value: 'Tune the model' } });
    fireEvent.keyDown(note, { key: 'Enter' });
    const inner = panel.getByRole('list', { name: 'Each round: the output contains “Converged”' });
    expect(
      within(inner)
        .getAllByRole('button', { name: /^Move / })
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Move Message']);

    // Its condition, in your own words, is changed starting from them.
    fireEvent.click(until);
    fireEvent.change(field(), { target: { value: 'the loss stops falling' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    const words = panel.getByRole('button', { name: /^Change when it stops: / });
    expect(words.textContent).toBe('the loss stops falling');
    fireEvent.click(words);
    expect(field().value).toBe('the loss stops falling');
  });

  it("goes round with another agent's repeat, and waits for a step inside one, round by round", () => {
    const judging = {
      id: 'judging',
      repeat: [{ id: 'judge', message: 'Judge both versions' }],
      until: { kind: 'outputContains' as const, text: 'WINNER' },
      rounds: 2,
      otherwise: 'goOn' as const,
    };
    const { node } = setup({
      nodes: [
        agentNode('j', 0, 0, { data: { label: 'Judge', queue: [judging] } }),
        agentNode('c', 0, 100, { data: { label: 'Claude', queue: [] } }),
      ],
      edges: [],
    });
    fireEvent.doubleClick(node('c'));
    const panel = within(screen.getByRole('dialog', { name: 'Claude' }));
    const plus = (name = 'Add to queue') => {
      fireEvent.click(panel.getByRole('button', { name }));
    };
    plus();
    fireEvent.click(panel.getByRole('option', { name: /^Repeat until…/ }));
    // Another agent's repeat, after the conditions: go round with it.
    const leader = panel.getByRole('option', { name: /^Judge's repeat ends/ });
    expect(leader.textContent).toBe(
      "Judge's repeat ends Go round with it: as many rounds as Judge's repeat",
    );
    fireEvent.click(leader);
    // It runs as many rounds as the judge's: its own are not shown.
    expect(
      panel.getByRole('button', { name: "Change when it stops: Judge's repeat ends" }),
    ).toBeTruthy();
    expect(panel.queryByRole('button', { name: /^Change how many rounds/ })).toBeNull();
    expect(panel.queryByRole('button', { name: /^Change what happens after/ })).toBeNull();

    // A wait inside it, for a step inside the judge's repeat, picked in the judge's queue beside.
    plus("Add to Repeat until Judge's repeat ends");
    fireEvent.click(panel.getByRole('option', { name: /^Wait for…/ }));
    fireEvent.click(panel.getByRole('option', { name: 'Judge' }));
    const beside = within(panel.getByRole('complementary', { name: "Judge's queue" }));
    fireEvent.click(beside.getByRole('button', { name: 'Wait for Judge: “Judge both versions”' }));
    expect(
      panel.getByRole('button', { name: 'Move Wait for Judge: “Judge both versions”' }),
    ).toBeTruthy();

    // The judge's repeat names who goes round with it.
    expect(beside.getByText('Claude goes round with it')).toBeTruthy();
    // Its own waits are offered the steps inside Claude's repeat: each round inside a repeat, and
    // once that repeat is over outside one.
    const choices = () => beside.getAllByRole('option').map((o) => o.textContent);
    fireEvent.click(
      beside.getByRole('button', { name: 'Add to Repeat until the output contains “WINNER”' }),
    );
    fireEvent.click(beside.getByRole('option', { name: /^Wait for…/ }));
    expect(choices()).toEqual([
      'Claude All of its work',
      'Claude: its repeat All of its rounds',
      'Claude: its wait This step, each round',
    ]);
    fireEvent.keyDown(beside.getByRole('combobox'), { key: 'Escape' });
    fireEvent.click(beside.getByRole('button', { name: "Add to Judge's queue" }));
    fireEvent.click(beside.getByRole('option', { name: /^Wait for…/ }));
    expect(choices().at(-1)).toBe('Claude: its wait This step, once its repeat is over');
    fireEvent.keyDown(beside.getByRole('combobox'), { key: 'Escape' });

    // Claude's repeat goes round with the judge's, so it is not offered back to the judge.
    fireEvent.click(beside.getByRole('button', { name: /^Change when it stops/ }));
    expect(beside.getAllByRole('option').map((o) => o.firstChild?.textContent)).toEqual([
      'its last step succeeds',
      'its last step fails',
      'the output contains…',
    ]);
  });

  it('asks for your OK on the canvas while the run holds an agent at one', () => {
    const queue = (approve: string) => [
      { id: 'spec', action: 'Read' },
      { id: 'ok', approve },
      { id: 'next', action: 'Grep' },
    ];
    const { node } = setup({
      nodes: [
        agentNode('a', 0, 0, { data: { label: 'Planner', queue: queue('the spec in SPEC.md') } }),
        agentNode('b', 0, 100, { data: { label: 'Builder', queue: queue('') } }),
        agentNode('c', 0, 200, { data: { label: 'Tester', queue: queue('the tests') } }),
      ],
      edges: [],
    });
    const sidebar = () => screen.queryByRole('complementary', { name: 'Needs you' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(screen.getByRole('button', { name: 'Show all queues' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(['a', 'b', 'c'].map((id) => node(id).classList.contains('asking'))).toEqual([
      true,
      true,
      true,
    ]);

    // The sidebar asks for each, in graph order, after the work it is on.
    const list = within(sidebar() ?? document.body);
    expect(list.getByRole('heading').textContent).toBe('Needs you 3');
    const card = (agent: string) => {
      const chip = list.getByRole('button', { name: `Open ${agent}` });
      const found = chip.closest<HTMLElement>('.graph-question');
      if (!found) throw new Error(`no card for ${agent}`);
      return within(found);
    };
    expect(card('Planner').getByText('Your OK on the spec in SPEC.md?')).toBeTruthy();
    expect(card('Planner').getByText('After Read')).toBeTruthy();
    expect(card('Builder').getByText('Your OK on the work before it?')).toBeTruthy();

    // Approve, Stop here and Ask for changes act on the run; each card then leaves.
    fireEvent.click(card('Planner').getByRole('button', { name: 'Approve' }));
    fireEvent.click(card('Builder').getByRole('button', { name: 'Stop here' }));
    const reply = card('Tester').getByRole('textbox', { name: 'What should change?' });
    fireEvent.change(reply, { target: { value: 'Test the empty state' } });
    fireEvent.click(card('Tester').getByRole('button', { name: 'Ask for changes' }));
    expect(sidebar()).toBeNull();
    expect(['a', 'b', 'c'].map((id) => node(id).classList.contains('asking'))).toEqual([
      false,
      false,
      false,
    ]);
    // The Tester works on the changes asked for, in its session.
    expect(node('c').classList.contains('working')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show all queues' }));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    const run = (name: string) =>
      queues.getByRole('group', { name }).querySelector('[data-run]')?.getAttribute('data-run');
    expect(run('Planner: Your OK on the spec in SPEC.md')).toBe('succeeded');
    expect(run('Planner: Grep')).toBe('running');
    expect(run('Builder: Your OK on the work before it')).toBe('stopped');
    expect(run('Tester: Your OK on the tests')).toBe('running');
  });

  it("offers a Claude agent Claude Code's own tools, Workflow included", () => {
    const { node } = setup({ nodes: [agentNode('a', 0, 0)], edges: [] });
    fireEvent.doubleClick(node('a'));
    const panel = within(screen.getByRole('dialog', { name: 'a' }));
    fireEvent.click(panel.getByRole('button', { name: 'Add to queue' }));
    fireEvent.change(panel.getByRole('combobox'), { target: { value: 'workflow' } });
    expect(panel.getAllByRole('option')[0]?.firstChild?.textContent).toBe('Workflow');
  });

  it("shows each node's agent type, and changes it from the node's panel", () => {
    const { node } = setup({
      nodes: [
        agentNode('a', 0, 0, { data: { label: 'a', agent: 'Codex' } }),
        agentNode('b', 0, 100),
      ],
      edges: [],
    });
    const tag = (id: string) => node(id).querySelector('.graph-agent')?.getAttribute('data-agent');
    expect([tag('a'), tag('b')]).toEqual(['Codex', 'Claude']);
    expect(node('a').getAttribute('aria-label')).toBe('a, Codex');

    fireEvent.doubleClick(node('a'));
    const panel = within(screen.getByRole('dialog', { name: 'a' }));
    fireEvent.click(panel.getByRole('button', { name: 'Agent: Codex' }));
    fireEvent.click(panel.getByRole('option', { name: 'Qwen' }));
    expect(tag('a')).toBe('Qwen');
    expect(panel.getByRole('button', { name: 'Agent: Qwen' })).toBeTruthy();
  });

  it('lets agents ask questions: they glow, a sidebar lists them by agent, answering clears them', () => {
    const question = { id: 'q1', text: 'Which branch?', options: ['main', 'dev'] };
    const { node } = setup({
      nodes: [
        agentNode('a', 0, 0, { data: { label: 'Planner', agent: 'Codex', questions: [question] } }),
        agentNode('b', 0, 100),
      ],
      edges: [],
    });
    const sidebar = () => screen.queryByRole('complementary', { name: 'Needs you' });
    expect(node('a').classList.contains('asking')).toBe(true);
    expect(node('b').classList.contains('asking')).toBe(false);
    expect(node('a').querySelector('.graph-question-count')?.getAttribute('data-count')).toBe('1');
    const list = within(sidebar() ?? document.body);
    expect(list.getByRole('button', { name: 'Open Planner' })).toBeTruthy();
    expect(list.getByText('Which branch?')).toBeTruthy();

    fireEvent.click(list.getByRole('button', { name: 'dev' }));
    expect(sidebar()).toBeNull();
    expect(node('a').classList.contains('asking')).toBe(false);
  });

  it("answers in an agent's panel, where a question can be simulated until agents are connected", () => {
    const { node } = setup({ nodes: [agentNode('a', 0, 0)], edges: [] });
    fireEvent.doubleClick(node('a'));
    const panel = within(screen.getByRole('dialog', { name: 'a' }));
    fireEvent.click(panel.getByRole('button', { name: 'Simulate a question' }));
    const reply = panel.getByRole('textbox', { name: 'Your answer' });
    fireEvent.change(reply, { target: { value: 'Use the new API' } });
    fireEvent.keyDown(reply, { key: 'Enter' });
    expect(panel.getByText('You answered: Use the new API')).toBeTruthy();
    expect(panel.queryByRole('textbox', { name: 'Your answer' })).toBeNull();
  });

  it('opens only a double-clicked node that is part of a multi-selection', () => {
    const { node, nodes } = setup({
      nodes: [agentNode('a', 0, 0, { selected: true }), agentNode('b', 0, 100, { selected: true })],
      edges: [],
    });
    fireEvent.doubleClick(node('a'));
    expect(nodes('.react-flow__node.selected').map((n) => n.dataset.id)).toEqual(['a']);
    expect(screen.getByRole('dialog', { name: 'a' })).toBeTruthy();
  });

  it("groups a selection from its actions, and ungroups from the group's", () => {
    const { nodes } = setup({
      nodes: [agentNode('a', 0, 0, { selected: true }), agentNode('b', 0, 100, { selected: true })],
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
      nodes: [agentNode('a', 0, 0, { selected: true }), agentNode('b', 0, 100, { selected: true })],
      edges: [],
    });
    fireEvent.keyDown(document.body, { key: 'g', code: 'KeyG', ctrlKey: true });
    expect(nodes('.react-flow__node-frame').map((n) => n.textContent)).toEqual(['Group 1']);
  });

  it("cannot group nodes from different groups, and the selection's Group button says why", () => {
    setup({
      nodes: [
        frame,
        agentNode('a', 20, 52, { parentId: 'F', selected: true }),
        agentNode('b', 500, 0, { selected: true }),
      ],
      edges: [],
    });
    const group = actions('a b').getByRole<HTMLButtonElement>('button', { name: 'Group' });
    expect(group.disabled).toBe(true);
    expect(group.title).toBe('Only agents in the same group can be grouped');
  });

  it("gives a group a parent node from the '+' on its top border", () => {
    const { node, nodes } = setup({
      nodes: [frame, agentNode('a', 20, 52, { parentId: 'F' })],
      edges: [],
    });
    fireEvent.click(button('Add a parent agent'));
    expect(nodes('.react-flow__node-agent.parent').map((n) => n.dataset.id)).toEqual(['F']);
    expect(node('F').textContent).toBe('Agent 1');
    expect(node('F').classList.contains('selected')).toBe(true);
  });

  it("shows a node's actions on hover: Delete, and Remove from group inside a group", () => {
    const { node, nodes } = setup({
      nodes: [frame, agentNode('a', 20, 52, { parentId: 'F' }), agentNode('b', 500, 0)],
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

  it("colours each group's nodes, and gives a new group the next colour", () => {
    const { node } = setup({
      nodes: [
        { ...frame, data: { label: 'Group 1', color: 0 } },
        agentNode('a', 20, 52, { parentId: 'F' }),
        agentNode('b', 500, 0, { selected: true }),
        agentNode('c', 500, 100, { selected: true }),
      ],
      edges: [],
    });
    const color = (id: string) => /group-color-(\d+)/.exec(node(id).className)?.[1];
    expect([color('F'), color('a'), color('b')]).toEqual(['0', '0', undefined]);
    fireEvent.keyDown(document.body, { key: 'g', code: 'KeyG', ctrlKey: true });
    expect([color('b'), color('c')]).toEqual(['1', '1']);
  });

  it('arranges the graph while the toggle is on, and lets nodes be dragged again when off', () => {
    const { node } = setup({
      nodes: [agentNode('a', 300, 300), agentNode('b', 0, 0)],
      edges: [{ id: 'a->b', source: 'a', target: 'b' }],
    });
    const y = (id: string) =>
      Number(/translate\([^,]+,\s*([-\d.]+)px\)/.exec(node(id).style.transform)?.[1]);
    const toggle = button('Arrange automatically');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(y('a')).toBeGreaterThan(y('b'));

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(y('a')).toBeLessThan(y('b'));
    expect(node('a').classList.contains('draggable')).toBe(false);

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(y('a')).toBeLessThan(y('b'));
    expect(node('a').classList.contains('draggable')).toBe(true);
  });

  it('draws the work a queue gives another agent as an arrow, which opens the work between them', () => {
    const queue = [
      { id: 'm', message: 'Fix the tests' },
      { id: 's', action: 'Read', target: 'b' },
    ];
    const { container } = setup({
      nodes: [agentNode('a', 0, 0, { data: { label: 'a', queue } }), agentNode('b', 0, 100)],
      edges: [{ id: 'a->b', source: 'a', target: 'b' }],
    });
    const edge = (id: string) => container.querySelector(`[data-testid="rf__edge-${id}"]`);
    // Work implies the agents can talk: it takes the place of their link.
    expect(edge('work:a->b')?.getAttribute('aria-label')).toBe('Work from a for b: 1 queued');
    expect(edge('a->b')).toBeNull();

    fireEvent.click(button('Open the work from a for b'));
    const panel = within(screen.getByRole('dialog', { name: 'Work from a for b' }));
    const order = () => panel.queryAllByRole('button', { name: /^Move / }).map((b) => b.ariaLabel);
    // Only a's items for b, not its message; ⊕ queues one of a's actions, aimed at b.
    expect(order()).toEqual(['Move Read']);
    fireEvent.click(panel.getByRole('button', { name: 'Queue work for b' }));
    fireEvent.click(panel.getByRole('option', { name: /^Bash / }));
    expect(order()).toEqual(['Move Read', 'Move Bash']);
    expect(panel.getByRole('button', { name: 'Change the agent Bash acts on' }).textContent).toBe(
      '→ b',
    );
    expect(button('Open the work from a for b').textContent).toBe('2');

    // Without work, the link shows again.
    fireEvent.click(panel.getByRole('button', { name: 'Remove Read' }));
    fireEvent.click(panel.getByRole('button', { name: 'Remove Bash' }));
    expect(edge('work:a->b')).toBeNull();
    expect(edge('a->b')?.getAttribute('aria-label')).toBe('a and b can talk');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sends a message to another agent, which draws an arrow, marked "if" on a condition', () => {
    const queue = [
      { id: 'i', if: { kind: 'failed' as const }, then: [{ id: 'm', message: 'Take over' }] },
    ];
    const { container, node } = setup({
      nodes: [agentNode('a', 0, 0, { data: { label: 'a', queue } }), agentNode('lead', 0, 100)],
      edges: [],
    });
    fireEvent.doubleClick(node('a'));
    const panel = within(screen.getByRole('dialog', { name: 'a' }));
    const chip = panel.getByRole('button', { name: 'Change the agent the message goes to' });
    expect(chip.textContent).toBe('→ this agent');
    fireEvent.click(chip);
    fireEvent.click(panel.getByRole('option', { name: 'lead' }));
    expect(chip.textContent).toBe('→ lead');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    const edge = container.querySelector('[data-testid="rf__edge-work:a->lead"]');
    expect(edge?.getAttribute('aria-label')).toBe('Work from a for lead: 1 queued, on a condition');
    const count = () => button('Open the work from a for lead');
    expect(count().textContent).toBe('if 1');

    // The work panel's ⊕ sends messages too: no longer all on a condition.
    fireEvent.click(count());
    const work = within(screen.getByRole('dialog', { name: 'Work from a for lead' }));
    fireEvent.click(work.getByRole('button', { name: 'Queue work for lead' }));
    fireEvent.click(work.getByRole('option', { name: /^Message/ }));
    const text = work.getByRole('textbox', { name: 'New message to the agent' });
    fireEvent.change(text, { target: { value: 'Start now' } });
    fireEvent.keyDown(text, { key: 'Enter' });
    expect(count().textContent).toBe('2');
  });

  it('queues a wait for other agents, drawn as an arrow from each, opening to the waiting queue', () => {
    const { container, node } = setup({
      nodes: [agentNode('a', 0, 0), agentNode('b', 0, 100), agentNode('c', 200, 0)],
      edges: [],
    });
    const edge = (id: string) => container.querySelector(`[data-testid="rf__edge-${id}"]`);
    fireEvent.doubleClick(node('b'));
    const panel = within(screen.getByRole('dialog', { name: 'b' }));
    fireEvent.click(panel.getByRole('button', { name: 'Add to queue' }));
    fireEvent.click(panel.getByRole('option', { name: /^Wait for…/ }));
    fireEvent.click(panel.getByRole('option', { name: 'a' }));
    // Another agent joins the wait: the queue goes on once both have finished.
    fireEvent.click(panel.getByRole('button', { name: 'Wait for something else' }));
    expect(panel.getAllByRole('option').map((o) => o.textContent)).toEqual(['c']);
    fireEvent.click(panel.getByRole('option', { name: 'c' }));
    expect(panel.getByRole('button', { name: 'Move Wait for a and c' })).toBeTruthy();
    fireEvent.click(panel.getByRole('button', { name: 'Back to the canvas' }));
    expect(edge('work:a->b')?.getAttribute('aria-label')).toBe('Work from a for b: 1 queued');
    expect(edge('work:c->b')).not.toBeNull();

    // The arrow opens the queue that waits, where an agent can come off the wait.
    fireEvent.click(button('Open the work from a for b'));
    const work = within(screen.getByRole('dialog', { name: 'Work from a for b' }));
    const waiting = within(work.getByRole('region', { name: "In b's queue" }));
    fireEvent.click(waiting.getByRole('button', { name: 'Stop waiting for a' }));
    expect(edge('work:a->b')).toBeNull();
    expect(edge('work:c->b')).not.toBeNull();
  });

  it("picks the step to wait for in the other agent's queue, shown beside, linked to the wait", () => {
    const queue = [
      { id: 'research', action: 'Workflow' },
      { id: 'm', message: 'Write up what you found' },
    ];
    const { node } = setup({
      nodes: [agentNode('a', 0, 0, { data: { label: 'a', queue } }), agentNode('b', 0, 100)],
      edges: [],
    });
    fireEvent.doubleClick(node('b'));
    const view = within(screen.getByRole('dialog', { name: 'b' }));
    const links = () => screen.getByRole('dialog', { name: 'b' }).querySelectorAll('[data-link]');
    fireEvent.click(view.getByRole('button', { name: 'Add to queue' }));
    fireEvent.click(view.getByRole('option', { name: /^Wait for…/ }));
    fireEvent.click(view.getByRole('option', { name: 'a' }));

    // b waits for all of a's work until a step of a's, in its queue beside b's, is picked.
    expect(view.getByRole('button', { name: 'Move Wait for a' })).toBeTruthy();
    // a's queue, as editable there as anywhere, picks: one of its tasks, or its end.
    const beside = within(view.getByRole('complementary', { name: "a's queue" }));
    expect(
      beside
        .getAllByRole('button', { name: /^Wait for / })
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual([
      'Wait for a: Workflow',
      'Wait for a: “Write up what you found”',
      "Wait for all of a's work",
    ]);
    expect(beside.getByRole('button', { name: 'Remove Workflow' })).toBeTruthy();
    fireEvent.click(beside.getByRole('button', { name: 'Wait for a: Workflow' }));
    const wait = view.getByRole('button', { name: 'Move Wait for a: Workflow' });
    // Marked as tasks are wherever a queue shows: the wait, and the step it waits for.
    expect(wait.closest('[data-mark]')?.getAttribute('data-mark')).toBe('wait');
    const step = beside.getByRole('button', { name: 'Move Workflow' }).closest('.graph-queue-row');
    expect(step?.hasAttribute('data-waited-for')).toBe(true);
    // The two queues stay side by side, the wait linked to the step it waits for.
    expect(beside.queryByRole('button', { name: /^Wait for / })).toBeNull();
    expect(links()).toHaveLength(1);

    // Its chip picks again; Escape stops picking, then hides a's queue, then closes the view.
    fireEvent.click(view.getByRole('button', { name: 'Change what it waits for: a: Workflow' }));
    fireEvent.click(beside.getByRole('button', { name: "Wait for all of a's work" }));
    expect(view.getByRole('button', { name: 'Move Wait for a' })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Change what it waits for: a' }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(beside.queryByRole('button', { name: /^Wait for / })).toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(view.queryByRole('complementary', { name: "a's queue" })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'b' })).toBeTruthy();
  });

  it('deletes a selected link from its button', () => {
    const { container } = setup({
      nodes: [agentNode('a', 0, 0), agentNode('b', 0, 100)],
      edges: [{ id: 'a->b', source: 'a', target: 'b', selected: true }],
    });
    fireEvent.click(button('Delete link'));
    expect(container.querySelector('[data-testid="rf__edge-a->b"]')).toBeNull();
  });

  it('deletes a group but keeps its contents, and removes edges of deleted agents', () => {
    const { container, nodes } = setup({
      nodes: [
        { ...frame, selected: true },
        agentNode('a', 20, 52, { parentId: 'F' }),
        agentNode('b', 500, 0, { selected: true }),
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
        agentNode('c', 400, 50, { parentId: 'G' }),
      ],
      edges: [],
    });
    // React Flow measures c on mount; G must shrink around it and H around G.
    const width = (id: string) =>
      parseFloat(container.querySelector<HTMLElement>(`[data-id="${id}"]`)?.style.width ?? '');
    expect(width('G')).toBeLessThan(200);
    expect(width('H')).toBe(width('G') + 2 * PADDING);
  });

  it('names links by the labels of their agents, and follows renames', () => {
    const { container, node } = setup({
      nodes: [
        agentNode('a', 0, 0, { data: { label: 'Alpha' } }),
        agentNode('b', 0, 100, { data: { label: 'Beta' } }),
      ],
      edges: [{ id: 'a->b', source: 'a', target: 'b' }],
    });
    const edge = () => container.querySelector('[data-testid="rf__edge-a->b"]');
    expect(edge()?.getAttribute('aria-label')).toBe('Alpha and Beta can talk');
    // Renamed in the panel a double-click opens.
    fireEvent.doubleClick(node('a'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Gamma' } });
    expect(screen.getByRole('dialog', { name: 'Gamma' })).toBeTruthy();
    expect(edge()?.getAttribute('aria-label')).toBe('Gamma and Beta can talk');
  });

  describe('canvas files', () => {
    /** Stands in for window.api: opens `opened`, saves as team.corral. */
    const fakeFiles = (opened: CanvasFile | null = null) => ({
      open: vi.fn<CanvasFiles['open']>().mockResolvedValue(opened),
      save: vi.fn<CanvasFiles['save']>().mockResolvedValue('team.corral'),
      forget: vi.fn<CanvasFiles['forget']>().mockResolvedValue(null),
    });
    const coder: Graph = {
      nodes: [agentNode('x', 0, 0, { data: { label: 'Coder' } })],
      edges: [],
    };

    it('saves the canvas, and titles the window with its file and whether it is edited', async () => {
      const files = fakeFiles();
      const { pane } = setup(undefined, files);
      expect(document.title).toBe('Untitled — corrallm');
      fireEvent.doubleClick(pane, { clientX: 200, clientY: 100 });
      expect(document.title).toBe('Untitled (edited) — corrallm');

      fireEvent.click(button('Save'));
      await waitFor(() => {
        expect(document.title).toBe('team.corral — corrallm');
      });
      const [text, choose] = files.save.mock.calls[0] ?? [];
      expect(choose).toBe(false);
      expect(fromFile(text ?? '').nodes.map((n) => n.data.label)).toEqual(['Agent 1']);

      // Ctrl/⌘ Shift S saves as, Ctrl/⌘ S saves.
      fireEvent.keyDown(document.body, { key: 's', ctrlKey: true, shiftKey: true });
      expect(files.save).toHaveBeenLastCalledWith(expect.any(String), true);
      fireEvent.keyDown(document.body, { key: 's', ctrlKey: true });
      expect(files.save).toHaveBeenLastCalledWith(expect.any(String), false);
    });

    it('opens a canvas file and starts new ones, asking before unsaved changes are lost', async () => {
      const files = fakeFiles({ name: 'review.corral', text: toFile(coder) });
      const { pane, nodes } = setup(undefined, files);
      fireEvent.doubleClick(pane, { clientX: 200, clientY: 100 });

      fireEvent.click(button('Open…'));
      const ask = screen.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
      fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
      expect(files.open).not.toHaveBeenCalled();
      expect(nodes().map((n) => n.textContent)).toEqual(['Agent 1']);

      fireEvent.click(button('Open…'));
      fireEvent.click(button('Discard'));
      await waitFor(() => {
        expect(nodes().map((n) => n.textContent)).toEqual(['Coder']);
      });
      expect(document.title).toBe('review.corral — corrallm');

      // Nothing to lose: New asks nothing.
      fireEvent.click(button('New'));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(nodes()).toEqual([]);
      expect(files.forget).toHaveBeenCalled();
      expect(document.title).toBe('Untitled — corrallm');
    });

    it('opens an example as a new canvas, from an empty canvas or the file bar', () => {
      const files = fakeFiles();
      const { nodes } = setup(undefined, files);
      fireEvent.click(button('Start from a template…'));
      const gallery = within(screen.getByRole('dialog', { name: 'Templates' }));
      fireEvent.click(gallery.getByRole('button', { name: /^Team lead/ }));
      fireEvent.click(gallery.getByRole('button', { name: 'Create canvas' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(nodes().map((n) => n.textContent)).toContain('Lead');
      expect(files.forget).toHaveBeenCalled();
      expect(document.title).toBe('Untitled — corrallm');
      // Not empty now: the file bar still has them.
      expect(screen.queryByRole('button', { name: 'Start from a template…' })).toBeNull();
      fireEvent.click(button('Templates…'));
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('shows the folder its agents work in, chooses another, and brings it back with the canvas', async () => {
      const files = {
        ...fakeFiles({
          name: 'shop.corral',
          text: toFile(coder),
          project: { name: 'shop', path: '/work/shop' },
        }),
        chooseProject: vi
          .fn<NonNullable<CanvasFiles['chooseProject']>>()
          .mockResolvedValueOnce({ name: 'app', path: '/work/app' })
          .mockResolvedValueOnce(null),
      };
      setup(undefined, files);
      fireEvent.click(button('Choose a project folder'));
      await waitFor(() => {
        expect(button('Project folder: app').title).toMatch(/^\/work\/app\n/);
      });
      // Cancelled: it keeps the folder it had.
      fireEvent.click(button('Project folder: app'));
      await waitFor(() => {
        expect(files.chooseProject).toHaveBeenCalledTimes(2);
      });
      expect(button('Project folder: app')).toBeTruthy();

      // A new canvas has none; an opened one has the folder main remembered with its file.
      fireEvent.click(button('New'));
      expect(button('Choose a project folder')).toBeTruthy();
      fireEvent.click(button('Open…'));
      await waitFor(() => {
        expect(button('Project folder: shop')).toBeTruthy();
      });
    });

    it("fills in a template's blanks before it opens", () => {
      const { nodes, node } = setup(undefined, fakeFiles());
      fireEvent.click(button('Start from a template…'));
      const gallery = within(screen.getByRole('dialog', { name: 'Templates' }));
      fireEvent.click(gallery.getByRole('button', { name: /^TDD relay/ }));
      // Each blank starts from the template's own example; Back returns to the templates.
      const framework = gallery.getByRole('textbox', { name: 'Which test framework?' });
      expect((framework as HTMLTextAreaElement).value).toBe('pytest');
      fireEvent.change(framework, { target: { value: 'Vitest' } });
      fireEvent.change(gallery.getByRole('textbox', { name: 'What should they build?' }), {
        target: { value: 'A slugify(text) helper in src/text.ts.' },
      });
      fireEvent.click(gallery.getByRole('button', { name: 'Create canvas' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(nodes().map((n) => n.textContent)).toEqual(['Tester', 'Implementer', 'Refactorer']);
      fireEvent.doubleClick(node('tester'));
      const message = within(screen.getByRole('dialog', { name: 'Tester' })).getAllByRole(
        'textbox',
        { name: 'Message to the agent' },
      )[0] as HTMLTextAreaElement;
      expect(message.value).toBe(
        "Write Vitest tests for this, and nothing else: don't implement it.\n\nA slugify(text) helper in src/text.ts.\n\nPut them where this project keeps its tests, named the way the others are.",
      );
    });

    it('inserts a template into the canvas as a group, each agent of the type chosen', () => {
      const { nodes, container } = setup(coder, fakeFiles());
      fireEvent.click(button('Templates…'));
      const gallery = within(screen.getByRole('dialog', { name: 'Templates' }));
      fireEvent.click(gallery.getByRole('button', { name: /^TDD relay/ }));
      // Each agent starts as the template names it; the Tester is left to the default agent.
      const tester = gallery.getByRole('combobox', { name: "Tester's agent" });
      expect((tester as HTMLSelectElement).value).toBe('Codex');
      fireEvent.change(tester, { target: { value: '' } });
      fireEvent.click(gallery.getByRole('button', { name: 'Insert into this canvas' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(nodes().map((n) => n.textContent)).toEqual([
        'Coder',
        'TDD relay',
        'Tester',
        'Implementer',
        'Refactorer',
      ]);
      const agentOf = (label: string) =>
        [...container.querySelectorAll('.react-flow__node')]
          .find((n) => n.textContent === label)
          ?.querySelector('[data-agent]')
          ?.getAttribute('data-agent');
      expect(['Tester', 'Implementer', 'Refactorer'].map(agentOf)).toEqual([
        'Claude',
        'Claude',
        'Codex',
      ]);
    });

    it('says why a file cannot be opened, and keeps the canvas', async () => {
      const files = fakeFiles({ name: 'notes.corral', text: 'Remember the milk' });
      const { nodes } = setup(coder, files);
      fireEvent.click(button('Open…'));
      expect((await screen.findByRole('alert')).textContent).toMatch(
        /^Could not open notes\.corral: This is not a corrallm canvas/,
      );
      expect(nodes().map((n) => n.textContent)).toEqual(['Coder']);
      // Main took the file as the canvas's; it must not be saved over.
      expect(files.forget).toHaveBeenCalled();
    });
  });
});
