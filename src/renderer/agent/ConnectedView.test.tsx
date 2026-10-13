import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { SessionEvent } from '../../shared/session';
import { GraphEditor } from '../graph/GraphEditor';
import type { Graph, GraphNode } from '../graph/graph';
import { OpenLinkContext } from '../open-link';
import { fakeBackend } from '../test-backend';

// jsdom cannot draw xterm.js: a fake terminal stands in, for an agent switched to Terminal.
vi.mock('../terminal/screen', async () => {
  const { fakeScreens } = await import('../terminal/test-screen');
  return { createScreen: fakeScreens.create };
});

const agent = (id: string, data: Partial<GraphNode['data']> = {}): GraphNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id, ...data },
});

/** Lets IPC replies (promises) settle. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

/**
 * The editor, with agent `a` (as `data` says) opened in its view, and main faked (`prepare` sets
 * the fake up before the view opens).
 */
async function open(
  data: Partial<GraphNode['data']> = {},
  prepare?: (fake: ReturnType<typeof fakeBackend>) => void,
) {
  const fake = fakeBackend();
  prepare?.(fake);
  const graph: Graph = { nodes: [agent('a', data)], edges: [] };
  /** Where clicked links go: to main, in the app. */
  const openLink = vi.fn<(url: string) => void>();
  const { container } = render(
    <OpenLinkContext.Provider value={openLink}>
      <GraphEditor initialGraph={graph} sessionBackend={fake.backend} />
    </OpenLinkContext.Provider>,
  );
  const card = () => {
    const element = container.querySelector<HTMLElement>('.react-flow__node[data-id="a"]');
    if (!element) throw new Error('no agent');
    return element;
  };
  fireEvent.doubleClick(card());
  await settle();
  const view = within(screen.getByRole('dialog', { name: 'a' }));
  const composer = view.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message a' });
  const send = async (text: string) => {
    fireEvent.change(composer, { target: { value: text } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await settle();
  };
  const transcript = within(view.getByRole('log', { name: 'Transcript' }));
  /** Main says `events` happened in a's session. */
  const emit = (...events: SessionEvent[]) => {
    act(() => {
      fake.emit('a', 'sdk', ...events);
    });
  };
  return { ...fake, container, card, view, composer, send, transcript, emit, openLink };
}

const MODELS = [
  { value: 'opus', label: 'Opus', description: 'The most capable' },
  { value: 'haiku', label: 'Haiku', description: 'The fastest' },
];

describe('a connected agent', () => {
  it('is connected from its agent chip: shown on its card, its chip and its lane in All queues', async () => {
    const { backend, card, view } = await open();
    expect(backend.start).not.toHaveBeenCalled();
    const chip = () => view.getByRole('button', { name: /^Agent: / });
    expect(chip().getAttribute('aria-label')).toBe('Agent: Claude · Simulated');
    expect(card().getAttribute('aria-label')).toBe('a, Claude');

    fireEvent.click(chip());
    fireEvent.click(view.getByRole('option', { name: /^Claude · Agent SDK/ }));
    expect(chip().getAttribute('aria-label')).toBe('Agent: Claude · Agent SDK');
    expect(card().getAttribute('aria-label')).toBe('a, Claude · SDK');
    expect(card().querySelector('.graph-agent')?.getAttribute('data-connection')).toBe('SDK');
    // Its view is open: its session starts.
    await settle();
    expect(backend.start).toHaveBeenCalledWith('a', {
      connection: 'sdk',
      model: null,
      mode: null,
    });

    fireEvent.click(view.getByRole('button', { name: 'All queues' }));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    expect(queues.getByText('SDK').getAttribute('title')).toMatch(/Agent SDK/);
    fireEvent.click(queues.getByRole('button', { name: 'Open a' }));

    // Another type of agent is simulated: the session closes.
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole('option', { name: 'Codex' }));
    expect(card().getAttribute('aria-label')).toBe('a, Codex');
    expect(backend.close).toHaveBeenCalledWith('a');
  });

  it('does not run through the Agent SDK on a Claude subscription: it says why, and switches to Terminal', async () => {
    const why =
      "Claude Code is logged in with your Claude subscription, which Anthropic doesn't allow " +
      'other products to use through the Agent SDK: run this agent in Terminal, or give Claude ' +
      'Code an API key or a cloud provider.';
    const { backend, view, transcript, card } = await open({ connection: 'sdk' }, (fake) => {
      // As main does: it says why, then the start fails saying the same.
      fake.backend.start.mockImplementation((_agent, options) => {
        if (options.connection !== 'sdk') return Promise.resolve(null);
        fake.emit('a', 'sdk', {
          type: 'notice',
          id: 'login',
          level: 'error',
          text: why,
          switchTo: 'terminal',
        });
        return Promise.reject(
          new Error(`Error invoking remote method 'session:start': Error: ${why}`),
        );
      });
    });
    expect(transcript.getAllByRole('alert').map((alert) => alert.textContent)).toEqual([
      `${why}Switch to Terminal`,
    ]);

    fireEvent.click(transcript.getByRole('button', { name: 'Switch to Terminal' }));
    expect(view.getByRole('button', { name: /^Agent: / }).getAttribute('aria-label')).toBe(
      'Agent: Claude · Terminal',
    );
    expect(card().getAttribute('aria-label')).toBe('a, Claude · Terminal');
    await settle();
    expect(backend.start).toHaveBeenLastCalledWith(
      'a',
      expect.objectContaining({ connection: 'terminal' }),
    );
    // Its terminal starts: the Agent SDK's refusal is not taken for the terminal's own problem.
    expect(view.getByText('Starting Claude Code…')).toBeTruthy();
  });

  it('offers Terminal first in its agent chip, and says the Agent SDK needs an API key', async () => {
    const { view } = await open();
    fireEvent.click(view.getByRole('button', { name: /^Agent: / }));
    const options = view.getAllByRole('option').map((option) => option.textContent);
    expect(options.slice(0, 3)).toEqual([
      expect.stringMatching(/^Claude · Terminal.*works with your Claude login/),
      expect.stringMatching(/^Claude · Agent SDK.*needs an API key or a cloud provider/),
      expect.stringMatching(/^Claude · Simulated/),
    ]);
  });

  it('opens a link in its reply through main, which asks first; never in the app', async () => {
    const { send, transcript, emit, sent, openLink } = await open({ connection: 'sdk' });
    await send('Where are the docs?');
    emit(
      { type: 'user', id: sent(), text: 'Where are the docs?' },
      { type: 'text', id: 'x', text: 'See [the queue docs](https://docs.example.com/queues).' },
    );
    const link = transcript.getByRole('link', { name: 'the queue docs' });
    expect(link.getAttribute('target')).toBeNull();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(openLink).toHaveBeenCalledExactlyOnceWith('https://docs.example.com/queues');
  });

  it('switches to bypassing permissions once confirmed, and hides it where the CLI turns it off', async () => {
    const { backend, view, emit } = await open({ connection: 'sdk' });
    emit({ type: 'started', model: 'opus', mode: 'manual', models: MODELS });
    fireEvent.click(view.getByRole('button', { name: 'Mode: Manual' }));
    fireEvent.click(view.getByRole('menuitemradio', { name: /^Bypass permissions/ }));
    expect(backend.setMode).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'Bypass permissions' }));
    await settle();
    expect(backend.setMode).toHaveBeenCalledWith('a', 'bypassPermissions');

    // Started again where the user's settings turn it off: not offered.
    emit(
      { type: 'closed' },
      {
        type: 'started',
        model: 'opus',
        mode: 'manual',
        models: MODELS,
        modes: ['manual', 'acceptEdits', 'plan', 'auto'],
      },
    );
    fireEvent.click(view.getByRole('button', { name: 'Mode: Manual' }));
    expect(view.getAllByRole('menuitemradio')).toHaveLength(4);
    expect(view.queryByRole('menuitemradio', { name: /^Bypass permissions/ })).toBeNull();
  });

  it('says what it needs to run: a project folder', async () => {
    const { transcript } = await open({ connection: 'sdk' });
    expect(transcript.getByText(/Choose a project folder for this canvas/)).toBeTruthy();
  });

  it('plays a turn from main: the reply, tool calls, a permission prompt, what it used', async () => {
    const { backend, view, send, transcript, emit, sent } = await open({ connection: 'sdk' });
    emit({ type: 'started', model: 'opus', mode: 'manual', models: MODELS });
    const model = view.getByRole('button', { name: /^Model: / });
    expect(model.getAttribute('aria-label')).toBe('Model: Opus');
    fireEvent.click(model);
    fireEvent.click(view.getByRole('menuitemradio', { name: /^Haiku/ }));
    await settle();
    expect(backend.setModel).toHaveBeenCalledWith('a', 'haiku');

    await send('Fix the bug');
    const id = sent();
    emit(
      { type: 'user', id, text: 'Fix the bug' },
      { type: 'status', status: 'working' },
      { type: 'text', id: 'x', text: 'Fixing **it**' },
      { type: 'tool', id: 'r', tool: 'Read', summary: 'src/a.ts', status: 'done' },
      {
        type: 'permission',
        id: 'p',
        tool: 'Bash',
        summary: 'npm test',
        always: 'Yes, and don’t ask again for npm test commands in this folder',
      },
    );
    expect(transcript.getByText('it').tagName).toBe('STRONG');
    expect(transcript.getByRole('button', { name: 'Read src/a.ts' })).toBeTruthy();
    const prompt = within(transcript.getByRole('group', { name: 'Bash command: npm test' }));
    fireEvent.click(
      prompt.getByRole('button', {
        name: 'Yes, and don’t ask again for npm test commands in this folder',
      }),
    );
    await settle();
    expect(backend.answer).toHaveBeenCalledWith('a', 'p', { kind: 'permission', answer: 'always' });

    emit(
      {
        type: 'notice',
        id: 'n',
        level: 'error',
        text: 'You’ve hit your session limit · resets 3pm',
      },
      { type: 'usage', usage: { costUsd: 0.0234, contextTokens: 6000, contextWindow: 200_000 } },
      { type: 'end', messages: [id], seconds: 4, interrupted: false, failed: true },
    );
    expect(transcript.getByRole('alert').textContent).toBe(
      'You’ve hit your session limit · resets 3pm',
    );
    expect(transcript.getByText('Failed after 4s')).toBeTruthy();
    expect(view.getByText('$0.02 · 3% context')).toBeTruthy();
  });

  it('is interrupted from main with Escape', async () => {
    const { backend, composer, send, sent, emit, transcript } = await open({ connection: 'sdk' });
    await send('Go');
    fireEvent.keyDown(composer, { key: 'Escape' });
    await settle();
    expect(backend.interrupt).toHaveBeenCalledWith('a');
    emit({ type: 'end', messages: [sent()], seconds: 2, interrupted: true, failed: false });
    expect(transcript.getByText('Interrupted · 2s')).toBeTruthy();
  });

  it('asks the user questions with corrallm’s question cards, in its transcript and on the canvas', async () => {
    const { backend, view, send, emit, transcript } = await open({ connection: 'sdk' });
    await send('Go');
    emit({
      type: 'question',
      id: 'q',
      questions: [
        {
          header: 'Branch',
          text: 'Which branch?',
          options: [
            { label: 'main', description: 'The default branch' },
            { label: 'develop', description: 'Where work goes first' },
          ],
          multiple: false,
        },
      ],
    });
    const asked = within(transcript.getByRole('group', { name: 'Questions for you' }));
    expect(asked.getByText('Which branch?')).toBeTruthy();

    // Back on the canvas, the Needs you sidebar asks it too, and answers it.
    fireEvent.click(view.getByRole('button', { name: 'Back to the canvas' }));
    const sidebar = within(screen.getByRole('complementary', { name: 'Needs you' }));
    fireEvent.click(sidebar.getByRole('button', { name: 'develop' }));
    await settle();
    expect(backend.answer).toHaveBeenCalledWith('a', 'q', {
      kind: 'question',
      answers: ['develop'],
    });
    expect(screen.queryByRole('complementary', { name: 'Needs you' })).toBeNull();
  });

  it('asks for your OK above its composer, where what is sent goes to Claude Code as the changes', async () => {
    const { backend, view, composer, send, emit, sent } = await open({
      connection: 'sdk',
      queue: [
        { id: 'ok', approve: 'the spec in SPEC.md' },
        { id: 'next', action: 'Read' },
      ],
    });
    fireEvent.click(view.getByRole('button', { name: 'All queues' }));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    fireEvent.click(queues.getByRole('button', { name: 'Run' }));
    fireEvent.click(queues.getByRole('button', { name: 'Open a' }));
    const side = within(view.getByRole('complementary', { name: 'Questions and queue' }));
    const row = () =>
      side
        .getByRole('button', { name: 'Move Your OK on the spec in SPEC.md' })
        .closest<HTMLElement>('[data-run]');
    const bar = () => view.queryByRole('group', { name: 'Needs you' });
    expect(row()?.dataset.run).toBe('asking');
    expect(
      within(bar() ?? document.body).getByText(
        'Waits for your OK on the spec in SPEC.md: write below what should change, or',
      ),
    ).toBeTruthy();
    expect(composer.placeholder).toBe('What should change?');

    await send('Cover the empty state too');
    expect(backend.send).toHaveBeenCalledWith('a', {
      id: sent(),
      text: 'Cover the empty state too',
    });
    expect(row()?.dataset.run).toBe('running');
    expect(bar()).toBeNull();
    // The run waits for the turn the changes start: once main ends it, the OK asks again.
    emit(
      { type: 'user', id: sent(), text: 'Cover the empty state too' },
      { type: 'status', status: 'working' },
      { type: 'end', messages: [sent()], seconds: 4, interrupted: false, failed: false },
    );
    expect(row()?.dataset.run).toBe('asking');
    fireEvent.click(within(bar() ?? document.body).getByRole('button', { name: 'Approve' }));
    expect(row()?.dataset.run).toBe('succeeded');
    // The step after it is Claude Code's to do, in its session.
    await settle();
    expect(backend.send).toHaveBeenLastCalledWith('a', {
      id: sent(),
      text: 'Use the Read tool for this step (read files).',
    });
    expect(composer.placeholder).toBe('Queue a message for a…');
  });

  it('takes images pasted with the changes asked for, and runs a slash command typed then', async () => {
    const { backend, view, composer, send, emit, sent } = await open({
      connection: 'sdk',
      queue: [{ id: 'ok', approve: 'the layout' }],
    });
    emit({
      type: 'commands',
      commands: [{ name: 'compact', description: 'Summarize', argumentHint: '<instructions>' }],
    });
    fireEvent.click(view.getByRole('button', { name: 'All queues' }));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    fireEvent.click(queues.getByRole('button', { name: 'Run' }));
    fireEvent.click(queues.getByRole('button', { name: 'Open a' }));
    const side = within(view.getByRole('complementary', { name: 'Questions and queue' }));
    const row = () =>
      side
        .getByRole('button', { name: 'Move Your OK on the layout' })
        .closest<HTMLElement>('[data-run]');
    const bar = within(view.getByRole('group', { name: 'Needs you' }));
    expect(
      bar.getByText('A /command typed below runs as a command, not as your answer.'),
    ).toBeTruthy();

    // A slash command goes to Claude Code as a command: the OK still asks.
    await send('/compact keep the layout notes');
    expect(backend.send).toHaveBeenLastCalledWith('a', {
      id: sent(),
      text: '/compact keep the layout notes',
    });
    expect(row()?.dataset.run).toBe('asking');
    emit({ type: 'end', messages: [sent()], seconds: 2, interrupted: false, failed: false });

    // What is sent otherwise is the changes, with the images pasted into them.
    const png = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
    fireEvent.paste(composer, { clipboardData: { files: [png], getData: () => '' } });
    await view.findByRole('img', { name: 'Image 1' });
    await send('Match this');
    expect(backend.send).toHaveBeenLastCalledWith('a', {
      id: sent(),
      text: 'Match this',
      images: [{ mediaType: 'image/png', data: 'iVBORw==' }],
    });
    expect(row()?.dataset.run).toBe('running');
    expect(row()?.dataset.asked).toBe('Match this [Image]');
  });

  it('asks it, in its transcript, whether a condition in your words holds, and says when unclear', async () => {
    const { backend, view, emit, sent, transcript } = await open({
      connection: 'sdk',
      queue: [
        { id: 'flaky', if: { kind: 'freeText', text: 'a test is flaky' }, then: [] },
        { id: 'next', message: 'Carry on' },
      ],
    });
    fireEvent.click(view.getByRole('button', { name: 'All queues' }));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    fireEvent.click(queues.getByRole('button', { name: 'Run' }));
    fireEvent.click(queues.getByRole('button', { name: 'Open a' }));
    await settle();
    const question =
      'corrallm asks: is this true now? “a test is flaky” Start your answer with yes or no.';
    expect(backend.send).toHaveBeenLastCalledWith('a', { id: sent(), text: question });
    expect(transcript.getByText(question)).toBeTruthy();
    emit(
      { type: 'user', id: sent(), text: question },
      { type: 'text', id: 'm:0', text: 'Hard to say: one test timed out once.' },
      { type: 'end', messages: [sent()], seconds: 3, interrupted: false, failed: false },
    );
    expect(
      transcript.getByText('corrallm took that as no: the answer wasn’t a clear yes or no.'),
    ).toBeTruthy();
    // Taken as no: the queue goes on past the If.
    await settle();
    expect(backend.send).toHaveBeenLastCalledWith('a', { id: sent(), text: 'Carry on' });
  });

  it('lists what the run asks and what its session asks in the canvas’s Needs you sidebar', async () => {
    const { backend, view, emit } = await open({
      connection: 'sdk',
      queue: [
        { id: 'ask', message: 'Pick a branch' },
        { id: 'ok', approve: 'the branch' },
      ],
    });
    fireEvent.click(view.getByRole('button', { name: 'All queues' }));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    fireEvent.click(queues.getByRole('button', { name: 'Run' }));
    fireEvent.click(queues.getByRole('button', { name: 'Back' }));
    fireEvent.click(view.getByRole('button', { name: 'Back to the canvas' }));
    await settle();
    // The run's message is a turn of the real session, where Claude asks a question.
    const turn = backend.send.mock.calls.at(-1)?.[1].id ?? '';
    emit(
      { type: 'user', id: turn, text: 'Pick a branch' },
      { type: 'status', status: 'working' },
      {
        type: 'question',
        id: 'q',
        questions: [
          {
            header: 'Branch',
            text: 'Which branch?',
            options: [
              { label: 'main', description: 'The default branch' },
              { label: 'develop', description: 'Where work goes first' },
            ],
            multiple: false,
          },
        ],
      },
    );
    const sidebar = () => within(screen.getByRole('complementary', { name: 'Needs you' }));
    expect(sidebar().getByText('Which branch?')).toBeTruthy();
    fireEvent.click(sidebar().getByRole('button', { name: 'develop' }));
    await settle();
    expect(backend.answer).toHaveBeenCalledWith('a', 'q', {
      kind: 'question',
      answers: ['develop'],
    });

    // The turn ends: the run reaches the OK, which the sidebar asks, answered there.
    emit({ type: 'end', messages: [turn], seconds: 6, interrupted: false, failed: false });
    expect(sidebar().getByText('Your OK on the branch?')).toBeTruthy();
    expect(sidebar().getByText('1', { selector: '.graph-questions-count' })).toBeTruthy();
    fireEvent.change(sidebar().getByRole('textbox', { name: 'What should change?' }), {
      target: { value: 'Use main instead' },
    });
    fireEvent.click(sidebar().getByRole('button', { name: 'Ask for changes' }));
    await settle();
    expect(backend.send).toHaveBeenLastCalledWith('a', {
      id: expect.any(String) as unknown,
      text: 'Use main instead',
    });
    expect(screen.queryByRole('complementary', { name: 'Needs you' })).toBeNull();
  });

  it('asks to approve its plan, and to carry it out in a mode', async () => {
    const { backend, send, emit, transcript } = await open({ connection: 'sdk' });
    await send('Plan it');
    emit({ type: 'plan', id: 'plan', plan: '1. Read the code\n2. Change it' });
    const plan = within(transcript.getByRole('group', { name: 'Plan' }));
    expect(plan.getByText('Read the code')).toBeTruthy();
    fireEvent.click(plan.getByRole('button', { name: 'Yes, and auto-accept edits' }));
    await settle();
    expect(backend.answer).toHaveBeenCalledWith('a', 'plan', {
      kind: 'plan',
      answer: { approve: true, mode: 'acceptEdits' },
    });
    expect(plan.getByText('Approved: carrying it out in Accept edits')).toBeTruthy();
  });

  it('shows a subagent’s work under the call that started it', async () => {
    const { send, emit, transcript } = await open({ connection: 'sdk' });
    await send('Go');
    emit(
      { type: 'tool', id: 'agent-1', tool: 'Agent', summary: 'Find the bug', status: 'running' },
      { type: 'tool', id: 'g', tool: 'Grep', summary: 'TODO', status: 'done', parent: 'agent-1' },
    );
    const grep = transcript.getByRole('button', { name: 'Grep TODO' });
    expect(grep.closest('.agent-subagent')?.getAttribute('data-parent')).toBe('agent-1');
  });

  it('completes slash commands as they are typed, and runs one picked with Enter', async () => {
    const { backend, composer, view, emit, sent } = await open({ connection: 'sdk' });
    emit({
      type: 'commands',
      commands: [
        { name: 'clear', description: 'Start afresh', argumentHint: '' },
        {
          name: 'compact',
          description: 'Summarize the conversation',
          argumentHint: '<instructions>',
        },
        { name: 'context', description: 'Show context use', argumentHint: '' },
      ],
    });
    fireEvent.change(composer, { target: { value: '/co', selectionStart: 3 } });
    const menu = within(view.getByRole('listbox', { name: 'Commands' }));
    // Then Claude Code's own screens, which run in Terminal.
    expect(menu.getAllByRole('option').map((o) => o.textContent)).toEqual([
      '/compact<instructions> · Summarize the conversation',
      '/context' + 'Show context use',
      '/config' + 'In Terminal · Open settings',
    ]);
    // Tab puts the one picked in, ready for what it takes.
    fireEvent.keyDown(composer, { key: 'ArrowDown' });
    fireEvent.keyDown(composer, { key: 'Tab' });
    expect(composer.value).toBe('/context ');

    // Enter runs the one picked.
    fireEvent.change(composer, { target: { value: '/comp', selectionStart: 5 } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await settle();
    expect(backend.send).toHaveBeenCalledWith('a', { id: sent(), text: '/compact' });
    expect(view.queryByRole('listbox')).toBeNull();
  });

  it('completes @-mentions with the project folder’s files', async () => {
    const { backend, composer, view } = await open({ connection: 'sdk' });
    backend.files.mockResolvedValue(['src/main/', 'src/main/ipc.ts']);
    fireEvent.change(composer, { target: { value: 'look at @ma', selectionStart: 11 } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    expect(backend.files).toHaveBeenLastCalledWith('ma');
    const menu = within(view.getByRole('listbox', { name: 'Files' }));
    fireEvent.click(menu.getByRole('option', { name: 'src/main/ipc.ts' }));
    expect(composer.value).toBe('look at @src/main/ipc.ts ');
    // Esc closes the menu, not the view.
    fireEvent.change(composer, { target: { value: 'and @ma', selectionStart: 7 } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    fireEvent.keyDown(composer, { key: 'Escape' });
    expect(view.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'a' })).toBeTruthy();
  });

  it('sends images pasted into the message, and shows them with it', async () => {
    const { backend, composer, view, transcript, sent } = await open({ connection: 'sdk' });
    const png = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
    fireEvent.paste(composer, {
      clipboardData: { files: [png], getData: () => '' },
    });
    const pasted = await view.findByRole('img', { name: 'Image 1' });
    expect(pasted.closest('ul')?.getAttribute('aria-label')).toBe('Images');
    expect(pasted.getAttribute('src')).toBe('data:image/png;base64,iVBORw==');
    fireEvent.change(composer, { target: { value: 'What is this?' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await settle();
    expect(backend.send).toHaveBeenCalledWith('a', {
      id: sent(),
      text: 'What is this?',
      images: [{ mediaType: 'image/png', data: 'iVBORw==' }],
    });
    expect(transcript.getByRole('img', { name: 'Image 1' })).toBeTruthy();
    expect(view.queryByRole('list', { name: 'Images' })).toBeNull();
  });

  it('shows what a resumed session did before', async () => {
    const { emit, transcript } = await open({ connection: 'sdk' });
    emit({
      type: 'history',
      events: [
        { type: 'user', id: 'u1', text: 'Earlier question' },
        { type: 'text', id: 'm1:0', text: 'Earlier answer' },
        { type: 'end', messages: ['u1'], seconds: 3, interrupted: false, failed: false },
      ],
    });
    expect(transcript.getByText('Earlier question')).toBeTruthy();
    expect(transcript.getByText('Earlier answer')).toBeTruthy();
    expect(transcript.getByText('Worked for 3s')).toBeTruthy();
  });

  it('words a permission prompt as the CLI does', async () => {
    const { send, emit, transcript } = await open({ connection: 'sdk' });
    await send('Fetch it');
    emit({
      type: 'permission',
      id: 'p',
      tool: 'WebFetch',
      summary: 'https://example.com',
      always: null,
      title: 'Claude wants to fetch example.com',
    });
    const prompt = within(
      transcript.getByRole('group', {
        name: 'Claude wants to fetch example.com: https://example.com',
      }),
    );
    expect(prompt.getByText('Do you want to proceed?')).toBeTruthy();
    expect(prompt.getAllByRole('button').map((b) => b.textContent)).toEqual(['Yes', 'No']);
  });
});

describe('an Agent SDK agent continued in Terminal', () => {
  it('offers Terminal for a command only Claude Code’s terminal runs, and runs it there', async () => {
    const { backend, composer, view, emit, card } = await open({ connection: 'sdk' });
    emit({ type: 'started', model: 'opus', mode: 'manual', models: MODELS });
    fireEvent.change(composer, { target: { value: '/perm', selectionStart: 5 } });
    const menu = within(view.getByRole('listbox', { name: 'Commands' }));
    expect(menu.getByRole('option').textContent).toBe(
      '/permissions' + 'In Terminal · Manage allow and deny tool permission rules',
    );
    fireEvent.keyDown(composer, { key: 'Enter' });
    await settle();
    // Not sent to the Agent SDK session: Terminal is offered instead.
    expect(backend.send).not.toHaveBeenCalled();
    const offer = within(view.getByRole('group', { name: 'Continue in Terminal?' }));
    expect(offer.getByText(/^\/permissions opens a screen of Claude Code’s own/)).toBeTruthy();

    fireEvent.click(offer.getByRole('button', { name: 'Continue in Terminal' }));
    await settle();
    expect(view.getByRole('button', { name: /^Agent: / }).getAttribute('aria-label')).toBe(
      'Agent: Claude · Terminal',
    );
    expect(card().getAttribute('aria-label')).toBe('a, Claude · Terminal');
    expect(backend.start).toHaveBeenLastCalledWith(
      'a',
      expect.objectContaining({ connection: 'terminal' }),
    );
    expect(backend.send).toHaveBeenCalledExactlyOnceWith('a', {
      id: expect.any(String) as unknown,
      text: '/permissions',
    });
  });

  it('takes the offer back on Cancel, and keeps the view open on Escape', async () => {
    const { backend, send, view } = await open({ connection: 'sdk' });
    await send('/login');
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    expect(view.queryByRole('group', { name: 'Continue in Terminal?' })).toBeNull();
    await send('/hooks');
    fireEvent.keyDown(view.getByRole('button', { name: 'Continue in Terminal' }), {
      key: 'Escape',
    });
    expect(view.queryByRole('group', { name: 'Continue in Terminal?' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'a' })).toBeTruthy();
    expect(backend.send).not.toHaveBeenCalled();
  });

  it('continues the conversation in Terminal from its agent chip', async () => {
    const { backend, view } = await open({ connection: 'sdk' });
    fireEvent.click(view.getByRole('button', { name: /^Agent: / }));
    const first = view.getAllByRole('option')[0];
    expect(first?.textContent).toMatch(/^Continue in Terminal.*Claude Code’s own terminal/);
    if (!first) throw new Error('no options');
    fireEvent.click(first);
    await settle();
    expect(view.getByRole('button', { name: /^Agent: / }).getAttribute('aria-label')).toBe(
      'Agent: Claude · Terminal',
    );
    expect(backend.start).toHaveBeenLastCalledWith(
      'a',
      expect.objectContaining({ connection: 'terminal' }),
    );
    expect(backend.send).not.toHaveBeenCalled();
  });
});

describe('an Agent SDK agent’s /resume', () => {
  const HOUR = 3_600_000;

  it('lists the project folder’s other conversations, and opens the one picked in this agent', async () => {
    const now = Date.now();
    const { backend, send, view, transcript, emit, sent, composer } = await open(
      { connection: 'sdk' },
      (fake) => {
        fake.backend.sessions.mockResolvedValue([
          { id: 'own', title: 'This conversation', modified: now, current: true },
          {
            id: 'k2',
            title: 'Add a cart',
            modified: now - 2 * HOUR - 60_000,
            bytes: 24_000,
            branch: 'main',
            current: false,
          },
          {
            id: 'k1',
            title: 'Fix the login bug',
            modified: now - 3 * 24 * HOUR - 60_000,
            bytes: 1_200_000,
            current: false,
          },
        ]);
      },
    );
    await send('Hello');
    emit({ type: 'user', id: sent(), text: 'Hello' });
    await send('/resume');
    // Not sent: the view picks a conversation.
    expect(backend.send).toHaveBeenCalledOnce();
    expect(backend.sessions).toHaveBeenCalledWith('a');
    const picker = within(view.getByRole('listbox', { name: 'Resume a conversation' }));
    expect(picker.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Add a cart 2 hours ago · 24 KB · main',
      'Fix the login bug 3 days ago · 1.2 MB',
    ]);

    fireEvent.click(picker.getByRole('option', { name: /^Add a cart/ }));
    await settle();
    expect(backend.resume).toHaveBeenCalledWith('a', 'k2');
    expect(transcript.queryByText('Hello')).toBeNull();
    expect(backend.start).toHaveBeenCalledTimes(2);
    expect(view.queryByRole('listbox', { name: 'Resume a conversation' })).toBeNull();
    expect(document.activeElement).toBe(composer);
  });

  it('says when there is no other conversation, and why one could not be listed', async () => {
    const { backend, send, view } = await open({ connection: 'sdk' }, (fake) => {
      fake.backend.sessions.mockResolvedValueOnce([
        { id: 'own', title: 'This conversation', modified: 1, current: true },
      ]);
    });
    await send('/resume');
    expect(view.getByText('No other conversations in this project folder yet.')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Close' }));
    expect(view.queryByText(/No other conversations/)).toBeNull();

    backend.sessions.mockRejectedValueOnce(
      new Error("Error invoking remote method 'session:list': Error: Choose a project folder"),
    );
    await send('/resume');
    expect(view.getByRole('alert').textContent).toBe('Choose a project folder');
  });
});

describe('an Agent SDK agent’s MCP servers (/mcp)', () => {
  it('lists them, and reconnects, disables and enables them', async () => {
    const { backend, send, view } = await open({ connection: 'sdk' }, (fake) => {
      fake.backend.mcp.mockResolvedValue([
        {
          name: 'github',
          status: 'connected',
          scope: 'user',
          server: 'github-mcp 1.2.0',
          tools: 2,
        },
        { name: 'sentry', status: 'failed', scope: 'project', error: 'Connection refused' },
        { name: 'linear', status: 'needs-auth', scope: 'claude.ai' },
      ]);
      fake.backend.changeMcp.mockResolvedValue([
        { name: 'github', status: 'disabled', scope: 'user' },
        { name: 'sentry', status: 'connected', scope: 'project', tools: 1 },
        { name: 'linear', status: 'needs-auth', scope: 'claude.ai' },
      ]);
    });
    await send('/mcp');
    expect(backend.send).not.toHaveBeenCalled();
    expect(backend.mcp).toHaveBeenCalledWith('a');
    const panel = within(view.getByRole('group', { name: 'MCP servers' }));
    const row = (name: string) => within(panel.getByRole('listitem', { name }));
    expect(row('github').getByText('Connected · user · 2 tools')).toBeTruthy();
    expect(row('sentry').getByText('Failed: Connection refused · project')).toBeTruthy();
    expect(row('linear').getByText('Needs you to sign in · claude.ai')).toBeTruthy();

    fireEvent.click(row('sentry').getByRole('button', { name: 'Reconnect' }));
    await settle();
    expect(backend.changeMcp).toHaveBeenCalledWith('a', 'sentry', 'reconnect');
    expect(row('sentry').getByText('Connected · project · 1 tool')).toBeTruthy();
    expect(row('github').getByText('Disabled · user')).toBeTruthy();
    fireEvent.click(row('github').getByRole('button', { name: 'Enable' }));
    await settle();
    expect(backend.changeMcp).toHaveBeenLastCalledWith('a', 'github', 'enable');

    // Esc closes the panel, not the view, wherever the keyboard is (the button clicked is gone).
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(view.queryByRole('group', { name: 'MCP servers' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'a' })).toBeTruthy();
  });

  it('signs in to a server in Terminal, where Claude Code’s own /mcp does it', async () => {
    const { backend, send, view } = await open({ connection: 'sdk' }, (fake) => {
      fake.backend.mcp.mockResolvedValue([{ name: 'linear', status: 'needs-auth' }]);
    });
    await send('/mcp');
    fireEvent.click(view.getByRole('button', { name: 'Sign in in Terminal' }));
    await settle();
    expect(view.getByRole('button', { name: /^Agent: / }).getAttribute('aria-label')).toBe(
      'Agent: Claude · Terminal',
    );
    expect(backend.send).toHaveBeenCalledExactlyOnceWith('a', {
      id: expect.any(String) as unknown,
      text: '/mcp',
    });
  });

  it('says why they could not be listed', async () => {
    const { send, view } = await open({ connection: 'sdk' }, (fake) => {
      fake.backend.mcp.mockRejectedValue(
        new Error("Error invoking remote method 'session:mcp': Error: Not running."),
      );
    });
    await send('/mcp');
    expect(view.getByRole('alert').textContent).toBe('Not running.');
  });
});

describe('an MCP server asking the user (an elicitation)', () => {
  const asked = {
    type: 'elicitation',
    id: 'e1',
    server: 'github',
    message: 'Which repository should the issue go in?',
    fields: [
      { name: 'repo', label: 'Repository', required: true, kind: 'text' },
      { name: 'count', label: 'How many', required: false, kind: 'integer', min: 1 },
      { name: 'draft', label: 'Draft', required: false, kind: 'boolean' },
      {
        name: 'priority',
        label: 'Priority',
        required: false,
        kind: 'choice',
        options: [
          { value: 'p1', label: 'High' },
          { value: 'p2', label: 'Low' },
        ],
      },
      {
        name: 'labels',
        label: 'Labels',
        required: false,
        kind: 'choices',
        options: [
          { value: 'bug', label: 'Bug' },
          { value: 'ui', label: 'UI' },
        ],
      },
    ],
  } satisfies SessionEvent;

  it('shows its form in the transcript, and answers with what was filled in', async () => {
    const { backend, send, emit, sent, transcript } = await open({ connection: 'sdk' });
    await send('File an issue');
    emit({ type: 'user', id: sent(), text: 'File an issue' }, asked);
    const form = within(transcript.getByRole('form', { name: 'github asks' }));
    expect(form.getByText('Which repository should the issue go in?')).toBeTruthy();
    // It waits for what is required.
    const submit = form.getByRole('button', { name: 'Submit' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.change(form.getByRole('textbox', { name: 'Repository' }), {
      target: { value: 'acme/shop' },
    });
    fireEvent.change(form.getByRole('spinbutton', { name: 'How many' }), {
      target: { value: '2' },
    });
    fireEvent.click(form.getByRole('checkbox', { name: 'Draft' }));
    fireEvent.change(form.getByRole('combobox', { name: 'Priority' }), {
      target: { value: 'p2' },
    });
    fireEvent.click(form.getByRole('checkbox', { name: 'UI' }));
    fireEvent.click(submit);
    await settle();
    expect(backend.answer).toHaveBeenCalledWith('a', 'e1', {
      kind: 'elicitation',
      action: 'accept',
      values: { repo: 'acme/shop', count: 2, draft: true, priority: 'p2', labels: ['ui'] },
    });
    expect(
      transcript.getByText('Sent to github: Which repository should the issue go in?'),
    ).toBeTruthy();
  });

  it('declines, and opens a link a server asks to open through main', async () => {
    const { backend, send, emit, sent, transcript, openLink } = await open({ connection: 'sdk' });
    await send('File an issue');
    emit({ type: 'user', id: sent(), text: 'File an issue' }, asked);
    fireEvent.click(transcript.getByRole('button', { name: 'Decline' }));
    await settle();
    expect(backend.answer).toHaveBeenLastCalledWith('a', 'e1', {
      kind: 'elicitation',
      action: 'decline',
    });
    expect(transcript.getByText('Declined: Which repository should the issue go in?')).toBeTruthy();

    emit({
      type: 'elicitation',
      id: 'e2',
      server: 'linear',
      message: 'Sign in to Linear to go on',
      url: 'https://linear.app/oauth/authorize?state=1',
    });
    const link = within(transcript.getByRole('group', { name: 'linear asks' }));
    fireEvent.click(link.getByRole('button', { name: 'Open linear.app' }));
    await settle();
    expect(openLink).toHaveBeenCalledWith('https://linear.app/oauth/authorize?state=1');
    expect(backend.answer).toHaveBeenLastCalledWith('a', 'e2', {
      kind: 'elicitation',
      action: 'accept',
    });
  });
});

describe('an Agent SDK agent rewound', () => {
  /** Agent a, through the Agent SDK, after two turns: "Fix the login bug", then "Now the cart". */
  async function talked(prepare?: (fake: ReturnType<typeof fakeBackend>) => void) {
    const opened = await open({ connection: 'sdk' }, prepare);
    const { send, emit, sent } = opened;
    const ids: string[] = [];
    for (const text of ['Fix the login bug', 'Now the cart']) {
      await send(text);
      const id = sent();
      ids.push(id);
      emit(
        { type: 'user', id, text },
        { type: 'text', id: `${id}:0`, text: `Done: ${text}` },
        { type: 'end', messages: [id], seconds: 2, interrupted: false, failed: false },
      );
    }
    return { ...opened, ids };
  }

  it('rewinds code and conversation to before a message, its text back in the box', async () => {
    const { backend, view, transcript, composer, ids } = await talked((fake) => {
      fake.backend.previewRewind.mockResolvedValue({
        possible: true,
        files: ['src/cart.ts'],
        added: 4,
        removed: 10,
      });
      fake.backend.rewind.mockResolvedValue({
        files: { possible: true, files: ['src/cart.ts'], added: 4, removed: 10 },
        conversation: true,
      });
    });
    const rewinds = transcript.getAllByRole('button', { name: 'Rewind to here' });
    expect(rewinds).toHaveLength(2);
    fireEvent.click(rewinds[1] ?? document.body);
    await settle();
    expect(backend.previewRewind).toHaveBeenCalledWith('a', ids[1]);
    const panel = within(view.getByRole('group', { name: 'Rewind' }));
    expect(panel.getByText('Rewind to before “Now the cart”?')).toBeTruthy();
    expect(panel.getByText('Restores src/cart.ts (+4 −10).')).toBeTruthy();
    expect(
      panel.getByText(
        'Drops this message and what followed: it goes back in the box below, to edit.',
      ),
    ).toBeTruthy();
    expect(panel.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Restore code and conversation',
      'Restore conversation',
      'Restore code',
      'Cancel',
    ]);

    fireEvent.click(panel.getByRole('button', { name: 'Restore code and conversation' }));
    await settle();
    expect(backend.rewind).toHaveBeenCalledWith('a', ids[1], 'both');
    expect(view.queryByRole('group', { name: 'Rewind' })).toBeNull();
    expect(transcript.queryByText('Fix the login bug')).toBeNull();
    expect(backend.start).toHaveBeenCalledTimes(2);
    const box = view.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message a' });
    expect(box.value).toBe('Now the cart');
    expect(composer).not.toBe(box);
  });

  it('offers the conversation alone where no files changed, or they can’t be restored', async () => {
    const { backend, view, transcript, ids } = await talked((fake) => {
      fake.backend.previewRewind.mockResolvedValueOnce({
        possible: true,
        files: [],
        added: 0,
        removed: 0,
      });
      fake.backend.previewRewind.mockResolvedValueOnce({
        possible: false,
        error: 'No file checkpoint found for this message',
        files: [],
        added: 0,
        removed: 0,
      });
    });
    fireEvent.click(
      transcript.getAllByRole('button', { name: 'Rewind to here' })[0] ?? document.body,
    );
    await settle();
    let panel = within(view.getByRole('group', { name: 'Rewind' }));
    expect(panel.getByText('No files changed since then.')).toBeTruthy();
    expect(
      panel.getByText(
        'Drops this message and the 1 after it: it goes back in the box below, to edit.',
      ),
    ).toBeTruthy();
    expect(panel.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Restore conversation',
      'Cancel',
    ]);
    fireEvent.click(panel.getByRole('button', { name: 'Cancel' }));
    expect(view.queryByRole('group', { name: 'Rewind' })).toBeNull();

    fireEvent.click(
      transcript.getAllByRole('button', { name: 'Rewind to here' })[1] ?? document.body,
    );
    await settle();
    panel = within(view.getByRole('group', { name: 'Rewind' }));
    expect(
      panel.getByText('Its files can’t be restored: No file checkpoint found for this message.'),
    ).toBeTruthy();
    fireEvent.click(panel.getByRole('button', { name: 'Restore conversation' }));
    await settle();
    expect(backend.rewind).toHaveBeenCalledWith('a', ids[1], 'conversation');
  });

  it('asks which message on Esc twice in an empty composer, or /rewind; one Esc still closes', async () => {
    const { view, composer, send } = await talked();
    fireEvent.keyDown(composer, { key: 'Escape' });
    fireEvent.keyDown(composer, { key: 'Escape' });
    const picker = within(view.getByRole('listbox', { name: 'Rewind to' }));
    expect(picker.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Now the cart',
      'Fix the login bug',
    ]);
    fireEvent.click(picker.getByRole('option', { name: 'Fix the login bug' }));
    await settle();
    expect(view.getByText('Rewind to before “Fix the login bug”?')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }));

    await send('/rewind');
    expect(view.getByRole('listbox', { name: 'Rewind to' })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(view.queryByRole('listbox', { name: 'Rewind to' })).toBeNull();

    // Once, it goes on to close the view, a moment later.
    const box = view.getByRole('textbox', { name: 'Message a' });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'a' })).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    expect(screen.queryByRole('dialog', { name: 'a' })).toBeNull();
  });
});
