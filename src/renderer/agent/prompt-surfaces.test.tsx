import { act, render, screen, within, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { newCanvasId } from '../../shared/canvas';
import { AgentId } from '../../shared/api/ids';
import { Prompt, PromptId } from '../../shared/model/prompts';
import { promptEntryFor, promptNeed } from '../../shared/model/prompt-views';
import { NEW_SESSION } from '../../shared/model/session';
import { sessionView } from '../../shared/model/views';
import type { AgentNode } from '../../shared/model/canvas';
import { fakeCore, expectOneOp } from '../test-api';
import { events } from '../test-render';
import { sessionDisplay } from '../run/sessions';
import { NeedsSidebar } from '../graph/NeedsSidebar';
import { QueuesView } from '../queues/QueuesView';
import { OwnedPrompt } from './OwnedPrompt';
import { Transcript } from './Transcript';

vi.mock('../terminal/screen', async () => ({
  createScreen: (await import('../terminal/test-screen')).fakeScreens.create,
}));
const disposals: (() => void)[] = [];
afterEach(() => {
  for (const stop of disposals.splice(0)) stop();
});
const canvas = newCanvasId();
const id = PromptId.parse('20000000-0000-4000-8000-000000000001');
const agent: AgentNode = {
  id: 'a',
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: 'Worker', adapter: 'claude-code', connection: 'claude-code.sdk', queue: [] },
};
function setup() {
  const core = fakeCore();
  core.install();
  disposals.push(() => {
    core.dispose();
  });
  core.respond('reply', { outcome: 'answered' });
  const prompt = Prompt.parse({
    id,
    agent: 'a',
    raised: 1,
    kind: 'approval',
    title: 'Review this request',
    answerIn: 'api',
    subject: { type: 'command', command: 'echo whole-command', cwd: '/work' },
    choices: [
      { value: 'once', label: 'Allow once', hint: 'allow_once', effects: {} },
      { value: 'no', label: 'No', hint: 'reject_once', effects: {} },
    ],
  });
  const occurrence = { canvas, need: `prompt/a/1/${id}`, prompt, name: 'Worker', standIn: false };
  const item = promptNeed(occurrence, 'you');
  const raw = {
    ...NEW_SESSION,
    entries: [{ id, kind: 'prompt' as const, need: item.id, prompt, name: 'Worker' }],
  };
  const view = sessionView(AgentId.parse('a'), 'claude-code.sdk', raw);
  core.snapshot(`needs:${canvas}`, { items: [item] });
  core.snapshot(`sessions:${canvas}`, { agents: { [AgentId.parse('a')]: view.summary } });
  core.snapshot(`session:${canvas}:a`, view);
  const reply = (answer: Parameters<typeof core.api.reply>[0]['answer']) =>
    core.api.reply({ canvas, to: item.id, answer });
  return { core, item, view, raw, reply };
}
it('answers an owner prompt in Needs from its whole session entry with one reply', async () => {
  const { core, item } = setup();
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
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Allow once' }).disabled).toBe(
      false,
    );
  });
  const allow = screen.getByRole<HTMLButtonElement>('button', { name: 'Allow once' });
  expect(screen.getByText(/whole-command/)).toBeTruthy();
  await events.click(allow);
  expectOneOp(core, 'reply', { canvas, to: item.id, answer: { choice: 'once' } });
});
it('renders live and settled owner prompts in transcript order and answers with the Needs id', async () => {
  const { core, item, view, reply } = setup();
  const shown = sessionDisplay(view.summary, view);
  const answers = {
    onAnswer: vi.fn(),
    onAnswerQuestion: vi.fn(),
    onAnswerPlan: vi.fn(),
    onPromptReply: (_need: string, answer: Parameters<typeof reply>[0]) => reply(answer),
  };
  const rendered = render(
    <Transcript session={shown} agentName="Worker" note="" answers={answers} />,
  );
  await events.click(screen.getByRole('button', { name: 'Allow once' }));
  expectOneOp(core, 'reply', { canvas, to: item.id, answer: { choice: 'once' } });
  const ended = promptEntryFor(
    {
      id,
      kind: 'prompt',
      need: item.id,
      prompt: {
        id,
        agent: 'a',
        raised: 1,
        kind: 'approval',
        title: 'Review this request',
        answerIn: 'api',
      },
      outcome: { type: 'answered-in-terminal', by: 'terminal' },
    },
    'you',
  );
  rendered.rerender(
    <Transcript
      session={{ ...shown, entries: [ended as (typeof shown.entries)[number]] }}
      agentName="Worker"
      note=""
      answers={answers}
    />,
  );
  expect(screen.getByText('Answered in the terminal.')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});
it('shows the same owner card in All queues and sends one reply from its lane', async () => {
  const { core, item } = setup();
  render(
    <QueuesView
      nodes={[agent]}
      sessions={{ a: { ...NEW_SESSION, status: 'waiting' } }}
      run={{ running: false, agents: {} }}
      edits={{} as never}
      backLabel="Canvas"
      onRun={vi.fn()}
      onStop={vi.fn()}
      onOpenAgent={vi.fn()}
      onClose={vi.fn()}
      renderPrompts={() => (
        <OwnedPrompt
          item={item}
          mirror={core.topics}
          onReply={(answer) => core.api.reply({ canvas, to: item.id, answer })}
          onOpen={vi.fn()}
        />
      )}
    />,
  );
  await waitFor(() => {
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Allow once' }).disabled).toBe(
      false,
    );
  });
  const allow = screen.getByRole<HTMLButtonElement>('button', { name: 'Allow once' });
  expect(
    within(screen.getByRole('group', { name: 'Review this request' })).getByText(/whole-command/),
  ).toBeTruthy();
  await events.click(allow);
  expectOneOp(core, 'reply', { canvas, to: item.id, answer: { choice: 'once' } });
});

it('keeps answers disabled until the whole matching occurrence arrives on the session topic', async () => {
  const { core, item, view, reply } = setup();
  core.snapshot(`session:${canvas}:a`, { ...view, entries: {}, order: [] });
  render(<OwnedPrompt item={item} mirror={core.topics} onReply={reply} onOpen={vi.fn()} />);
  await waitFor(() => {
    expect(core.subscriptions.has(`session:${canvas}:a`)).toBe(true);
  });
  const allow = screen.getByRole<HTMLButtonElement>('button', { name: 'Allow once' });
  expect(allow.disabled).toBe(true);
  await events.click(allow);
  expect(core.operations).toEqual([]);
  act(() => {
    core.change({
      topic: `session:${canvas}:a`,
      rev: 1,
      entries: { upsert: Object.values(view.entries), order: view.order },
    });
  });
  await waitFor(() => {
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Allow once' }).disabled).toBe(
      false,
    );
  });
});
