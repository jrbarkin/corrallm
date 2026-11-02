import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { AppApi } from '../../shared/gui-link';
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
  expect(role && within(role).getByRole('img', { name: 'Choose an agent' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Create canvas' })).toHaveProperty('disabled', true);
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

it('shows every unresolved gallery role with a hollow mark', async () => {
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
              { id: 'open', name: 'Open', jobs: [] },
              { id: 'other', name: 'Other', jobs: [] },
            ],
          },
        ],
      },
    }),
  } satisfies Partial<AppApi>);
  render(<ExampleGallery canInsert={false} onPick={() => undefined} onClose={() => undefined} />);
  const card = await screen.findByRole('button', { name: /Open and pinned/ });
  expect(within(card).getAllByTitle('Any agent')).toHaveLength(2);
  expect(card.querySelector('img')).toBeNull();
});

it.each(['zed', 'missing', undefined])(
  'prefills every required role only from the known preference %s',
  async (adapter) => {
    const { TWO_MADE_UP } = await import('../../shared/test-made-up');
    const { useCatalog } = await import('../test-catalog');
    await useCatalog(TWO_MADE_UP);
    const template = {
      id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a11',
      name: 'Roles',
      description: 'Both required',
      fields: [],
      agents: [
        { id: 'a', name: 'First', jobs: [] },
        { id: 'b', name: 'Second', jobs: [] },
      ],
    };
    vi.stubGlobal('api', {
      templatesList: vi.fn().mockResolvedValue({ ok: true, value: { items: [template] } }),
    } satisfies Partial<AppApi>);
    const onPick = vi.fn();
    render(
      <ExampleGallery
        canInsert
        initialTemplate={template}
        preferredEndpoint={
          adapter === undefined
            ? undefined
            : { adapter, connection: adapter === 'zed' ? 'zed.acp' : 'missing' }
        }
        onPick={onPick}
        onClose={() => undefined}
      />,
    );
    for (const role of ['First', 'Second'])
      expect(
        screen.getByRole<HTMLSelectElement>('combobox', { name: `${role}'s agent` }).value,
      ).toBe(adapter === 'zed' ? 'zed' : '');
    expect(screen.getByRole('button', { name: 'Create canvas' })).toHaveProperty(
      'disabled',
      adapter !== 'zed',
    );
    expect(screen.getByRole('button', { name: 'Insert into this canvas' })).toHaveProperty(
      'disabled',
      adapter !== 'zed',
    );
    if (adapter === 'zed') {
      fireEvent.click(screen.getByRole('button', { name: 'Insert into this canvas' }));
      expect(onPick).toHaveBeenCalledWith(
        template,
        { values: {}, agents: { a: 'zed', b: 'zed' }, connections: { a: 'zed.acp', b: 'zed.acp' } },
        'insert',
      );
    }
  },
);

it('fills untouched roles when the initial preference arrives, preserving local role and text choices', async () => {
  const { TWO_MADE_UP } = await import('../../shared/test-made-up');
  const { useCatalog } = await import('../test-catalog');
  await useCatalog(TWO_MADE_UP);
  const template = {
    id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a11',
    name: 'Roles',
    description: 'Both required',
    fields: [{ key: 'work', label: 'Work', example: 'Original' }],
    agents: [
      { id: 'a', name: 'First', jobs: [] },
      { id: 'b', name: 'Second', jobs: [] },
    ],
  };
  vi.stubGlobal('api', {
    templatesList: vi.fn().mockResolvedValue({ ok: true, value: { items: [template] } }),
  } satisfies Partial<AppApi>);
  const props = {
    canInsert: true,
    initialTemplate: template,
    onPick: vi.fn(),
    onClose: () => undefined,
  };
  const view = render(<ExampleGallery {...props} preferenceReady={false} />);
  fireEvent.change(screen.getByRole('combobox', { name: "First's agent" }), {
    target: { value: 'yak' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Work' }), {
    target: { value: 'Authored' },
  });
  expect(screen.getByRole('button', { name: 'Create canvas' })).toHaveProperty('disabled', true);
  view.rerender(
    <ExampleGallery
      {...props}
      preferredEndpoint={{ adapter: 'zed', connection: 'zed.acp' }}
      preferenceReady
    />,
  );
  await waitFor(() => {
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: "Second's agent" }).value).toBe(
      'zed',
    );
  });
  expect(screen.getByRole<HTMLSelectElement>('combobox', { name: "First's agent" }).value).toBe(
    'yak',
  );
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Work' }).value).toBe('Authored');
  fireEvent.change(screen.getByRole('combobox', { name: "Second's agent" }), {
    target: { value: '' },
  });
  view.rerender(
    <ExampleGallery
      {...props}
      preferredEndpoint={{ adapter: 'yak', connection: 'yak.free' }}
      preferenceReady
    />,
  );
  expect(screen.getByRole<HTMLSelectElement>('combobox', { name: "Second's agent" }).value).toBe(
    '',
  );
  expect(screen.getByRole('button', { name: 'Create canvas' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Insert into this canvas' })).toHaveProperty(
    'disabled',
    true,
  );
});

it('marks adapters missing a role’s received jobs while keeping every catalog choice', async () => {
  const { TWO_MADE_UP } = await import('../../shared/test-made-up');
  const { useCatalog } = await import('../test-catalog');
  await useCatalog(TWO_MADE_UP);
  const template = {
    id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a11',
    name: 'Jobs',
    description: '',
    fields: [],
    agents: [{ id: 'a', name: 'Reviewer', jobs: ['shell', 'edit'] as const }],
  };
  vi.stubGlobal('api', {
    templatesList: vi.fn().mockResolvedValue({ ok: true, value: { items: [template] } }),
  } satisfies Partial<AppApi>);
  const onPick = vi.fn();
  render(
    <ExampleGallery
      canInsert={true}
      initialTemplate={{
        ...template,
        agents: template.agents.map((a) => ({ ...a, jobs: [...a.jobs] })),
      }}
      onPick={onPick}
      onClose={() => undefined}
    />,
  );
  const select = screen.getByRole('combobox', { name: "Reviewer's agent" });
  expect(
    within(select).getByRole('option', { name: 'Zed Agent (missing jobs: edit)' }),
  ).toBeTruthy();
  expect(
    within(select).getByRole('option', { name: 'Yak Agent (missing jobs: edit)' }),
  ).toBeTruthy();
  fireEvent.change(select, { target: { value: 'zed' } });
  expect(await screen.findByText('Zed Agent lacks jobs for Reviewer: edit')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Create canvas' })).toHaveProperty('disabled', false);
  fireEvent.click(screen.getByRole('button', { name: 'Insert into this canvas' }));
  expect(onPick).toHaveBeenCalledWith(
    expect.anything(),
    { values: {}, agents: { a: 'zed' }, connections: { a: 'zed.acp' } },
    'insert',
  );
});
