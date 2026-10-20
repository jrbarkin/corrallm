import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { AppApi } from '../../shared/ipc';
import { ExampleGallery } from './ExampleGallery';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('lists and fills the fields and open agents returned by templates.list', async () => {
  const item = {
    id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a11',
    name: 'A template from the core',
    description: 'The core’s description.',
    fields: [
      {
        key: 'question',
        label: 'What should it investigate?',
        example: 'A core-supplied example.',
      },
    ],
    agents: [{ id: 'researcher', name: 'Researcher', jobs: ['web-search'] }],
  };
  const templatesList = vi.fn().mockResolvedValue({ ok: true, value: { items: [item] } });
  vi.stubGlobal('api', { templatesList } satisfies Partial<AppApi>);
  const onPick = vi.fn();
  render(<ExampleGallery canInsert={false} onPick={onPick} onClose={() => undefined} />);
  const shown = await screen.findByRole('button', { name: /A template from the core/ });
  expect(templatesList).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: /^TDD relay/ })).toBeNull();
  fireEvent.click(shown);
  expect(
    screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'What should it investigate?' }).value,
  ).toBe('A core-supplied example.');
  expect(screen.getByRole('combobox', { name: "Researcher's agent" })).toBeTruthy();
  const role = screen.getByRole('combobox', { name: "Researcher's agent" }).closest('label');
  expect(role?.querySelector('img')?.getAttribute('alt')).toBe('Claude Code');
  fireEvent.change(screen.getByRole('combobox', { name: "Researcher's agent" }), {
    target: { value: 'codex' },
  });
  expect(role && within(role).getByRole('img', { name: 'Codex' }).tagName).toBe('IMG');
  fireEvent.click(screen.getByRole('button', { name: 'Create canvas' }));
  await waitFor(() => {
    expect(onPick).toHaveBeenCalledOnce();
  });
  expect(onPick.mock.calls[0]?.[0]).toEqual(item);
});

it('distinguishes an open role from a role pinned to an adapter in the gallery', async () => {
  vi.stubGlobal('api', {
    templatesList: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        items: [
          {
            id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a11',
            name: 'Open and pinned',
            description: 'Roles',
            fields: [],
            agents: [
              { id: 'open', name: 'Open' },
              { id: 'pinned', name: 'Pinned', adapter: 'codex' },
            ],
          },
        ],
      },
    }),
  } satisfies Partial<AppApi>);
  render(<ExampleGallery canInsert={false} onPick={() => undefined} onClose={() => undefined} />);
  const card = await screen.findByRole('button', { name: /Open and pinned/ });
  const open = within(card).getByTitle('Any agent');
  expect(open.querySelector('img')).toBeNull();
  const pinned = within(card).getByTitle('Codex');
  expect(pinned.querySelector('img')?.getAttribute('alt')).toBe('Codex');
});
