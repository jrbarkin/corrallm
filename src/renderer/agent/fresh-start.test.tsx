import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectOneOp } from '../test-api';
import { events } from '../test-render';
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
 * Settings of a running agent whose connection can't continue its conversation (B16 C4), over
 * unfamiliar adapters: Start new conversation takes the place of Restart, as one operation, and
 * the core's refusal is shown.
 */

/** A catalog whose adapter `zed` declares `resume`. */
const resuming = (resume: boolean) => {
  const catalog = made();
  for (const one of catalog.adapters)
    if (one.id === 'zed') Object.assign(one, { resume, list: resume });
  return catalog;
};

/** The agent's settings sheet, with a session that runs on other settings than its agent has. */
async function sheet(resume: boolean, started: Record<string, unknown> = {}) {
  const fixture = await open('zed.acp', resuming(resume));
  fixture.emit({
    ...STARTED,
    resume,
    list: resume,
    running: { role: 'Earlier role' },
    ...started,
  } as unknown as typeof STARTED);
  await events.click(fixture.view.getByRole('button', { name: 'Agent settings: a' }));
  const panel = within(screen.getByRole('dialog', { name: 'Agent settings: a' }));
  return { ...fixture, panel };
}

describe('Start new conversation for a connection that can’t resume', () => {
  it('is one session.newConversation, with no Restart offered', async () => {
    const { panel, canvas, since } = await sheet(false);
    expect(panel.queryByRole('button', { name: /^Restart/ })).toBeNull();
    expect(panel.queryByText(/keeping its conversation/)).toBeNull();
    const sent = since();
    await events.click(panel.getByRole('button', { name: 'Start new conversation' }));
    await settle();
    expectOneOp(sent, 'session.newConversation', { canvas: canvas.document.id, agent: 'a' });
  });

  it('shows the core’s refusal, and offers the way again', async () => {
    const { panel, canvas, since } = await sheet(false);
    canvas.core.reply('session.newConversation', () =>
      Promise.resolve({
        ok: false,
        error: {
          code: 'refused',
          sentence: 'a has messages waiting to go: start a new conversation once they have gone.',
        },
      }),
    );
    const sent = since();
    await events.click(panel.getByRole('button', { name: 'Start new conversation' }));
    await settle();
    expectOneOp(sent, 'session.newConversation', { canvas: canvas.document.id, agent: 'a' });
    expect(
      await screen.findByText(
        'a has messages waiting to go: start a new conversation once they have gone.',
      ),
    ).toBeTruthy();
    expect(panel.getByRole('button', { name: 'Start new conversation' })).toBeTruthy();
  });

  it('is Restart, as one session.restart, for a connection that does resume', async () => {
    const { panel, canvas, since } = await sheet(true);
    expect(panel.queryByRole('button', { name: 'Start new conversation' })).toBeNull();
    expect(panel.getByText(/keeping its conversation/)).toBeTruthy();
    const sent = since();
    await events.click(panel.getByRole('button', { name: 'Restart with these' }));
    await settle();
    expectOneOp(sent, 'session.restart', { canvas: canvas.document.id, agent: 'a' });
  });

  it('follows the generation that runs when it reports less than its adapter declares', async () => {
    const { panel } = await sheet(true, { resume: false, list: false });
    expect(panel.queryByRole('button', { name: /^Restart/ })).toBeNull();
    expect(panel.getByRole('button', { name: 'Start new conversation' })).toBeTruthy();
  });
});
