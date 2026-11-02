import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { MADE_UP } from '../../shared/test-made-up';
import { NEW_SESSION } from '../../shared/model/session';
import { useCatalog } from '../test-catalog';
import { Composer } from './Composer';

it('cycles only asking modes declared by an unfamiliar adapter and confirms its unasking mode', async () => {
  await useCatalog(MADE_UP);
  const setMode = vi.fn();
  render(
    <Composer
      agentName="Worker"
      agent="zed"
      session={NEW_SESSION}
      field={createRef<HTMLTextAreaElement>()}
      controls={{ setMode, send: vi.fn(), stop: vi.fn(), unqueue: vi.fn(), setModel: vi.fn() }}
    />,
  );
  const field = screen.getByRole('textbox');
  fireEvent.keyDown(field, { key: 'Tab', shiftKey: true });
  fireEvent.keyDown(field, { key: 'Tab', shiftKey: true });
  expect(setMode.mock.calls).toEqual([['plan'], ['plan']]);
  setMode.mockClear();
  fireEvent.click(screen.getByRole('button', { name: /^Mode:/ }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Auto' }));
  expect(setMode).not.toHaveBeenCalled();
});
