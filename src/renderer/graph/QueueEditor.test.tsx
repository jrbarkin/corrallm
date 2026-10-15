import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { NEW_SESSION } from '../agent/session';
import type { SubmittedMessage } from '../agent/session';
import { QueuesView } from '../queues/QueuesView';
import { AGENT_ACTIONS } from './agents';
import { editsOf } from './edits';
import type { QueueEdits } from './edits';
import type { GraphNode } from './graph';
import type { QueueItem, QueueMessage } from './queue';
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

describe('submitted messages in the shared queue row', () => {
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
          actions={AGENT_ACTIONS.Claude}
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
        actions={AGENT_ACTIONS.Claude}
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
        actions={AGENT_ACTIONS.Claude}
        {...editsOf(edits(), 'a')}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add to queue' }));
    fireEvent.click(screen.getByRole('option', { name: /^Wait for…/ }));
    expect(screen.queryByRole('option', { name: /Check the failing test/ })).toBeNull();
    expect(screen.getByRole('option', { name: /b: Read/ })).toBeTruthy();
  });
});
