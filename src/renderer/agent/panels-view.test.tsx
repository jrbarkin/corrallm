import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionDescriptor } from '../../shared/adapter';
import type { McpServer } from '../../shared/session';
import { events } from '../test-render';
import { expectOneOp, expectOneRead } from '../test-api';
import { made, open, settle, STARTED } from './test-agent-view';

// jsdom cannot draw xterm.js: a fake terminal stands in.
vi.mock('../terminal/screen', async () => {
  const { fakeScreens } = await import('../terminal/test-screen');
  return { createScreen: fakeScreens.create };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/*
 * The panels an unfamiliar connection declares, and what its session's features let them offer:
 * each reads the descriptor and the session's usable features alone, with no vendor to lean on.
 */

type Panels = ConnectionDescriptor['panels'];
/** A catalog whose `zed.acp` declares `panels` and whether its continuation signs in. */
const withPanels = (panels: Panels, mcpSignIn = true) =>
  made((connections) => {
    const acp = connections['zed.acp'];
    if (!acp?.continueIn) throw new Error('The fixture needs its continuation.');
    acp.panels = panels;
    acp.continueIn.mcpSignIn = mcpSignIn;
  });

const SERVERS: McpServer[] = [
  { name: 'github', status: 'connected', scope: 'user', tools: 2 },
  { name: 'sentry', status: 'failed', error: 'Connection refused' },
  { name: 'cache', status: 'disabled' },
  { name: 'linear', status: 'needs-auth' },
];

/** The buttons of the MCP panel's server rows, by server. */
function rows(panel: HTMLElement): Record<string, (string | null)[]> {
  const found: Record<string, (string | null)[]> = {};
  for (const row of within(panel).getAllByRole('listitem')) {
    found[row.getAttribute('aria-label') ?? ''] = within(row)
      .queryAllByRole('button')
      .map((button) => button.textContent);
  }
  return found;
}

describe('a declared panel that can’t open now', () => {
  it('says so while no generation is ready, and sends and records nothing', async () => {
    const { replies, send, view, since } = await open(
      'zed.acp',
      withPanels({ mcp: { changes: [] } }),
    );
    const sent = since();
    await send('/mcp');
    const note = within(view.getByRole('group', { name: 'Not available' }));
    expect(note.getByText(/^\/mcp can’t open yet.*Nothing was sent/)).toBeTruthy();
    expect(replies.send).not.toHaveBeenCalled();
    expect(sent.operations).toEqual([]);
    expect(sent.reads).toEqual([]);
    expect(view.queryByRole('group', { name: 'MCP servers' })).toBeNull();
    // Esc closes the note, not the view.
    await events.keyDown(note.getByRole('button', { name: 'Close' }), { key: 'Escape' });
    expect(view.queryByRole('group', { name: 'Not available' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'a' })).toBeTruthy();
  });

  it('says so when the session can’t use it, never sending the command as a message', async () => {
    // Declared, but its adapter can't list conversations: no /resume panel in this session.
    const { replies, send, view, emit, since } = await open(
      'zed.acp',
      withPanels({ resume: true }),
    );
    emit({ ...STARTED, type: 'started', list: false } as typeof STARTED);
    const sent = since();
    await send('/resume');
    expect(view.getByText(/^\/resume isn’t available now: .*Nothing was sent\.$/)).toBeTruthy();
    expect(replies.send).not.toHaveBeenCalled();
    expect(sent.operations).toEqual([]);
    expect(sent.reads).toEqual([]);
  });

  it('is left out of completion until it can open', async () => {
    const { composer, view, emit } = await open('zed.acp', withPanels({ mcp: { changes: [] } }));
    await events.change(composer, { target: { value: '/m', selectionStart: 2 } });
    expect(view.queryByRole('listbox', { name: 'Commands' })).toBeNull();
    emit(STARTED);
    await events.change(composer, { target: { value: '/mc', selectionStart: 3 } });
    expect(
      within(view.getByRole('listbox', { name: 'Commands' }))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['/mcp' + 'Manage MCP servers']);
  });
});

describe('an unfamiliar connection’s /mcp', () => {
  it('records one view command, then reads the servers as a separate read', async () => {
    const { send, view, emit, canvas, since } = await open(
      'zed.acp',
      withPanels({ mcp: { changes: ['reconnect'] } }),
      (fake) => fake.replies.mcp.mockResolvedValue(SERVERS),
    );
    emit(STARTED);
    const sent = since();
    await send('/mcp');
    expectOneOp(sent, 'session.viewCommand', {
      canvas: canvas.document.id,
      agent: 'a',
      text: '/mcp',
    });
    expectOneRead(sent, 'session.mcpServers', { canvas: canvas.document.id, agent: 'a' });
    expect(view.getByRole('group', { name: 'MCP servers' })).toBeTruthy();
  });

  it('offers only the declared changes the server’s state suits', async () => {
    const { send, view, emit, since, canvas } = await open(
      'zed.acp',
      withPanels({ mcp: { changes: ['reconnect'] } }),
      (fake) => {
        fake.replies.mcp.mockResolvedValue(SERVERS);
        fake.replies.changeMcp.mockResolvedValue(SERVERS);
      },
    );
    emit(STARTED);
    await send('/mcp');
    const panel = within(view.getByRole('group', { name: 'MCP servers' }));
    expect(rows(view.getByRole('group', { name: 'MCP servers' }))).toEqual({
      github: ['Reconnect'],
      sentry: ['Reconnect'],
      // Enabling is a change this connection doesn't declare.
      cache: [],
      linear: ['Sign in in Zed Shell'],
    });
    const sent = since();
    await events.click(within(panel.getByRole('listitem', { name: 'sentry' })).getByRole('button'));
    await settle();
    expectOneOp(sent, 'session.changeMcpServer', {
      canvas: canvas.document.id,
      agent: 'a',
      server: 'sentry',
      change: 'reconnect',
    });
  });

  it('offers disable and enable where declared', async () => {
    const { send, view, emit } = await open(
      'zed.acp',
      withPanels({ mcp: { changes: ['enable', 'disable'] } }),
      (fake) => fake.replies.mcp.mockResolvedValue(SERVERS),
    );
    emit(STARTED);
    await send('/mcp');
    expect(rows(view.getByRole('group', { name: 'MCP servers' }))).toEqual({
      github: ['Disable'],
      sentry: ['Disable'],
      cache: ['Enable'],
      linear: ['Sign in in Zed Shell', 'Disable'],
    });
  });

  it('is a read-only list where it declares no change', async () => {
    const { send, view, emit } = await open(
      'zed.acp',
      withPanels({ mcp: { changes: [] } }, false),
      (fake) => fake.replies.mcp.mockResolvedValue(SERVERS),
    );
    emit(STARTED);
    await send('/mcp');
    const panel = within(view.getByRole('group', { name: 'MCP servers' }));
    expect(rows(view.getByRole('group', { name: 'MCP servers' }))).toEqual({
      github: [],
      sentry: [],
      cache: [],
      linear: [],
    });
    expect(panel.getByText('Needs you to sign in')).toBeTruthy();
  });

  it('signs in in its continuation connection, in the same one operation, only where it declares so', async () => {
    const { send, view, emit, since } = await open(
      'zed.acp',
      withPanels({ mcp: { changes: [] } }),
      (fake) => fake.replies.mcp.mockResolvedValue(SERVERS),
    );
    emit(STARTED);
    await send('/mcp');
    const sent = since();
    await events.click(view.getByRole('button', { name: 'Sign in in Zed Shell' }));
    await settle();
    expectOneOp(sent, 'session.continueIn', {
      canvas: expect.any(String) as unknown,
      agent: 'a',
      connection: 'zed.terminal',
      then: { text: '/mcp' },
    });
  });
});

describe('an unfamiliar connection’s /resume', () => {
  it('reads the conversations once the panel is recorded, and resumes the one picked in one operation', async () => {
    const now = Date.now();
    const { send, view, emit, since, canvas } = await open(
      'zed.acp',
      withPanels({ resume: true }),
      (fake) =>
        fake.replies.sessions.mockResolvedValue([
          { id: 'k2', title: 'Add a cart', modified: now - 60_000, current: false },
        ]),
    );
    emit(STARTED);
    const sent = since();
    await send('/resume');
    expectOneOp({ operations: sent.operations.slice(0, 1) }, 'session.viewCommand', {
      canvas: canvas.document.id,
      agent: 'a',
      text: '/resume',
    });
    expectOneRead(sent, 'session.conversations', { canvas: canvas.document.id, agent: 'a' });
    const picker = within(view.getByRole('listbox', { name: 'Resume a conversation' }));
    const picked = since();
    await events.click(picker.getByRole('option', { name: /^Add a cart/ }));
    await settle();
    expectOneOp(picked, 'session.resumeConversation', {
      canvas: canvas.document.id,
      agent: 'a',
      conversation: 'k2',
    });
  });
});
