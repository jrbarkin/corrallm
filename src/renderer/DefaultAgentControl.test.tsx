import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { TWO_MADE_UP } from '../shared/test-made-up';
import { DefaultAgentControl } from './DefaultAgentControl';
import { useCatalog } from './test-catalog';
import { expectOneOp, fakeCore } from './test-api';
import { events, renderReady } from './test-render';

afterEach(cleanup);

it('chooses a default with one settings operation and shows its topic value in every control', async () => {
  await useCatalog(TWO_MADE_UP);
  const core = fakeCore();
  try {
    await renderReady(
      <>
        <div data-testid="first">
          <DefaultAgentControl client={core.api} mirror={core.topics} />
        </div>
        <div data-testid="second">
          <DefaultAgentControl client={core.api} mirror={core.topics} />
        </div>
      </>,
    );
    const first = within(screen.getByTestId('first'));
    const second = within(screen.getByTestId('second'));
    expect(first.getByText('No default agent: corrallm asks each time')).toBeTruthy();
    await events.click(first.getByRole('button', { name: 'Choose…' }));
    expect(first.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Zed Agent',
      'Yak Agent',
    ]);
    await events.click(first.getByRole('option', { name: 'Yak Agent' }));
    await waitFor(() => {
      expectOneOp(core, 'settings.set', { defaultAdapter: 'yak' });
    });
    expect(first.getByText('Default agent: Yak Agent')).toBeTruthy();
    expect(second.getByText('Default agent: Yak Agent')).toBeTruthy();
  } finally {
    core.dispose();
  }
});

it.each(['change', 'clear'] as const)('makes %s its own settings operation', async (gesture) => {
  await useCatalog(TWO_MADE_UP);
  const core = fakeCore();
  core.snapshot('settings', {
    defaultAdapter: 'yak',
    consents: {},
    api: { state: 'stopped', port: null },
  });
  try {
    await renderReady(<DefaultAgentControl client={core.api} mirror={core.topics} />);
    if (gesture === 'change') {
      await events.click(screen.getByRole('button', { name: 'Change' }));
      await events.click(screen.getByRole('option', { name: 'Zed Agent' }));
    } else await events.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => {
      expectOneOp(core, 'settings.set', { defaultAdapter: gesture === 'change' ? 'zed' : null });
    });
    expect(
      screen.getByText(
        gesture === 'change'
          ? 'Default agent: Zed Agent'
          : 'No default agent: corrallm asks each time',
      ),
    ).toBeTruthy();
  } finally {
    core.dispose();
  }
});

it('keeps the previous preference and shows a refused write sentence', async () => {
  await useCatalog(TWO_MADE_UP);
  const core = fakeCore();
  const sentence = 'corrallm couldn’t save your default agent; it is unchanged.';
  core.reply('settings.set', { ok: false, error: { code: 'unavailable', sentence } });
  try {
    await renderReady(<DefaultAgentControl client={core.api} mirror={core.topics} />);
    await events.click(screen.getByRole('button', { name: 'Choose…' }));
    await events.click(screen.getByRole('option', { name: 'Yak Agent' }));
    expectOneOp(core, 'settings.set', { defaultAdapter: 'yak' });
    expect(screen.getByRole('alert').textContent).toBe(sentence);
    expect(screen.getByText('No default agent: corrallm asks each time')).toBeTruthy();
  } finally {
    core.dispose();
  }
});

it('treats an unknown saved preference as none and cancels a choice without writing', async () => {
  await useCatalog(TWO_MADE_UP);
  const core = fakeCore();
  core.snapshot('settings', {
    defaultAdapter: 'missing',
    consents: {},
    api: { state: 'stopped', port: null },
  });
  try {
    await renderReady(<DefaultAgentControl client={core.api} mirror={core.topics} />);
    expect(screen.getByText('No default agent: corrallm asks each time')).toBeTruthy();
    await events.click(screen.getByRole('button', { name: 'Choose…' }));
    await events.keyDown(screen.getByRole('combobox', { name: 'Choose a default agent' }), {
      key: 'Escape',
    });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(core.operations).toEqual([]);
  } finally {
    core.dispose();
  }
});

it('waits for the published value instead of displaying an unacknowledged choice', async () => {
  await useCatalog(TWO_MADE_UP);
  const core = fakeCore();
  const write = Promise.withResolvers<undefined>();
  core.reply('settings.set', async () => {
    await write.promise;
    core.change({
      topic: 'settings',
      rev: 1,
      replace: { defaultAdapter: 'yak', consents: {}, api: { state: 'stopped', port: null } },
    });
    return { ok: true, value: { defaultAdapter: 'yak', revs: { settings: 1 } } };
  });
  try {
    await renderReady(<DefaultAgentControl client={core.api} mirror={core.topics} />);
    await events.click(screen.getByRole('button', { name: 'Choose…' }));
    await events.click(screen.getByRole('option', { name: 'Yak Agent' }));
    expect(screen.getByText('No default agent: corrallm asks each time')).toBeTruthy();
    expect(screen.queryByText('Default agent: Yak Agent')).toBeNull();
    expect(screen.getByRole('button', { name: 'Choose…' })).toHaveProperty('disabled', true);
    write.resolve(undefined);
    await screen.findByText('Default agent: Yak Agent');
    expectOneOp(core, 'settings.set', { defaultAdapter: 'yak' });
  } finally {
    write.resolve(undefined);
    core.dispose();
  }
});
