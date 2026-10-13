import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { SessionEvent } from '../../shared/session';
import { GraphEditor } from '../graph/GraphEditor';
import type { Graph, GraphNode } from '../graph/graph';
import { fakeBackend } from '../test-backend';

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

/** The editor, with agent `a` (as `data` says) opened in its view, and main faked. */
async function open(data: Partial<GraphNode['data']> = {}) {
  const fake = fakeBackend();
  const graph: Graph = { nodes: [agent('a', data)], edges: [] };
  const { container } = render(<GraphEditor initialGraph={graph} sessionBackend={fake.backend} />);
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
  /** Main says `events` happened in a's session (connected as `data` says, or through the SDK). */
  const emit = (...events: SessionEvent[]) => {
    act(() => {
      fake.emit('a', data.connection ?? 'sdk', ...events);
    });
  };
  return { ...fake, container, card, view, composer, send, transcript, emit };
}

const MODELS = [
  { value: 'opus', label: 'Opus', description: 'The most capable' },
  { value: 'haiku', label: 'Haiku', description: 'The fastest' },
];

describe('a connected Codex agent', () => {
  it('runs in a terminal or through its app server, as its chip says', async () => {
    const { backend, card, view } = await open({ agent: 'Codex' });
    const chip = () => view.getByRole('button', { name: /^Agent: / });
    expect(chip().getAttribute('aria-label')).toBe('Agent: Codex · Simulated');
    fireEvent.click(chip());
    expect(view.getByRole('option', { name: /^Codex · Terminal/ }).textContent).toMatch(
      /Codex itself, in a terminal/,
    );
    fireEvent.click(view.getByRole('option', { name: /^Codex · App Server/ }));
    expect(card().getAttribute('aria-label')).toBe('a, Codex · App Server');
    await settle();
    // In Codex's default mode.
    expect(backend.start).toHaveBeenCalledWith('a', {
      connection: 'app-server',
      model: null,
      mode: 'auto',
    });
  });

  it('switches between Codex’s modes, and shows its plan’s usage limits', async () => {
    const { backend, view, composer, emit } = await open({
      agent: 'Codex',
      connection: 'app-server',
    });
    emit({ type: 'started', model: null, mode: 'auto', models: [] });
    const mode = () => view.getByRole('button', { name: /^Mode: / });
    expect(mode().getAttribute('aria-label')).toBe('Mode: Default');
    fireEvent.click(mode());
    const menu = within(view.getByRole('menu', { name: 'Mode' }));
    expect(menu.getAllByRole('menuitemradio').map((item) => item.firstChild?.textContent)).toEqual([
      'Read only',
      'Default',
      'Full access',
      'Plan',
    ]);
    fireEvent.click(menu.getByRole('menuitemradio', { name: /^Read only/ }));
    await settle();
    expect(backend.setMode).toHaveBeenLastCalledWith('a', 'read-only');
    // Shift+Tab goes on to the next.
    fireEvent.keyDown(composer, { key: 'Tab', shiftKey: true });
    await settle();
    expect(backend.setMode).toHaveBeenLastCalledWith('a', 'auto');

    const resets = new Date(2026, 9, 12, 15, 4).getTime();
    emit({
      type: 'usage',
      usage: {
        costUsd: null,
        contextTokens: 10_000,
        contextWindow: 200_000,
        limits: [
          { name: '5h', usedPercent: 12, resetsAt: resets },
          { name: 'weekly', usedPercent: 3, resetsAt: null },
        ],
      },
    });
    const usage = view.getByText('5% context · 5h 12% · weekly 3%');
    expect(usage.getAttribute('title')).toMatch(/12% of your 5h limit used; it resets .*3:04/);
  });

  it('asks to implement its plan, as Codex does, carried out in its Default mode', async () => {
    const { backend, send, sent, emit, transcript } = await open({
      agent: 'Codex',
      connection: 'app-server',
    });
    await send('Plan the change');
    emit(
      { type: 'user', id: sent(), text: 'Plan the change' },
      { type: 'plan', id: 'p', plan: '1. Read it\n2. Change it' },
    );
    const plan = within(transcript.getByRole('group', { name: 'Plan' }));
    // As Codex's TUI shows it: the proposed plan, then whether to implement it.
    expect(plan.getByText('Proposed plan')).toBeTruthy();
    expect(plan.getByText('Implement this plan?')).toBeTruthy();
    expect(plan.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Yes, implement this plan',
      'Keep planning',
    ]);
    expect(plan.getByRole('textbox', { name: 'What to change' }).getAttribute('placeholder')).toBe(
      'No, keep planning: tell Codex what to change',
    );
    fireEvent.click(plan.getByRole('button', { name: 'Yes, implement this plan' }));
    await settle();
    expect(backend.answer).toHaveBeenCalledWith('a', 'p', {
      kind: 'plan',
      answer: { approve: true, mode: 'auto' },
    });
    expect(plan.getByText('Approved: carrying it out in Default')).toBeTruthy();
  });
});

const CODEX_MODELS = [
  {
    value: 'gpt-6.1-sol',
    label: 'GPT-6.1-Sol',
    efforts: [
      { value: 'low', label: 'Low', description: 'Fast responses' },
      { value: 'xhigh', label: 'Extra high', description: 'Deepest' },
    ],
    defaultEffort: 'low',
  },
  { value: 'gpt-6-luna', label: 'GPT-6-Luna' },
];

describe('a Codex agent’s reasoning', () => {
  it('shows its summary as Codex writes it: Markdown, a bold title first', async () => {
    const { send, sent, emit, transcript } = await open({
      agent: 'Codex',
      connection: 'app-server',
    });
    await send('Why?');
    emit(
      { type: 'user', id: sent(), text: 'Why?' },
      { type: 'thinking', id: 'rs_1', text: '**Reading the code**\n\nThe bug is in `start`.' },
    );
    const thinking = transcript.getByText(/^Thought for/).closest('details');
    if (!thinking) throw new Error('no thinking shown');
    expect(within(thinking).getByText('Reading the code').tagName).toBe('STRONG');
    expect(within(thinking).getByText('start').tagName).toBe('CODE');
  });
});

describe('a Codex agent’s reasoning effort', () => {
  it('is chosen beside its model, from the efforts the model offers', async () => {
    const { backend, view, emit, send, sent } = await open({
      agent: 'Codex',
      connection: 'app-server',
    });
    expect(view.queryByRole('button', { name: /^Effort: / })).toBeNull();
    emit({
      type: 'started',
      model: 'gpt-6.1-sol',
      mode: 'auto',
      models: CODEX_MODELS,
      effort: null,
    });
    // The model's default, until one is chosen.
    const effort = () => view.getByRole('button', { name: /^Effort: / });
    expect(effort().getAttribute('aria-label')).toBe('Effort: Low');
    fireEvent.click(effort());
    const menu = within(view.getByRole('menu', { name: 'Effort' }));
    expect(menu.getAllByRole('menuitemradio').map((item) => item.firstChild?.textContent)).toEqual([
      'Low',
      'Extra high',
    ]);
    fireEvent.click(menu.getByRole('menuitemradio', { name: /^Extra high/ }));
    await settle();
    expect(backend.setEffort).toHaveBeenCalledWith('a', 'xhigh');
    expect(effort().getAttribute('aria-label')).toBe('Effort: Extra high');

    // Main says it changed (a model without that effort): shown so.
    emit({ type: 'effort', effort: 'low' });
    expect(effort().getAttribute('aria-label')).toBe('Effort: Low');
    // A model with no efforts to choose has no picker.
    emit({ type: 'model', model: 'gpt-6-luna' });
    expect(view.queryByRole('button', { name: /^Effort: / })).toBeNull();

    // Started again (after it stopped), it starts at the effort chosen.
    emit(
      { type: 'model', model: 'gpt-6.1-sol' },
      { type: 'effort', effort: 'xhigh' },
      { type: 'closed' },
    );
    await send('Again');
    expect(backend.start).toHaveBeenLastCalledWith('a', {
      connection: 'app-server',
      model: 'gpt-6.1-sol',
      mode: 'auto',
      effort: 'xhigh',
    });
    expect(sent()).toBeTruthy();
  });
});

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
      mode: 'manual',
    });

    fireEvent.click(view.getByRole('button', { name: 'All queues' }));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    expect(queues.getByText('SDK').getAttribute('title')).toMatch(/Agent SDK/);
    fireEvent.click(queues.getByRole('button', { name: 'Open a' }));

    // Another type of agent, simulated: the session closes.
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole('option', { name: /^Codex · Simulated/ }));
    expect(card().getAttribute('aria-label')).toBe('a, Codex');
    expect(backend.close).toHaveBeenCalledWith('a');
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
    expect(composer.placeholder).toBe('Message a…');
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
    expect(menu.getAllByRole('option').map((o) => o.textContent)).toEqual([
      '/compact<instructions> · Summarize the conversation',
      '/context' + 'Show context use',
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
