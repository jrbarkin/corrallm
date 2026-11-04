import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { events } from '../test-render';
import { expectOneOp } from '../test-api';
import { made, open, settle, STARTED } from './test-agent-view';

// jsdom cannot draw xterm.js: a fake terminal stands in.
vi.mock('../terminal/screen', async () => {
  const { fakeScreens } = await import('../terminal/test-screen');
  return { createScreen: fakeScreens.create };
});

/** A request id the view minted. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

const OFFERED = [{ name: 'compact', description: 'Compact it', argumentHint: '' }];

describe('an unfamiliar adapter’s continuation', () => {
  it('completes only the commands its descriptor continues, naming the target', async () => {
    const { view, composer, emit } = await open('zed.acp', made());
    emit(STARTED, { type: 'commands', commands: OFFERED });
    await events.change(composer, { target: { value: '/', selectionStart: 1 } });
    const menu = within(view.getByRole('listbox', { name: 'Commands' }));
    expect(menu.getAllByRole('option').map((option) => option.textContent)).toEqual([
      '/compact' + 'Compact it',
      '/settings' + 'In Zed Shell · Open the settings screen',
      '/cfg' + 'In Zed Shell · Open configuration',
    ]);
  });

  it('sends a command no descriptor continues, as text: no table of another CLI’s hides', async () => {
    const { replies, send, view } = await open('zed.acp', made());
    await send('/permissions');
    expect(replies.send).toHaveBeenCalledExactlyOnceWith('a', {
      id: expect.any(String) as unknown,
      text: '/permissions',
    });
    expect(view.queryByRole('group', { name: /^Continue in/ })).toBeNull();
  });

  it('offers its descriptor’s command in its target by name, and continues once with the exact text', async () => {
    const { replies, send, view, since } = await open('zed.acp', made());
    const input = '  /settings theme\n  dark  ';
    await send(input);
    expect(replies.send).not.toHaveBeenCalled();
    const offer = within(view.getByRole('group', { name: 'Continue in Zed Shell?' }));
    expect(offer.getByText(/^\/settings theme\s+dark runs only in Zed Shell/)).toBeTruthy();
    const sent = since();
    await events.click(offer.getByRole('button', { name: 'Continue in Zed Shell' }));
    await settle();
    expectOneOp(sent, 'session.continueIn', {
      canvas: expect.any(String) as unknown,
      agent: 'a',
      connection: 'zed.terminal',
      request: expect.stringMatching(UUID) as unknown,
      then: { text: input },
    });
  });

  it('continues a shell command by the destination’s own prefix, never “!”', async () => {
    const { replies, send, view, since } = await open('zed.acp', made());
    await send('!ls');
    expect(replies.send).toHaveBeenCalledExactlyOnceWith('a', {
      id: expect.any(String) as unknown,
      text: '!ls',
    });
    replies.send.mockClear();
    const input = '  $ ls -la\n  ';
    await send(input);
    expect(replies.send).not.toHaveBeenCalled();
    const offer = within(view.getByRole('group', { name: 'Continue in Zed Shell?' }));
    expect(offer.getByText(/shell command/)).toBeTruthy();
    expect(offer.getByText(/"\$"/)).toBeTruthy();
    const sent = since();
    await events.click(offer.getByRole('button', { name: 'Continue in Zed Shell' }));
    await settle();
    expectOneOp(sent, 'session.continueIn', {
      canvas: expect.any(String) as unknown,
      agent: 'a',
      connection: 'zed.terminal',
      request: expect.stringMatching(UUID) as unknown,
      then: { text: input },
    });
  });

  it('sends a prefix alone as text, and a shell command nowhere a connection takes none', async () => {
    const alone = await open('zed.acp', made());
    await alone.send('$');
    expect(alone.replies.send).toHaveBeenCalledExactlyOnceWith('a', {
      id: expect.any(String) as unknown,
      text: '$',
    });
  });

  it('sends a shell command as text where the connection forwards none', async () => {
    const { replies, send } = await open('zed.free', made());
    await send('$ ls');
    expect(replies.send).toHaveBeenCalledExactlyOnceWith('a', {
      id: expect.any(String) as unknown,
      text: '$ ls',
    });
  });

  it('sends nothing on opening, Cancel or Esc of an offer', async () => {
    const { replies, send, view, since } = await open('zed.acp', made());
    const sent = since();
    await send('/settings');
    await events.click(view.getByRole('button', { name: 'Cancel' }));
    expect(view.queryByRole('group', { name: /^Continue in/ })).toBeNull();
    await send('/settings');
    await events.keyDown(view.getByRole('button', { name: 'Continue in Zed Shell' }), {
      key: 'Escape',
    });
    expect(view.queryByRole('group', { name: /^Continue in/ })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'a' })).toBeTruthy();
    expect(replies.send).not.toHaveBeenCalled();
    expect(sent.operations.filter(({ op }) => op === 'session.continueIn')).toEqual([]);
  });

  it('lets an offered native command win, except a bare-only one typed bare', async () => {
    const { send, view, emit, canvas } = await open('zed.acp', made());
    emit(STARTED, {
      type: 'commands',
      commands: [
        { name: 'settings', description: 'Its own', argumentHint: '' },
        { name: 'cfg', description: 'Its own', argumentHint: '' },
      ],
    });
    const messages = () => canvas.core.operations.filter(({ op }) => op === 'message').length;
    await send('/settings');
    expect(messages()).toBe(1);
    expect(view.queryByRole('group', { name: /^Continue in/ })).toBeNull();
    await send('/cfg key value');
    expect(messages()).toBe(2);
    expect(view.queryByRole('group', { name: /^Continue in/ })).toBeNull();
    await send('/cfg');
    expect(messages()).toBe(2);
    expect(view.getByRole('group', { name: 'Continue in Zed Shell?' })).toBeTruthy();
  });

  it('names a transcript target by its label, and continues there in the same operation', async () => {
    const { replies, view, send, since } = await open('zed.free', made());
    await events.click(view.getByRole('button', { name: /^Agent: / }));
    const first = view.getAllByRole('option')[0];
    expect(first?.textContent).toMatch(/^Continue in ACP/);
    expect(first?.textContent).not.toMatch(/Terminal/);
    const sent = since();
    if (!first) throw new Error('no options');
    await events.click(first);
    await settle();
    expectOneOp(sent, 'session.continueIn', {
      canvas: expect.any(String) as unknown,
      agent: 'a',
      connection: 'zed.acp',
      request: expect.stringMatching(UUID) as unknown,
    });
    expect(replies.send).not.toHaveBeenCalled();
    await send('hello');
  });

  it('offers a transcript target for its command, by its label', async () => {
    const { view, send, since, replies } = await open('zed.free', made());
    await send('/tune');
    expect(replies.send).not.toHaveBeenCalled();
    const offer = within(view.getByRole('group', { name: 'Continue in ACP?' }));
    const sent = since();
    await events.click(offer.getByRole('button', { name: 'Continue in ACP' }));
    await settle();
    expectOneOp(sent, 'session.continueIn', {
      canvas: expect.any(String) as unknown,
      agent: 'a',
      connection: 'zed.acp',
      request: expect.stringMatching(UUID) as unknown,
      then: { text: '/tune' },
    });
  });

  it('mints a request id for the offer and sends it with the one confirm', async () => {
    const { send, view, since } = await open('zed.acp', made());
    await send('/settings');
    const sent = since();
    await events.click(view.getByRole('button', { name: 'Continue in Zed Shell' }));
    await settle();
    expectOneOp(sent, 'session.continueIn', {
      canvas: expect.any(String) as unknown,
      agent: 'a',
      connection: 'zed.terminal',
      request: expect.stringMatching(UUID) as unknown,
      then: { text: '/settings' },
    });
  });

  it('carries a request id from the chip’s continuation too', async () => {
    const { view, since } = await open('zed.free', made());
    await events.click(view.getByRole('button', { name: /^Agent: / }));
    const first = view.getAllByRole('option')[0];
    if (!first) throw new Error('no options');
    const sent = since();
    await events.click(first);
    await settle();
    expectOneOp(sent, 'session.continueIn', {
      canvas: expect.any(String) as unknown,
      agent: 'a',
      connection: 'zed.acp',
      request: expect.stringMatching(UUID) as unknown,
    });
  });
});
