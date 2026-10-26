import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { SortableList } from './SortableList';

it.each([[44], [128, 116, 104, 92, 80, 68, 56, 44]])(
  'moves the test task directly above its wait, with pointer positions %j',
  (...positions) => {
    const move = vi.fn();
    const { container } = render(
      <SortableList
        items={['message', 'wait', 'tune', 'tests', 'if'].map((id) => ({ id }))}
        className="test-list"
        onMove={move}
        renderItem={(item, handle) => <button {...handle}>{item.id}</button>}
      />,
    );
    const rows = () => [...container.querySelectorAll('li')];
    const order = () => rows().map((row) => row.dataset.item);
    const boxes = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const top = rows().indexOf(this as HTMLLIElement) * 40;
        return { top, bottom: top + 40, height: 40 } as DOMRect;
      });
    try {
      fireEvent.pointerDown(screen.getByRole('button', { name: 'tests' }), { button: 0 });
      for (const clientY of positions) fireEvent.pointerMove(window, { clientY });
      expect(order()).toEqual(['message', 'tests', 'wait', 'tune', 'if']);
      expect(move).not.toHaveBeenCalled();
      fireEvent.pointerUp(window);
      expect(move).toHaveBeenCalledExactlyOnceWith('tests', 'wait');
    } finally {
      boxes.mockRestore();
    }
  },
);

it.each(['drop', 'cancel'] as const)(
  'keeps a drag local until %s, sending at most one move',
  (end) => {
    const move = vi.fn();
    const { container } = render(
      <SortableList
        items={[{ id: 'a' }, { id: 'b' }, { id: 'c' }]}
        className="test-list"
        onMove={move}
        renderItem={(item, handle) => <button {...handle}>{item.id}</button>}
      />,
    );
    const order = () => [...container.querySelectorAll('li')].map((row) => row.dataset.item);
    // Boxes follow the local row order as the pointer moves down and back up.
    const boxes = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const rows = [...container.querySelectorAll('li')];
        const top = rows.findIndex((row) => row === this) * 40;
        return { top, bottom: top + 40, height: 40 } as DOMRect;
      });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'a' }), { button: 0 });
    fireEvent.pointerMove(window, { clientY: 115 });
    expect(move).not.toHaveBeenCalled();
    expect(order()).toEqual(['b', 'c', 'a']);
    fireEvent.pointerMove(window, { clientY: 45 });
    expect(order()).toEqual(['b', 'a', 'c']);
    expect(move).not.toHaveBeenCalled();
    fireEvent[end === 'drop' ? 'pointerUp' : 'pointerCancel'](window);
    if (end === 'drop') expect(move).toHaveBeenCalledExactlyOnceWith('a', 'c');
    else {
      expect(move).not.toHaveBeenCalled();
      expect(order()).toEqual(['a', 'b', 'c']);
    }
    boxes.mockRestore();
  },
);

it('refocuses the handle after the reordered render, where Chromium blurs a moved element', async () => {
  const done = Promise.withResolvers<undefined>();
  const move = vi.fn(() => done.promise);
  const list = (ids: string[]) => (
    <SortableList
      items={ids.map((id) => ({ id }))}
      className="test-list"
      onMove={move}
      renderItem={(item, handle) => <button {...handle}>{item.id}</button>}
    />
  );
  const view = render(list(['a', 'b', 'c']));
  const order = () => [...view.container.querySelectorAll('li')].map((row) => row.dataset.item);
  const handle = screen.getByRole('button', { name: 'a' });
  handle.focus();
  // Chromium blurs a focused element that React's keyed reconciliation moves; jsdom keeps it.
  const rows = view.container.querySelector('ol');
  if (!rows) throw new Error('No list');
  let blurred = false;
  const moved = vi.spyOn(rows, 'insertBefore').mockImplementation((node, child) => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && node.contains(focused)) {
      focused.blur();
      blurred = document.activeElement === document.body;
    }
    return Node.prototype.insertBefore.call(rows, node, child);
  });
  const focusedIn: (string | undefined)[][] = [];
  const focus = vi.spyOn(handle, 'focus').mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions,
  ) {
    focusedIn.push(order());
    HTMLElement.prototype.focus.call(this, options);
  });
  try {
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(move).toHaveBeenCalledExactlyOnceWith('a', 'c');
    // The mirror reaches the move's revision (re-rendering the rows) before the move resolves.
    view.rerender(list(['b', 'a', 'c']));
    await act(async () => {
      done.resolve(undefined);
      await done.promise;
    });
    expect(order()).toEqual(['b', 'a', 'c']);
    expect(blurred).toBe(true);
    expect(focusedIn.at(-1)).toEqual(['b', 'a', 'c']);
    expect(document.activeElement).toBe(handle);
  } finally {
    moved.mockRestore();
    focus.mockRestore();
  }
});
