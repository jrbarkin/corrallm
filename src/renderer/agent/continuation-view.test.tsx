import { act, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NEW_SESSION } from '../../shared/model/session';
import { events } from '../test-render';
import { expectOneOp } from '../test-api';
import { made, open, openHeld, settle, STARTED } from './test-agent-view';
import type { ConnectionDescriptor } from '../../shared/adapter';

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
    const { replies, view, since } = await open('zed.free', made());
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

  it('mints the request id when the offer opens, and sends that one with the confirm', async () => {
    const minted = vi.spyOn(crypto, 'randomUUID');
    const { send, view, since, emit } = await open('zed.acp', made());
    await send('/settings');
    const opened = minted.mock.results.map(({ value }) => value as string);
    // The view re-renders while the offer waits; its id does not change.
    emit(STARTED, { type: 'commands', commands: OFFERED });
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
    const request = (sent.operations[0]?.args as { request: string }).request;
    expect(opened).toContain(request);
    minted.mockRestore();
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

  it('names the missing target nowhere, saying so and sending nothing', async () => {
    const catalog = made((c) => {
      const acp = c['zed.acp'];
      if (acp?.continueIn) acp.continueIn.connection = 'zed.gone';
    });
    const { replies, send, view, since } = await open('zed.acp', catalog);
    const sent = since();
    await send('/settings');
    expect(
      view.getByText(
        /^\/settings runs only in the connection a continues in, which this build lacks/,
      ),
    ).toBeTruthy();
    expect(replies.send).not.toHaveBeenCalled();
    expect(sent.operations).toEqual([]);
  });
});

describe('a continuation with images', () => {
  const taking = (images: ConnectionDescriptor['images']) =>
    made((c) => {
      const terminal = c['zed.terminal'];
      if (terminal) terminal.images = images;
    });
  const PNG = { types: ['image/png' as const], maxBytes: 1024, max: 2 };

  it('keeps the text and images, offers nothing and sends nothing where the destination takes none', async () => {
    const { composer, view, since, replies } = await open('zed.acp', taking(null));
    const file = new File(['image'], 'diagram.png', { type: 'image/png' });
    await events.drop(composer, { dataTransfer: { files: [file] } });
    await settle();
    await events.change(composer, { target: { value: '/settings now' } });
    const sent = since();
    await events.keyDown(composer, { key: 'Enter' });
    await settle();
    expect(view.queryByRole('group', { name: /^Continue in/ })).toBeNull();
    expect(view.getByText('Zed Shell takes no images.')).toBeTruthy();
    expect(composer.value).toBe('/settings now');
    expect(view.getByRole('list', { name: 'Images' })).toBeTruthy();
    expect(sent.operations).toEqual([]);
    expect(replies.send).not.toHaveBeenCalled();
  });

  it('continues with the exact text and images where the destination takes them', async () => {
    const { composer, view, since } = await open('zed.acp', taking(PNG));
    const file = new File(['image'], 'diagram.png', { type: 'image/png' });
    await events.drop(composer, { dataTransfer: { files: [file] } });
    await settle();
    const input = '  /settings now\n ';
    await events.change(composer, { target: { value: input } });
    await events.keyDown(composer, { key: 'Enter' });
    await settle();
    const sent = since();
    await events.click(view.getByRole('button', { name: 'Continue in Zed Shell' }));
    await settle();
    expectOneOp(sent, 'session.continueIn', {
      canvas: expect.any(String) as unknown,
      agent: 'a',
      connection: 'zed.terminal',
      request: expect.stringMatching(UUID) as unknown,
      then: { text: input, images: [{ mediaType: 'image/png', data: 'aW1hZ2U=' }] },
    });
  });

  it('puts the text and images back when the core refuses the continuation anyway', async () => {
    const { composer, view, canvas } = await open('zed.acp', taking(PNG));
    canvas.core.reply('session.continueIn', {
      ok: false,
      error: { code: 'refused', sentence: 'Zed Shell is busy.' },
    });
    const file = new File(['image'], 'diagram.png', { type: 'image/png' });
    await events.drop(composer, { dataTransfer: { files: [file] } });
    await settle();
    await events.change(composer, { target: { value: '/settings now' } });
    await events.keyDown(composer, { key: 'Enter' });
    await settle();
    await events.click(view.getByRole('button', { name: 'Continue in Zed Shell' }));
    await settle();
    const back = view.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message a' });
    expect(back.value).toBe('/settings now');
    expect(view.getByRole('list', { name: 'Images' })).toBeTruthy();
  });
});

describe('a run hold over an unfamiliar connection', () => {
  it('takes ordinary text as its answer, not a command the session offers, even with a leading space', async () => {
    const { canvas, send, composer } = await openHeld('zed.acp', made());
    expect(composer.placeholder).toBe('What should change?');
    const before = canvas.core.operations.length;
    await send('Cover the empty state');
    expect(canvas.core.operations.slice(before).map(({ op }) => op)).toEqual(['reply']);
    const next = canvas.core.operations.length;
    await send(' /compact');
    expect(canvas.core.operations.slice(next).map(({ op }) => op)).toEqual(['message']);
  });
});

describe('the note a panel that can’t open leaves', () => {
  const mcp = () =>
    made((c) => {
      const acp = c['zed.acp'];
      if (acp) acp.panels = { mcp: { changes: [] } };
    });

  it('goes once something else is sent, and does not take the keyboard', async () => {
    const { view, send, composer } = await open('zed.acp', mcp());
    await send('/mcp');
    expect(view.getByRole('group', { name: 'Not available' })).toBeTruthy();
    expect(document.activeElement).not.toBe(view.getByRole('button', { name: 'Close' }));
    await send('hello');
    expect(view.queryByRole('group', { name: 'Not available' })).toBeNull();
    expect(composer).toBeTruthy();
  });

  it('goes when an offer opens', async () => {
    const { view, send } = await open('zed.acp', mcp());
    await send('/mcp');
    await send('/settings');
    expect(view.queryByRole('group', { name: 'Not available' })).toBeNull();
    expect(view.getByRole('group', { name: 'Continue in Zed Shell?' })).toBeTruthy();
  });

  it('says the session didn’t report, not that it hasn’t started, once it runs without a report', async () => {
    const { view, send, canvas } = await open('zed.acp', mcp());
    act(() => {
      canvas.session('a', {
        ...(canvas.session('a') ?? NEW_SESSION),
        features: null,
        // It started, and said its mode: only what it supports couldn't be read.
        mode: 'manual',
      });
    });
    await send('/mcp');
    expect(view.getByText(/didn’t say what it supports/)).toBeTruthy();
    expect(view.queryByText(/once the session has started/)).toBeNull();
  });

  it('says it can’t open yet before the session has started', async () => {
    const { view, send } = await open('zed.acp', mcp());
    await send('/mcp');
    expect(view.getByText(/once the session has started/)).toBeTruthy();
  });

  it('does not open for a connection the session was started on, once the agent moves on', async () => {
    // As the manager does, the old generation's features go with a switch: a panel the new
    // connection declares can't open before its session starts.
    const catalog = made((c) => {
      for (const id of ['zed.acp', 'zed.free']) {
        const one = c[id];
        if (one) one.panels = { mcp: { changes: [] } };
      }
    });
    const { view, emit, send, canvas } = await open('zed.free', catalog);
    emit(STARTED);
    await events.click(view.getByRole('button', { name: /^Agent: / }));
    const first = view.getAllByRole('option')[0];
    if (!first) throw new Error('no options');
    await events.click(first);
    await settle();
    const before = canvas.core.operations.length;
    await send('/mcp');
    expect(canvas.core.operations.slice(before).map(({ op }) => op)).toEqual([]);
    expect(view.getByRole('group', { name: 'Not available' })).toBeTruthy();
  });
});

describe('a stale offer', () => {
  it('goes when the agent’s connection changes, and nothing is continued', async () => {
    const { view, send, since } = await open('zed.acp', made());
    await send('/settings');
    expect(view.getByRole('group', { name: 'Continue in Zed Shell?' })).toBeTruthy();
    const sent = since();
    await events.click(view.getByRole('button', { name: /^Agent: / }));
    await events.click(view.getByRole('option', { name: 'Zed Agent · Free' }));
    await settle();
    expect(view.queryByRole('group', { name: /^Continue in/ })).toBeNull();
    // Only the switch you picked: the offer's text was never continued anywhere.
    expect(sent.operations).toEqual([
      {
        op: 'session.continueIn',
        args: {
          canvas: expect.any(String) as unknown,
          agent: 'a',
          connection: 'zed.free',
        },
      },
    ]);
  });
});
