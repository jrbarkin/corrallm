import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { NEW_SESSION } from '../../shared/model/session';
import type { QueueItem, QueueMessage, SubmittedMessage } from '../../shared/model/queue';
import { QueuesView } from '../queues/QueuesView';
import { lanesOf } from '../queues/lanes';
import { queueMarks } from '../queues/marks';
import type { Run } from '../../shared/engine/run/runner';
import { heldAsks } from '../../shared/engine/run/asks';
import { QuestionsSidebar } from './Questions';
import { actionsOf, runCatalog } from './agents';
import { editsOf } from './edits';
import type { QueueEdits } from './edits';
import { canvasNodes } from './graph';
import type { GraphNode } from './graph';
import { QueueEditor } from './QueueEditor';

function edits(): QueueEdits {
  return {
    add: vi.fn(),
    remove: vi.fn(),
    move: vi.fn(),
    retarget: vi.fn(),
    editMessage: vi.fn(),
    setInstruction: vi.fn(),
    setExpect: vi.fn(),
    setCondition: vi.fn(),
    setWaitFor: vi.fn(),
    setTime: vi.fn(),
    setApproval: vi.fn(),
    setRepeat: vi.fn(),
    goOn: vi.fn(),
    decide: vi.fn(),
  };
}

const agent = (id: string, queue: QueueItem[]): GraphNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id, queue },
});
const submitted = (status: SubmittedMessage['status'] = 'running'): QueueMessage => ({
  id: 'live',
  message: 'Check the failing test',
  submission: {
    id: 'm1',
    text: 'Check the failing test',
    status,
    images: [{ mediaType: 'image/png', data: 'abc' }],
  },
});

describe('task recovery in the shared queue row', () => {
  const node = agent('a', [{ id: 'work', action: 'Bash', instruction: 'npm test' }]);
  const problem = {
    kind: 'uncertain' as const,
    reason: 'restart',
    text: 'The app closed before the result was recorded.',
    agent: 'a',
  };
  const attempts = [
    {
      id: 'first',
      startedAt: 1000,
      endedAt: 2000,
      status: 'failed' as const,
      reason: 'api_error',
      text: 'Server unavailable.',
    },
    {
      id: 'second',
      startedAt: 3000,
      endedAt: 4000,
      status: 'uncertain' as const,
      reason: 'restart',
      message: 'Try the smaller test suite.',
    },
  ];
  const run = (paused = false): Run => ({
    running: !paused,
    ...(paused ? { paused: true } : {}),
    agents: {
      a: { current: 'work', status: 'asking', outcomes: {}, problem, attempts: { work: attempts } },
    },
  });
  it('shows the reason, attempt history, and choices on the original step', () => {
    const edit = edits();
    const marks = queueMarks(lanesOf([node]), run(), new Set(), runCatalog());
    render(
      <QueueEditor
        node={node}
        nodes={[node]}
        agent="Claude"
        actions={actionsOf('claude-code')}
        {...editsOf(edit, 'a')}
        marks={(id) => marks('a', id)}
      />,
    );
    expect(screen.getByText(problem.text)).toBeTruthy();
    expect(screen.getByText('2 attempts')).toBeTruthy();
    expect(screen.getByText('Server unavailable.')).toBeTruthy();
    expect(screen.getByText('Try the smaller test suite.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(edit.decide).toHaveBeenLastCalledWith('a', 'work', { choice: 'retry' });
    fireEvent.click(screen.getByRole('button', { name: 'Mark resolved' }));
    expect(edit.decide).toHaveBeenLastCalledWith('a', 'work', { choice: 'resolve' });
    fireEvent.click(screen.getByRole('button', { name: 'Try this…' }));
    const text = screen.getByRole('textbox', { name: 'What should it try next?' });
    fireEvent.change(text, { target: { value: 'Use the cached dependencies' } });
    fireEvent.keyDown(text, { key: 'Enter' });
    expect(edit.decide).toHaveBeenLastCalledWith('a', 'work', {
      reply: 'Use the cached dependencies',
    });
  });
  it('shows the reason while paused, with Resume and Run again instead of recovery actions', () => {
    const resume = vi.fn();
    const again = vi.fn();
    const edit = edits();
    render(
      <QueuesView
        nodes={[node]}
        sessions={{ a: NEW_SESSION }}
        run={run(true)}
        edits={edit}
        backLabel="Canvas"
        onRun={again}
        onResume={resume}
        onStop={vi.fn()}
        onOpenAgent={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(problem.text)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(resume).toHaveBeenCalledOnce();
    expect(again).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }));
    expect(again).toHaveBeenCalledOnce();
  });
  it('uses the same recovery choices in the canvas Needs you sidebar', () => {
    const decide = vi.fn();
    render(
      <QuestionsSidebar
        asks={heldAsks(canvasNodes([node]), run(), runCatalog())}
        pending={[]}
        onDecide={decide}
        onAnswer={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    const needs = within(screen.getByRole('complementary', { name: 'Needs you' }));
    expect(needs.getByText(problem.text)).toBeTruthy();
    fireEvent.click(needs.getByRole('button', { name: /^Continue with failure/ }));
    expect(decide).toHaveBeenLastCalledWith('a', 'work', { choice: 'continue' });
  });
});

describe('condition query recovery in the shared queue row', () => {
  it.each(['if', 'repeat'] as const)(
    'asks whether the %s condition holds without offering a corrective message',
    (kind) => {
      const condition = { kind: 'freeText' as const, text: 'The review is complete' };
      const item: QueueItem =
        kind === 'if'
          ? { id: 'gate', if: condition, then: [] }
          : { id: 'gate', repeat: [], until: condition, rounds: 3, otherwise: 'ask' };
      const node = agent('a', [item]);
      const problem = {
        kind: 'uncertain' as const,
        reason: 'missing-verdict',
        text: 'The agent did not say whether the condition holds.',
        agent: 'a',
        conditionKey: 'condition-key',
      };
      const marks = queueMarks(
        lanesOf([node]),
        {
          running: true,
          agents: { a: { current: 'gate', status: 'asking', outcomes: {}, problem } },
        },
        new Set(),
        runCatalog(),
      );
      const edit = edits();
      render(
        <QueueEditor
          node={node}
          nodes={[node]}
          agent="Claude"
          actions={actionsOf('claude-code')}
          {...editsOf(edit, 'a')}
          marks={(id) => marks('a', id)}
        />,
      );
      expect(screen.getByText(problem.text)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Try this…' })).toBeNull();
      expect(screen.queryByRole('textbox', { name: 'What should it try next?' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Mark resolved' })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Continue/ })).toBeNull();
      for (const [name, choice] of [
        ['Retry', 'retry'],
        ['Condition holds', 'yes'],
        ['Condition does not hold', 'no'],
        ['Stop here', 'stop'],
      ] as const) {
        fireEvent.click(screen.getByRole('button', { name }));
        expect(edit.decide).toHaveBeenLastCalledWith('a', 'gate', { choice });
      }
    },
  );
});

describe('submitted messages in the shared queue row', () => {
  it('shows a restored in-flight submission as unresolved without claiming it was replayed', () => {
    const message = submitted('cancelled');
    if (!message.submission) throw new Error('No submitted message');
    message.submission = { ...message.submission, unresolved: true };
    const node = agent('a', [message]);
    const { container } = render(
      <QueueEditor
        node={node}
        nodes={[node]}
        agent="Claude"
        actions={actionsOf('claude-code')}
        {...editsOf(edits(), 'a')}
      />,
    );
    const row = container.querySelector('.graph-queue-submission');
    expect(row?.getAttribute('data-run')).toBe('cancelled');
    expect(row?.hasAttribute('data-unresolved')).toBe(true);
    expect(screen.getByText('Unresolved').title).toBe(
      'Inspect the native conversation; this submission was not replayed.',
    );
    expect(screen.queryByText('Cancelled')).toBeNull();
  });

  it.each(['queued', 'running', 'completed', 'failed', 'cancelled'] as const)(
    'shows a read-only %s message with its attachment count',
    (status) => {
      const node = agent('a', [submitted(status)]);
      const edit = edits();
      const { container } = render(
        <QueueEditor
          node={node}
          nodes={[node]}
          agent="Claude"
          actions={actionsOf('claude-code')}
          {...editsOf(edit, 'a')}
          marks={() => ({ 'data-decide': '', 'data-until': '10000' })}
        />,
      );
      const row = container.querySelector<HTMLElement>('.graph-queue-submission');
      expect(row).not.toBeNull();
      expect(row?.dataset.run).toBe(status);
      expect(row?.textContent).toContain('Check the failing test');
      expect(row?.textContent).toContain('1 image');
      expect(row?.textContent).toContain(status.charAt(0).toUpperCase() + status.slice(1));
      expect(row?.querySelector('button, textarea, input')).toBeNull();
    },
  );

  it('skips submitted messages when picking waits and reordering planned work', () => {
    const node = agent('a', [
      submitted(),
      { id: 'one', action: 'Read' },
      { id: 'two', action: 'Bash' },
    ]);
    const edit = edits();
    const pick = vi.fn();
    render(
      <QueueEditor
        node={node}
        nodes={[node]}
        agent="Claude"
        actions={actionsOf('claude-code')}
        {...editsOf(edit, 'a')}
        picking={{ name: 'a', current: undefined, onPick: pick }}
      />,
    );
    expect(
      screen.queryByRole('button', { name: /Wait for a:.*Check the failing test/ }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Wait for a: Read' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Move Read' }), { key: 'ArrowDown' });
    expect(edit.move).toHaveBeenCalledExactlyOnceWith('a', 'one', 1);
  });

  it('uses the same read-only rows and planned reorder positions in All queues', () => {
    const nodes = [
      agent('a', [
        submitted('completed'),
        { id: 'one', action: 'Read' },
        { id: 'two', action: 'Bash' },
      ]),
    ];
    const edit = edits();
    render(
      <QueuesView
        nodes={nodes}
        sessions={{ a: NEW_SESSION }}
        run={{ running: false, agents: {} }}
        edits={edit}
        backLabel="Canvas"
        onRun={vi.fn()}
        onStop={vi.fn()}
        onOpenAgent={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const row = within(screen.getByRole('dialog', { name: 'All queues' })).getByRole('group', {
      name: 'a: Message “Check the failing test”',
    });
    expect(row.querySelector('[data-run="completed"]')).not.toBeNull();
    expect(within(row).queryByRole('button')).toBeNull();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Move Read' }), { key: 'ArrowDown' });
    expect(edit.move).toHaveBeenCalledExactlyOnceWith('a', 'one', 1);
  });

  it('does not offer submitted messages as wait targets in the dropdown', () => {
    const nodes = [agent('a', []), agent('b', [submitted(), { id: 'planned', action: 'Read' }])];
    const node = nodes[0];
    if (!node) throw new Error('no agent');
    render(
      <QueueEditor
        node={node}
        nodes={nodes}
        agent="Claude"
        actions={actionsOf('claude-code')}
        {...editsOf(edits(), 'a')}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add to queue' }));
    fireEvent.click(screen.getByRole('option', { name: /^Wait for…/ }));
    expect(screen.queryByRole('option', { name: /Check the failing test/ })).toBeNull();
    expect(screen.getByRole('option', { name: /b: Read/ })).toBeTruthy();
  });
});
