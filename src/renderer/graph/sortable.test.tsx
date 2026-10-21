import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { SortableList } from './SortableList';

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

it('keeps keyboard focus on the handle after the asynchronous move reaches the mirror', async () => {
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
  const handle = screen.getByRole('button', { name: 'a' });
  handle.focus();
  fireEvent.keyDown(handle, { key: 'ArrowDown' });
  expect(move).toHaveBeenCalledExactlyOnceWith('a', 'c');
  view.rerender(list(['b', 'a', 'c']));
  await act(async () => {
    done.resolve(undefined);
    await done.promise;
  });
  expect(document.activeElement).toBe(handle);
});
