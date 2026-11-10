import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { newCanvasId } from '../../shared/canvas';
import { AgentId } from '../../shared/api/ids';
import { Prompt, PromptId } from '../../shared/model/prompts';
import { promptEntryFor, promptNeed } from '../../shared/model/prompt-views';
import { NEW_SESSION } from '../../shared/model/session';
import { sessionView } from '../../shared/model/views';
import type { AgentNode } from '../../shared/model/canvas';
import { fakeCore, expectOneOp } from '../test-api';
import { events } from '../test-render';
import { NeedsSidebar } from '../graph/NeedsSidebar';
import { OwnedPrompt } from './OwnedPrompt';
import { PromptCard } from './PromptCard';

/*
 * B23: a Terminal agent's held prompt. One its CLI's terminal also answers (`both`) says so and
 * offers the terminal; one only corrallm answers (`api`) offers Answer in terminal; either shows
 * how long until it moves to its terminal; one that moved says so.
 */

vi.mock('../terminal/screen', async () => ({
  createScreen: (await import('../terminal/test-screen')).fakeScreens.create,
}));
const disposals: (() => void)[] = [];
afterEach(() => {
  for (const stop of disposals.splice(0)) stop();
  vi.useRealTimers();
});

const canvas = newCanvasId();
const id = PromptId.parse('20000000-0000-4000-8000-000000000002');
const agent: AgentNode = {
  id: 'a',
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: 'Worker', adapter: 'claude-code', connection: 'claude-code.terminal', queue: [] },
};
const NOW = 1_800_000_000_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
});

function setup(answerIn: 'both' | 'api') {
  const core = fakeCore();
  core.install();
  disposals.push(() => {
    core.dispose();
  });
  core.respond('reply', { outcome: 'answered' });
  const prompt = Prompt.parse({
    id,
    agent: 'a',
    raised: NOW,
    until: NOW + 20_000,
    kind: 'approval',
    title: 'Worker wants to run a command',
    answerIn,
    subject: { type: 'command', command: 'echo held', cwd: '/work' },
    choices: [
      { value: 'allow', label: 'Yes', hint: 'allow_once', effects: {} },
      { value: 'deny', label: 'No', hint: 'reject_once', effects: {} },
    ],
  });
  const occurrence = {
    canvas,
    need: `prompt/a/1/${id}`,
    prompt,
    name: 'Worker',
    standIn: false,
    releasable: true,
  };
  const item = promptNeed(occurrence, 'you');
  const raw = {
    ...NEW_SESSION,
    entries: [
      {
        id,
        kind: 'prompt' as const,
        need: item.id,
        prompt,
        name: 'Worker',
        releasable: true as const,
      },
    ],
  };
  const view = sessionView(AgentId.parse('a'), 'claude-code.terminal', raw);
  const entry = promptEntryFor(
    { id, kind: 'prompt', need: item.id, prompt, name: 'Worker', releasable: true },
    'you',
  );
  core.snapshot(`needs:${canvas}`, { items: [item] });
  core.snapshot(`session:${canvas}:a`, view);
  return { core, item, entry };
}

it('says a prompt its terminal also answers can be answered in either place, and offers the terminal', async () => {
  const { core, item, entry } = setup('both');
  const open = vi.fn();
  render(
    <PromptCard
      entry={entry as Parameters<typeof PromptCard>[0]['entry']}
      onReply={(answer) => core.api.reply({ canvas, to: item.id, answer })}
      onOpenTerminal={open}
    />,
  );
  expect(screen.getByText(/or answer it in its terminal/i)).toBeTruthy();
  // Its choices are still answerable here, and there is no Answer in terminal (its terminal already is).
  await events.click(screen.getByRole('button', { name: 'Yes' }));
  expectOneOp(core, 'reply', { canvas, to: item.id, answer: { choice: 'allow' } });
});

it('opens the terminal from a prompt both places answer', async () => {
  const { entry } = setup('both');
  const open = vi.fn();
  render(
    <PromptCard
      entry={entry as Parameters<typeof PromptCard>[0]['entry']}
      onReply={() => Promise.resolve()}
      onOpenTerminal={open}
    />,
  );
  await events.click(screen.getByRole('button', { name: 'Open terminal' }));
  expect(open).toHaveBeenCalledTimes(1);
});

it('counts down to the move to its terminal, from the prompt’s deadline', async () => {
  const { entry } = setup('api');
  render(
    <PromptCard
      entry={entry as Parameters<typeof PromptCard>[0]['entry']}
      onReply={() => Promise.resolve()}
    />,
  );
  expect(screen.getByRole('timer').textContent).toMatch(/20 s/);
  act(() => {
    vi.advanceTimersByTime(5000);
  });
  await waitFor(() => {
    expect(screen.getByRole('timer').textContent).toMatch(/15 s/);
  });
});

it('hands an api prompt back to its terminal with one reply, from Needs', async () => {
  const { core, item } = setup('api');
  render(
    <NeedsSidebar
      canvas={canvas}
      mirror={core.topics}
      nodes={[agent]}
      onReply={(to, answer) => core.api.reply({ canvas, to, answer })}
      onOpen={vi.fn()}
    />,
  );
  await waitFor(() => {
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Needs you' }).disabled).toBe(
      false,
    );
  });
  await events.click(screen.getByRole('button', { name: 'Needs you' }));
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Answer in terminal' })).toBeTruthy();
  });
  await events.click(screen.getByRole('button', { name: 'Answer in terminal' }));
  expectOneOp(core, 'reply', { canvas, to: item.id, answer: { choice: 'answer-in-terminal' } });
});

it('reads a prompt that moved to its terminal as such', () => {
  const { entry } = setup('api');
  const moved = {
    ...entry,
    prompt: {
      id,
      kind: 'approval' as const,
      agent: 'a',
      raised: NOW,
      answerIn: 'api' as const,
      title: 'Worker wants to run a command',
    },
    outcome: { type: 'moved' as const },
  };
  render(
    <PromptCard
      entry={moved as unknown as Parameters<typeof PromptCard>[0]['entry']}
      onReply={() => Promise.resolve()}
    />,
  );
  expect(screen.getByRole('status').textContent).toBe('Moved to its terminal.');
});

it('keeps OwnedPrompt’s loading state free of a button for what is not loaded', () => {
  const { core, item } = setup('api');
  render(
    <OwnedPrompt
      item={item}
      mirror={core.topics}
      onReply={() => Promise.resolve()}
      onOpen={vi.fn()}
    />,
  );
  expect(screen.queryByRole('timer')).toBeNull();
});
