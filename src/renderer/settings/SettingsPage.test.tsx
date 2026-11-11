import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TopicStates } from '../../shared/api/topics';
import { MADE_UP, TWO_MADE_UP } from '../../shared/test-made-up';
import { expectOneOp, fakeCore } from '../test-api';
import { useCatalog } from '../test-catalog';
import { events, renderReady } from '../test-render';
import { ApiError } from '../api/bridge';
import { TopicMirror } from '../api/topics';
import { SettingsPage } from './SettingsPage';

afterEach(cleanup);

type Core = ReturnType<typeof fakeCore>;
type Settings = TopicStates['settings'];

function setup(change?: (state: Settings) => Settings) {
  const core = fakeCore();
  const previous = core.state('settings');
  if (!previous) throw new Error('No settings fixture');
  if (change) core.snapshot('settings', change(previous.state));
  const onClose = vi.fn();
  const render = () =>
    renderReady(<SettingsPage client={core.api} mirror={core.topics} onClose={onClose} />);
  return { core, onClose, render };
}
/** Whether a control refuses a gesture: really disabled, or aria-disabled (which keeps focus). */
const off = (element: HTMLElement) =>
  (element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true';
const feed = (core: Core, state: Settings) => {
  const rev = (core.state('settings')?.rev ?? 0) + 1;
  core.change({ topic: 'settings', rev, replace: state });
};
const current = (core: Core): Settings => {
  const state = core.state('settings')?.state;
  if (!state) throw new Error('No settings');
  return state;
};

it('shows the page with its sections in order and sends nothing for opening, reading or closing', async () => {
  const { core, onClose, render } = setup();
  try {
    await render();
    const page = screen.getByRole('dialog', { name: 'Settings' });
    expect(page.getAttribute('aria-modal')).toBe('false');
    expect(within(page).getByText('For corrallm on this machine.')).toBeTruthy();
    expect(
      within(page)
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual([
      'Default agent',
      'Notifications',
      'Consents',
      'Links that open without asking',
      'The corrallm command',
    ]);
    expect(
      within(page).getByText('For new agents; existing agents keep their choices.'),
    ).toBeTruthy();
    expect(
      within(page).getByText(
        'When corrallm is in the background, for work that needs you and runs that end.',
      ),
    ).toBeTruthy();
    await events.keyDown(page, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    await events.click(screen.getByRole('button', { name: 'Back' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(core.operations).toEqual([]);
  } finally {
    core.dispose();
  }
});

it('lets an open chooser take Escape without closing the page', async () => {
  const { core, onClose, render } = setup();
  try {
    await useCatalog(TWO_MADE_UP);
    await render();
    await events.click(screen.getByRole('button', { name: 'Choose…' }));
    await events.keyDown(screen.getByRole('combobox', { name: 'Choose a default agent' }), {
      key: 'Escape',
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(core.operations).toEqual([]);
  } finally {
    core.dispose();
  }
});

it('sets the default through the shared control with one operation', async () => {
  await useCatalog(TWO_MADE_UP);
  const { core, render } = setup();
  try {
    await render();
    await events.click(screen.getByRole('button', { name: 'Choose…' }));
    await events.click(screen.getByRole('option', { name: 'Yak Agent' }));
    await waitFor(() => {
      expectOneOp(core, 'settings.set', { defaultAdapter: 'yak' });
    });
    expect(await screen.findByText('Default agent: Yak Agent')).toBeTruthy();
  } finally {
    core.dispose();
  }
});

it.each([
  [null, 'No notification attempted since corrallm started'],
  ['shown', 'Last notification shown'],
  ['suppressed', 'Last notification was suppressed'],
  ['unsupported', "OS notifications aren't supported here"],
  ['failed', "The last notification couldn't be shown"],
] as const)('words a last delivery of %s', async (lastDelivery, sentence) => {
  const { core, render } = setup((state) => ({
    ...state,
    notifications: { enabled: true, lastDelivery },
  }));
  try {
    await render();
    expect(screen.getByText(sentence)).toBeTruthy();
  } finally {
    core.dispose();
  }
});

it('toggles notifications with one operation, showing the topic value only once it arrives', async () => {
  const { core, render } = setup();
  const write = Promise.withResolvers<undefined>();
  core.reply('settings.set', async () => {
    await write.promise;
    feed(core, { ...current(core), notifications: { enabled: false, lastDelivery: null } });
    return { ok: true, value: { notifications: { enabled: false }, revs: { settings: 1 } } };
  });
  try {
    await render();
    const toggle = screen.getByRole<HTMLInputElement>('switch', { name: 'OS notifications' });
    expect(toggle.checked).toBe(true);
    await events.click(toggle);
    await waitFor(() => {
      expectOneOp(core, 'settings.set', { notifications: { enabled: false } });
    });
    expect(toggle.checked).toBe(true);
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    // Only the pending row is disabled.
    expect(off(screen.getByRole('button', { name: 'Choose…' }))).toBe(false);
    write.resolve(undefined);
    await waitFor(() => {
      expect(toggle.checked).toBe(false);
    });
    expect(toggle.getAttribute('aria-disabled')).toBeNull();
    expect(core.operations).toHaveLength(1);
  } finally {
    write.resolve(undefined);
    core.dispose();
  }
});

it('keeps the notification value and the core sentence at its row after a refusal, and retries', async () => {
  const { core, render } = setup();
  const sentence = 'corrallm couldn’t save your notification setting; it is unchanged.';
  core.reply('settings.set', { ok: false, error: { code: 'unavailable', sentence } });
  try {
    await render();
    const toggle = screen.getByRole<HTMLInputElement>('switch', { name: 'OS notifications' });
    await events.click(toggle);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(sentence);
    expect(toggle.checked).toBe(true);
    expect(toggle.getAttribute('aria-disabled')).toBeNull();
    expect(alert.closest('section')?.querySelector('h3')?.textContent).toBe('Notifications');
    core.operations.length = 0;
    core.reply('settings.set', () => {
      feed(core, { ...current(core), notifications: { enabled: false, lastDelivery: null } });
      return Promise.resolve({
        ok: true,
        value: { notifications: { enabled: false }, revs: { settings: 1 } },
      });
    });
    await events.click(toggle);
    expectOneOp(core, 'settings.set', { notifications: { enabled: false } });
    await waitFor(() => {
      expect(toggle.checked).toBe(false);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  } finally {
    core.dispose();
  }
});

it('leaves the switch operable when notifications are unsupported', async () => {
  const { core, render } = setup((state) => ({
    ...state,
    notifications: { enabled: true, lastDelivery: 'unsupported' },
  }));
  try {
    await render();
    const toggle = screen.getByRole<HTMLInputElement>('switch', { name: 'OS notifications' });
    expect(toggle.getAttribute('aria-disabled')).toBeNull();
    await events.click(toggle);
    expectOneOp(core, 'settings.set', { notifications: { enabled: false } });
  } finally {
    core.dispose();
  }
});

it("shows another window's change from the topic, with no stale local copy", async () => {
  await useCatalog(TWO_MADE_UP);
  const { core, render } = setup();
  try {
    await render();
    const toggle = screen.getByRole<HTMLInputElement>('switch', { name: 'OS notifications' });
    expect(toggle.checked).toBe(true);
    feed(core, {
      ...current(core),
      defaultAdapter: 'zed',
      notifications: { enabled: false, lastDelivery: 'shown' },
      links: { state: 'ready', sites: ['https://example.org'], builtIn: [] },
    });
    await waitFor(() => {
      expect(toggle.checked).toBe(false);
    });
    expect(screen.getByText('Last notification shown')).toBeTruthy();
    expect(screen.getByText('https://example.org')).toBeTruthy();
    expect(screen.getByText('Default agent: Zed Agent')).toBeTruthy();
    expect(core.operations).toEqual([]);
  } finally {
    core.dispose();
  }
});

it('keeps the last complete page, inert, until the new epoch delivers its snapshot', async () => {
  const { core, render } = setup((state) => ({
    ...state,
    consents: { zed: { plan: true } },
    links: { state: 'ready', sites: ['https://example.org'], builtIn: [] },
  }));
  await useCatalog(TWO_MADE_UP);
  try {
    await render();
    act(() => {
      core.epoch('next-core');
    });
    // The new epoch's snapshot has not arrived yet: the last complete page stays, inert.
    expect(off(screen.getByRole('switch', { name: 'OS notifications' }))).toBe(true);
    expect(screen.getByText('https://example.org')).toBeTruthy();
    for (const button of screen.getAllByRole('button')) {
      if (button.textContent === 'Back') continue;
      expect(off(button)).toBe(true);
    }
    await act(() => Promise.resolve());
    expect(off(screen.getByRole('switch', { name: 'OS notifications' }))).toBe(false);
    expect(core.operations).toEqual([]);
  } finally {
    core.dispose();
  }
});

it('leaves the default and notifications usable when the site list cannot be read', async () => {
  const sentence = 'corrallm couldn’t read the sites you said to open without asking.';
  const { core, render } = setup((state) => ({
    ...state,
    links: { state: 'unavailable', sentence },
  }));
  try {
    await render();
    expect(screen.getByText(sentence)).toBeTruthy();
    expect(screen.queryByText('No sites remembered.')).toBeNull();
    expect(screen.queryByRole('button', { name: /Ask next time/ })).toBeNull();
    expect(off(screen.getByRole('button', { name: 'Choose…' }))).toBe(false);
    await events.click(screen.getByRole('switch', { name: 'OS notifications' }));
    expectOneOp(core, 'settings.set', { notifications: { enabled: false } });
  } finally {
    core.dispose();
  }
});

it('lists the sites as escaped text, takes one back with one operation and shows the fixed ones apart', async () => {
  const hostile = 'https://<b>x</b>.example:8443';
  const { core, render } = setup((state) => ({
    ...state,
    links: {
      state: 'ready',
      sites: ['https://example.org', hostile],
      builtIn: ['https://github.com'],
    },
  }));
  try {
    await render();
    const sites = screen.getByRole('list', { name: 'Remembered sites' });
    expect(within(sites).getAllByRole('listitem')).toHaveLength(2);
    expect(within(sites).getByText(hostile)).toBeTruthy();
    expect(sites.querySelector('b, a')).toBeNull();
    const fixed = screen.getByRole('list', { name: 'Always open without asking' });
    expect(within(fixed).getByText('https://github.com')).toBeTruthy();
    expect(within(fixed).queryByRole('button')).toBeNull();
    await events.click(within(sites).getByRole('button', { name: `Ask next time: ${hostile}` }));
    expectOneOp(core, 'settings.set', { consent: { kind: 'site', origin: hostile } });
    await waitFor(() => {
      expect(screen.queryByText(hostile)).toBeNull();
    });
    expect(screen.getByText('https://example.org')).toBeTruthy();
  } finally {
    core.dispose();
  }
});

it('says no sites are remembered and disables only the pending site row', async () => {
  const { core, render } = setup();
  try {
    await render();
    expect(screen.getByText('No sites remembered.')).toBeTruthy();
  } finally {
    core.dispose();
    cleanup();
  }
  const two = setup((state) => ({
    ...state,
    links: { state: 'ready', sites: ['https://a.example', 'https://b.example'], builtIn: [] },
  }));
  const write = Promise.withResolvers<undefined>();
  two.core.reply('settings.set', async () => {
    await write.promise;
    return { ok: true, value: { consent: { target: {}, changed: false } } };
  });
  try {
    await two.render();
    await events.click(screen.getByRole('button', { name: 'Ask next time: https://a.example' }));
    expect(off(screen.getByRole('button', { name: 'Ask next time: https://a.example' }))).toBe(
      true,
    );
    expect(off(screen.getByRole('button', { name: 'Ask next time: https://b.example' }))).toBe(
      false,
    );
    expect(off(screen.getByRole('switch', { name: 'OS notifications' }))).toBe(false);
    write.resolve(undefined);
    // A call that changed nothing is fine: the row simply stays, enabled again.
    await waitFor(() => {
      expect(off(screen.getByRole('button', { name: 'Ask next time: https://a.example' }))).toBe(
        false,
      );
    });
    expect(screen.queryByRole('alert')).toBeNull();
  } finally {
    write.resolve(undefined);
    two.core.dispose();
  }
});

it('keeps a site and shows the core sentence at its row after a refusal', async () => {
  const sentence = 'corrallm couldn’t save taking back this site; it is unchanged.';
  const { core, render } = setup((state) => ({
    ...state,
    links: { state: 'ready', sites: ['https://a.example', 'https://b.example'], builtIn: [] },
  }));
  core.reply('settings.set', { ok: false, error: { code: 'unavailable', sentence } });
  try {
    await render();
    await events.click(screen.getByRole('button', { name: 'Ask next time: https://a.example' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(sentence);
    expect(alert.closest('li')?.textContent).toContain('https://a.example');
    expect(screen.getByText('https://b.example')).toBeTruthy();
    expect(off(screen.getByRole('button', { name: 'Ask next time: https://a.example' }))).toBe(
      false,
    );
  } finally {
    core.dispose();
  }
});

it('shows each declared consent of a made-up catalog and takes each back with one operation', async () => {
  await useCatalog(TWO_MADE_UP);
  const { core, render } = setup((state) => ({ ...state, consents: { yak: { credits: true } } }));
  try {
    await render();
    const consents = screen.getByRole('list', { name: 'Consents' });
    const items = within(consents).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    const [credits, share, yak] = items.map((item) => within(item));
    expect(credits?.getByText('Zed Agent')).toBeTruthy();
    expect(credits?.getByText('Spend your Zed credits')).toBeTruthy();
    expect(credits?.getByText('ACP')).toBeTruthy();
    expect(credits?.getByText('Not kept for good')).toBeTruthy();
    expect(share?.getByText('ACP, Free')).toBeTruthy();
    expect(yak?.getByText('Yak Agent')).toBeTruthy();
    expect(yak?.getByText('Terminal')).toBeTruthy();
    expect(yak?.getByText('Yak Agent asks before its terminal spends credits.')).toBeTruthy();
    expect(yak?.getByText('Kept for good')).toBeTruthy();
    expect(
      screen.getByText(
        'A turn already running can finish; before the next turn uses it, corrallm asks again.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /grant|always|allow/i })).toBeNull();
    // Offered even when nothing is kept: a live session may hold a session-only grant.
    await events.click(
      screen.getByRole('button', { name: 'Ask again: Spend your Zed credits (Zed Agent)' }),
    );
    expectOneOp(core, 'settings.set', {
      consent: { kind: 'adapter', adapter: 'zed', key: 'credits' },
    });
    core.operations.length = 0;
    await events.click(
      screen.getByRole('button', { name: 'Ask again: Spend your Yak credits (Yak Agent)' }),
    );
    expectOneOp(core, 'settings.set', {
      consent: { kind: 'adapter', adapter: 'yak', key: 'credits' },
    });
    await waitFor(() => {
      const last = within(consents).getAllByRole('listitem')[2];
      if (!last) throw new Error('No third row');
      expect(within(last).getByText('Not kept for good')).toBeTruthy();
    });
  } finally {
    core.dispose();
  }
});

it('shows an undeclared stored key as escaped text with removal only', async () => {
  await useCatalog(MADE_UP);
  const { core, render } = setup((state) => ({
    ...state,
    consents: { 'old-cli': { '<i>odd</i>': true } },
  }));
  try {
    await render();
    const consents = screen.getByRole('list', { name: 'Consents' });
    expect(within(consents).getByText('old-cli · <i>odd</i>')).toBeTruthy();
    expect(consents.querySelector('i')).toBeNull();
    const unknown = within(
      within(consents).getByText('old-cli · <i>odd</i>').closest('li') as HTMLElement,
    );
    expect(unknown.getAllByRole('button')).toHaveLength(1);
    await events.click(
      within(consents).getByRole('button', { name: 'Remove saved consent old-cli · <i>odd</i>' }),
    );
    expectOneOp(core, 'settings.set', {
      consent: { kind: 'adapter', adapter: 'old-cli', key: '<i>odd</i>' },
    });
  } finally {
    core.dispose();
  }
});

it('keeps a consent and shows the core sentence at its row after a refusal, then retries', async () => {
  await useCatalog(TWO_MADE_UP);
  const sentence = 'corrallm couldn’t save taking back this consent; it is unchanged.';
  const { core, render } = setup((state) => ({ ...state, consents: { yak: { credits: true } } }));
  core.reply('settings.set', { ok: false, error: { code: 'unavailable', sentence } });
  try {
    await render();
    const label = 'Ask again: Spend your Yak credits (Yak Agent)';
    await events.click(screen.getByRole('button', { name: label }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(sentence);
    expect(alert.closest('li')?.textContent).toContain('Kept for good');
    expect(off(screen.getByRole('button', { name: label }))).toBe(false);
    core.operations.length = 0;
    await events.click(screen.getByRole('button', { name: label }));
    expectOneOp(core, 'settings.set', {
      consent: { kind: 'adapter', adapter: 'yak', key: 'credits' },
    });
  } finally {
    core.dispose();
  }
});

it('tells when the catalog declares no consents', async () => {
  const [zed] = MADE_UP.adapters;
  if (!zed) throw new Error('No adapter');
  await useCatalog({ ...MADE_UP, adapters: [{ ...zed, consents: [] }] });
  const { core, render } = setup();
  try {
    await render();
    expect(screen.getByText('No consents to review.')).toBeTruthy();
  } finally {
    core.dispose();
  }
});

it('closes on Escape wherever focus is, since a row gesture can drop it to the body', async () => {
  const { core, onClose, render } = setup((state) => ({
    ...state,
    links: { state: 'ready', sites: ['https://a.example', 'https://b.example'], builtIn: [] },
  }));
  try {
    await render();
    const removal = screen.getByRole('button', { name: 'Ask next time: https://a.example' });
    removal.focus();
    await events.click(removal);
    await waitFor(() => {
      expect(screen.queryByText('https://a.example')).toBeNull();
    });
    // The removed row's button is gone, but focus stays inside the panel.
    expect(screen.getByRole('dialog', { name: 'Settings' }).contains(document.activeElement)).toBe(
      true,
    );
    await events.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    await events.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  } finally {
    core.dispose();
  }
});

it('keeps focus on a pending row (aria-disabled, not disabled) and ignores a second click', async () => {
  const { core, render } = setup();
  const write = Promise.withResolvers<undefined>();
  core.reply('settings.set', async () => {
    await write.promise;
    return { ok: true, value: { notifications: { enabled: true } } };
  });
  try {
    await render();
    const toggle = screen.getByRole<HTMLInputElement>('switch', { name: 'OS notifications' });
    toggle.focus();
    await events.click(toggle);
    expect(toggle.hasAttribute('disabled')).toBe(false);
    expect(document.activeElement).toBe(toggle);
    await events.click(toggle);
    expect(core.operations).toHaveLength(1);
    write.resolve(undefined);
  } finally {
    write.resolve(undefined);
    core.dispose();
  }
});

it('does not close when a click lands on the backdrop and keeps focus in the panel', async () => {
  const { core, onClose, render } = setup();
  try {
    await render();
    const panel = screen.getByRole('dialog', { name: 'Settings' });
    const backdrop = panel.parentElement;
    if (!backdrop) throw new Error('No backdrop');
    const toggle = screen.getByRole('switch', { name: 'OS notifications' });
    toggle.focus();
    // The default action of a mouse press on the backdrop (moving focus away) is prevented.
    const proceeded = fireEvent.mouseDown(backdrop);
    expect(proceeded).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  } finally {
    core.dispose();
  }
});

/** A mirror whose subscribe answers as the test says. */
function mirrorOf(subscribe: () => Promise<unknown>) {
  const stops = () => () => undefined;
  return new TopicMirror({
    topicsSubscribe: subscribe,
    topicsUnsubscribe: () => Promise.resolve({}),
    topicsOnChange: stops,
    topicsOnEpoch: (listener: (epoch: string) => void) => {
      listener('e');
      return () => undefined;
    },
  } as never);
}

it('shows neutral loading rows, never guessed values, until the first snapshot', async () => {
  const mirror = mirrorOf(() => new Promise(() => undefined));
  try {
    await renderReady(
      <SettingsPage
        client={{ settingsSet: vi.fn(), appCommand: vi.fn() }}
        mirror={mirror}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText('No notification attempted since corrallm started')).toBeNull();
    expect(screen.queryByText('Not kept for good')).toBeNull();
    expect(screen.getAllByText('Loading…').length).toBeGreaterThan(0);
    expect(screen.queryByRole('alert')).toBeNull();
  } finally {
    mirror.dispose();
  }
});

it('shows a retryable read error when the settings cannot be read, then the page once they can', async () => {
  const sentence = 'corrallm couldn’t read your settings.';
  const state = {
    defaultAdapter: null,
    consents: {},
    api: { state: 'stopped', port: null },
    notifications: { enabled: false, lastDelivery: null },
    links: { state: 'ready', sites: [], builtIn: [] },
  };
  const subscribe = vi
    .fn()
    .mockRejectedValueOnce(new ApiError({ code: 'unavailable', sentence }))
    .mockResolvedValue({ epoch: 'e', rev: 0, state });
  const mirror = mirrorOf(subscribe);
  try {
    await renderReady(
      <SettingsPage
        client={{ settingsSet: vi.fn(), appCommand: vi.fn() }}
        mirror={mirror}
        onClose={vi.fn()}
      />,
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(sentence);
    expect(screen.queryByRole('switch')).toBeNull();
    await events.click(screen.getByRole('button', { name: 'Retry' }));
    const toggle = await screen.findByRole<HTMLInputElement>('switch', {
      name: 'OS notifications',
    });
    expect(toggle.checked).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(subscribe).toHaveBeenCalledTimes(2);
  } finally {
    mirror.dispose();
  }
});

it('notes that a remembered site that is also built in still opens without asking', async () => {
  const { core, render } = setup((state) => ({
    ...state,
    links: { state: 'ready', sites: ['https://github.com'], builtIn: ['https://github.com'] },
  }));
  try {
    await render();
    const item = screen.getByRole('list', { name: 'Remembered sites' }).querySelector('li');
    expect(item?.textContent).toContain('still opens without asking');
  } finally {
    core.dispose();
  }
});
