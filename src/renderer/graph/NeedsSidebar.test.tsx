import { cleanup, render, screen, waitFor, act, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { NeedsItem } from '../../shared/model/needs';
import { newCanvasId } from '../../shared/canvas';
import { fakeCore, expectOneOp } from '../test-api';
import { events } from '../test-render';
import { runCatalog } from './agents';
import { NeedsSidebar } from './NeedsSidebar';
const cores: ReturnType<typeof fakeCore>[] = [];
afterEach(() => {
  cleanup();
  cores.splice(0).forEach((core) => {
    core.dispose();
  });
});
const canvas = newCanvasId();
const proposal: NeedsItem = {
  id: 'proposal/11111111-1111-4111-8111-111111111111',
  canvas,
  kind: 'proposal',
  for: 'you',
  by: ['you'],
  title: 'Orchestrator asks to delete Reviewer',
  detail: '3 queued tasks and its conversation',
  choices: [
    { value: 'allow', label: 'Allow' },
    { value: 'refuse', label: 'Refuse' },
  ],
  answerIn: 'api',
};
const file: NeedsItem = {
  ...proposal,
  id: 'file/22222222-2222-4222-8222-222222222222',
  kind: 'file',
  title: 'team.corral changed on disk',
  detail: 'Reviewer’s queue changed',
  choices: [
    { value: 'apply', label: 'Apply' },
    { value: 'keep', label: 'Keep' },
  ],
};
async function setup(items: NeedsItem[]) {
  const core = fakeCore();
  cores.push(core);
  core.snapshot(`needs:${canvas}`, { items });
  render(
    <NeedsSidebar
      canvas={canvas}
      mirror={core.topics}
      needs={[]}
      input={{
        canvas,
        nodes: [],
        run: { running: false, agents: {} },
        sessions: {},
        catalog: runCatalog(),
      }}
      onDecide={() => undefined}
      onAnswer={() => undefined}
      onOpen={() => undefined}
      onReply={(to, choice) => core.api.reply({ canvas, to, answer: { choice } })}
    />,
  );
  if (items.length > 0) {
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Needs you' })).not.toHaveProperty(
        'disabled',
        true,
      );
    });
    await events.click(screen.getByRole('button', { name: 'Needs you' }));
  }
  return core;
}
it.each([
  ['allow', 'Allow', 'allowed'],
  ['refuse', 'Refuse', 'refused'],
  ['allow', 'Allow', 'stale'],
  ['apply', 'Apply', 'applied'],
  ['keep', 'Keep', 'kept'],
  ['apply', 'Apply', 'superseded'],
] as const)(
  'answers %s with one reply and keeps the %s outcome after topic removal',
  async (choice, label, outcome) => {
    const item = choice === 'apply' || choice === 'keep' ? file : proposal;
    const core = await setup([item]);
    core.reply('reply', () => {
      core.change({ topic: `needs:${canvas}`, rev: 1, replace: { items: [] } });
      return Promise.resolve({ ok: true, value: { outcome, revs: {} } });
    });
    expect(await screen.findByText(item.title)).toBeTruthy();
    expect(screen.getByText(item.detail ?? '')).toBeTruthy();
    await events.click(await screen.findByRole('button', { name: label }));
    await waitFor(() => {
      expectOneOp(core, 'reply', { canvas, to: item.id, answer: { choice } });
    });
    expect((await screen.findByRole('status')).textContent.toLowerCase()).toContain(outcome);
    expect(screen.queryByRole('button', { name: label })).toBeNull();
    await events.click(screen.getByRole('button', { name: `Dismiss ${item.title}` }));
    expect(screen.queryByRole('complementary', { name: 'Needs you' })).toBeNull();
  },
);
it('shows one current review from pushed state and Keep alone for an invalid file', async () => {
  const core = await setup([]);
  expect(screen.queryByRole('complementary')).toBeNull();
  act(() => {
    core.change({
      topic: `needs:${canvas}`,
      rev: 1,
      replace: { items: [{ ...file, choices: [{ value: 'keep', label: 'Keep' }] }] },
    });
  });
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Needs you' })).not.toHaveProperty('disabled', true);
  });
  await events.click(screen.getByRole('button', { name: 'Needs you' }));
  const sidebar = await screen.findByRole('complementary', { name: 'Needs you' });
  expect(within(sidebar).getAllByText(file.title)).toHaveLength(1);
  expect(within(sidebar).queryByRole('button', { name: 'Apply' })).toBeNull();
  expect(within(sidebar).getByRole('button', { name: 'Keep' })).toBeTruthy();
});
it('keeps a refused reply at its card and lets it be retried', async () => {
  const core = await setup([proposal]);
  core.reply('reply', { ok: false, error: { code: 'unavailable', sentence: 'Not saved' } });
  await events.click(await screen.findByRole('button', { name: 'Allow' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Not saved');
  expect(screen.getByRole('button', { name: 'Allow' })).not.toHaveProperty('disabled', true);
});
