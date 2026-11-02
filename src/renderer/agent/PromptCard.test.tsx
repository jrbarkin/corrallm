import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { newCanvasId } from '../../shared/canvas';
import { Prompt, PromptId } from '../../shared/model/prompts';
import { promptEntryFor } from '../../shared/model/prompt-views';
import type { LiveOutcome } from '../../shared/model/prompt-views';
import type { EntryView } from '../../shared/model/views';
import type { ToolDetail } from '../../shared/session';
import { fakeCore, expectOneOp } from '../test-api';
import { events } from '../test-render';
import { PromptCard } from './PromptCard';

const canvas = newCanvasId();
const id = PromptId.parse('10000000-0000-4000-8000-000000000001');
const need = `prompt/a/1/${id}`;
function entry(fields: object): Extract<EntryView, { kind: 'prompt' }> {
  return promptEntryFor(
    {
      id,
      kind: 'prompt',
      need,
      name: 'Worker',
      prompt: Prompt.parse(
        Object.fromEntries(
          Object.entries({
            id,
            agent: 'a',
            raised: 1,
            title: '<script>Agent words</script>',
            answerIn: 'api',
            kind: 'approval',
            choices: [
              { value: 'allow', label: 'Allow once', hint: 'allow_once', effects: {} },
              {
                value: 'deny',
                label: 'Do something else',
                hint: 'reject_once',
                effects: {},
                feedback: 'required',
              },
            ],
            ...fields,
          } as Record<string, unknown>).filter(([, value]) => value !== undefined),
        ),
      ),
    },
    'you',
  );
}
function setup(fields: object = {}) {
  const core = fakeCore();
  core.respond('reply', { outcome: 'answered' });
  const opened = entry(fields);
  render(
    <PromptCard
      entry={opened}
      onReply={(answer) => core.api.reply({ canvas, to: need, answer })}
      onOpenTerminal={vi.fn()}
      openLink={(url) => core.api.linkOpen({ url })}
    />,
  );
  return core;
}

it('sends a choice with required feedback as one reply, without one-key approval', async () => {
  const core = setup();
  fireEvent.keyDown(document, { key: '1' });
  fireEvent.keyDown(screen.getByRole('group', { name: '<script>Agent words</script>' }), {
    key: 'Enter',
  });
  expect(core.operations).toEqual([]);
  expect(document.querySelector('script')).toBeNull();
  await events.click(screen.getByRole('button', { name: 'Do something else' }));
  await events.change(screen.getByRole('textbox', { name: 'Feedback' }), {
    target: { value: 'Use the smaller change' },
  });
  await events.click(screen.getByRole('button', { name: 'Send feedback' }));
  expectOneOp(core, 'reply', {
    canvas,
    to: need,
    answer: { choice: 'deny', feedback: 'Use the smaller change' },
  });
  core.dispose();
});

it('answers every question together with picks or exclusive text and keeps secret text in a password field', async () => {
  const core = setup({
    kind: 'question',
    choices: undefined,
    questions: [
      {
        id: 'color',
        header: 'Color',
        text: 'Choose colors',
        multiple: true,
        other: true,
        options: [{ label: 'Red', preview: 'red preview' }, { label: 'Blue' }],
      },
      {
        id: 'code',
        header: 'Code',
        text: 'Secret code',
        multiple: false,
        other: true,
        secret: true,
        options: [],
      },
    ],
  });
  await events.click(screen.getByRole('checkbox', { name: 'Red' }));
  await events.click(screen.getByRole('checkbox', { name: 'Blue' }));
  const secret = screen.getByLabelText<HTMLInputElement>('Secret code');
  expect(secret.type).toBe('password');
  await events.change(secret, { target: { value: 'private-answer' } });
  await events.click(screen.getByRole('button', { name: 'Send answers' }));
  expectOneOp(core, 'reply', {
    canvas,
    to: need,
    answer: { answers: { color: { picked: ['Red', 'Blue'] }, code: { text: 'private-answer' } } },
  });
  core.dispose();
});

it('sends typed question text without retaining a previous pick', async () => {
  const core = setup({
    kind: 'question',
    choices: undefined,
    questions: [
      {
        id: 'q',
        header: 'Q',
        text: 'Pick one',
        multiple: false,
        other: true,
        options: [{ label: 'A' }],
      },
    ],
  });
  await events.click(screen.getByRole('radio', { name: 'A' }));
  await events.change(screen.getByRole('textbox', { name: 'Pick one' }), {
    target: { value: 'Another answer' },
  });
  await events.click(screen.getByRole('button', { name: 'Send answers' }));
  expectOneOp(core, 'reply', {
    canvas,
    to: need,
    answer: { answers: { q: { text: 'Another answer' } } },
  });
  core.dispose();
});

it('answers question ids as own keys even when they name object properties', async () => {
  const ids = ['__proto__', 'constructor', 'toString'];
  const core = setup({
    kind: 'question',
    choices: undefined,
    questions: ids.map((id) => ({
      id,
      header: '',
      text: `Question ${id}`,
      multiple: false,
      other: false,
      options: [{ label: `Pick ${id}` }],
    })),
  });
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send answers' }).disabled).toBe(
    true,
  );
  for (const id of ids) await events.click(screen.getByRole('radio', { name: `Pick ${id}` }));
  await events.click(screen.getByRole('button', { name: 'Send answers' }));
  expectOneOp(core, 'reply', {
    canvas,
    to: need,
    answer: { answers: Object.fromEntries(ids.map((id) => [id, { picked: [`Pick ${id}`] }])) },
  });
  core.dispose();
});

it('keeps question drafts independent when the same prompt is open in two views', async () => {
  const opened = entry({
    kind: 'question',
    choices: undefined,
    questions: [
      {
        id: 'q',
        header: '',
        text: 'Pick one',
        multiple: false,
        other: false,
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ],
  });
  render(
    <>
      <PromptCard entry={opened} onReply={vi.fn()} />
      <PromptCard entry={opened} onReply={vi.fn()} />
    </>,
  );
  const [firstView, secondView] = screen.getAllByRole('group', { name: opened.prompt.title });
  if (!firstView || !secondView) throw new Error('Both prompt views must be open');
  const first = within(firstView).getByRole<HTMLInputElement>('radio', {
    name: 'A',
  });
  const second = within(secondView).getByRole<HTMLInputElement>('radio', {
    name: 'B',
  });
  await events.click(first);
  await events.click(second);
  expect(first.checked).toBe(true);
  expect(second.checked).toBe(true);
});

it('navigates to a terminal without sending an answer', async () => {
  const core = fakeCore();
  const open = vi.fn();
  render(
    <PromptCard
      entry={entry({ answerIn: 'terminal', choices: [] })}
      onReply={(answer) => core.api.reply({ canvas, to: need, answer })}
      onOpenTerminal={open}
    />,
  );
  await events.click(screen.getByRole('button', { name: 'Open terminal' }));
  expect(open).toHaveBeenCalledOnce();
  expect(core.operations).toEqual([]);
  core.dispose();
});

it('validates normalized form fields and sends typed values in one reply, with no Enter submission', async () => {
  const core = setup({
    kind: 'form',
    choices: undefined,
    server: 'tracker',
    form: {
      schema: {
        type: 'object',
        properties: { count: { type: 'integer', title: 'Count', minimum: 1, maximum: 5 } },
        required: ['count'],
        additionalProperties: false,
      },
    },
  });
  const input = screen.getByRole('spinbutton', { name: 'Count' });
  await events.change(input, { target: { value: '3' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(core.operations).toEqual([]);
  await events.click(screen.getByRole('button', { name: 'Submit' }));
  expectOneOp(core, 'reply', {
    canvas,
    to: need,
    answer: { form: { action: 'accept', values: { count: 3 } } },
  });
  core.dispose();
});

it('opens a URL separately from telling the server to continue', async () => {
  const url = 'https://signin.example.test/secret';
  const core = setup({ kind: 'form', choices: undefined, server: 'tracker', form: { url } });
  await events.click(screen.getByRole('button', { name: 'Open signin.example.test' }));
  expectOneOp(core, 'link.open', { url });
  core.operations.length = 0;
  await events.click(screen.getByRole('button', { name: 'Tell tracker to go on' }));
  expectOneOp(core, 'reply', { canvas, to: need, answer: { form: { action: 'accept' } } });
  core.dispose();
});

it('offers only the core’s Not waiting choice and terminal navigation for a terminal wait', async () => {
  const core = setup({ answerIn: 'terminal', choices: [] });
  await events.click(screen.getByRole('button', { name: 'Not waiting' }));
  expectOneOp(core, 'reply', { canvas, to: need, answer: { choice: 'not-waiting' } });
  core.dispose();
});

it('requires Show all before allowing a long command and labels admitted cuts', async () => {
  const core = setup({
    subject: {
      type: 'command',
      command: Array.from({ length: 20 }, (_, n) => `echo line ${String(n)}`).join('\n'),
      cwd: '/work',
    },
    cut: true,
  });
  const allow = screen.getByRole<HTMLButtonElement>('button', { name: 'Allow once' });
  expect(allow.disabled).toBe(true);
  await events.click(screen.getByRole('button', { name: 'Show all' }));
  expect(allow.disabled).toBe(false);
  expect(screen.getByText(/CLI has the whole/)).toBeTruthy();
  await events.click(allow);
  expectOneOp(core, 'reply', { canvas, to: need, answer: { choice: 'allow' } });
  core.dispose();
});

it.each<{ detail: ToolDetail; shown: string }>([
  {
    detail: { kind: 'output', text: '<script>terminal rows</script>' },
    shown: '<script>terminal rows</script>',
  },
  {
    detail: {
      kind: 'diff',
      added: 1,
      removed: 1,
      lines: [
        { kind: 'remove', text: 'before' },
        { kind: 'add', text: 'after' },
      ],
    },
    shown: '- before\n+ after',
  },
])(
  'renders admitted output and patch detail as escaped text: $detail.kind',
  ({ detail, shown }) => {
    const core = setup({ detail });
    expect(
      screen.getByText(
        (_text, element) => element?.tagName === 'PRE' && element.textContent === shown,
      ),
    ).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
    core.dispose();
  },
);

it('keeps drafts after a refused reply and renders a settled prompt without answer controls', async () => {
  const core = fakeCore();
  core.reply('reply', {
    ok: false,
    error: { code: 'conflict', sentence: 'Already answered elsewhere.' },
  });
  const opened = entry({});
  const view = render(
    <PromptCard
      entry={opened}
      onReply={(answer) => core.api.reply({ canvas, to: need, answer })}
    />,
  );
  await events.click(screen.getByRole('button', { name: 'Do something else' }));
  await events.change(screen.getByRole('textbox', { name: 'Feedback' }), {
    target: { value: 'Keep this draft' },
  });
  await events.click(screen.getByRole('button', { name: 'Send feedback' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'Already answered elsewhere.',
  );
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Feedback' }).value).toBe(
    'Keep this draft',
  );
  view.rerender(
    <PromptCard
      entry={{
        id,
        kind: 'prompt',
        need,
        prompt: { id, agent: 'a', raised: 1, kind: 'approval', title: 'Ended', answerIn: 'api' },
        outcome: { type: 'withdrawn' },
      }}
      onReply={vi.fn()}
    />,
  );
  await waitFor(() => {
    expect(screen.queryByRole('button')).toBeNull();
  });
  core.dispose();
});

it.each<{ outcome: LiveOutcome; words: string }>([
  {
    outcome: { type: 'choice', hint: 'allow_once', value: 'native-value', by: 'you' },
    words: 'Allowed once by you.',
  },
  { outcome: { type: 'choice', hint: 'allow_always', by: 'you' }, words: 'Always allowed by you.' },
  { outcome: { type: 'choice', hint: 'reject_once', by: 'you' }, words: 'Declined by you.' },
  {
    outcome: { type: 'choice', hint: 'reject_always', by: 'you' },
    words: 'Always declined by you.',
  },
  { outcome: { type: 'answers', secret: true, by: 'you' }, words: 'Answered (secret) by you.' },
  { outcome: { type: 'form', action: 'decline', by: 'you' }, words: 'Declined by you.' },
  { outcome: { type: 'form', action: 'cancel', by: 'you' }, words: 'Cancelled by you.' },
])(
  'shows the settled outcome and its decider without native values: $words',
  ({ outcome, words }) => {
    render(<PromptCard entry={{ ...entry({}), outcome }} onReply={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toBe(words);
    expect(screen.getByText('Request from the agent or its MCP server')).toBeTruthy();
    expect(screen.queryByText('native-value')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  },
);

it.each(['decline', 'cancel'] as const)(
  'sends form %s without any draft values',
  async (action) => {
    const core = setup({
      kind: 'form',
      choices: undefined,
      form: {
        schema: {
          type: 'object',
          properties: { name: { type: 'string', title: 'Name', default: 'Draft' } },
          required: [],
          additionalProperties: false,
        },
      },
    });
    await events.click(
      screen.getByRole('button', { name: action === 'decline' ? 'Decline' : 'Cancel' }),
    );
    expectOneOp(core, 'reply', { canvas, to: need, answer: { form: { action } } });
    core.dispose();
  },
);
it('keeps a refused URL open separate from Continue', async () => {
  const core = setup({
    kind: 'form',
    choices: undefined,
    form: { url: 'https://signin.example.test/x' },
  });
  core.reply('link.open', {
    ok: false,
    error: { code: 'refused', sentence: 'Opening was declined.' },
  });
  await events.click(screen.getByRole('button', { name: 'Open signin.example.test' }));
  expectOneOp(core, 'link.open', { url: 'https://signin.example.test/x' });
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Opening was declined.');
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Tell the server to go on' }).disabled,
  ).toBe(false);
  core.dispose();
});
it('holds an allow choice until the admitted plan is shown in full', async () => {
  const core = setup({
    kind: 'plan',
    plan: Array.from({ length: 20 }, (_, n) => `Step ${String(n)}`).join('\n'),
  });
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Allow once' }).disabled).toBe(true);
  await events.click(screen.getByRole('button', { name: 'Show all' }));
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Allow once' }).disabled).toBe(
    false,
  );
  core.dispose();
});

it('keeps field values within the normalized form bounds before sending', async () => {
  const core = setup({
    kind: 'form',
    choices: undefined,
    form: {
      schema: {
        type: 'object',
        properties: { count: { type: 'integer', title: 'Count', minimum: 1, maximum: 5 } },
        required: ['count'],
        additionalProperties: false,
      },
    },
  });
  await events.change(screen.getByRole('spinbutton', { name: 'Count' }), {
    target: { value: '6' },
  });
  await events.click(screen.getByRole('button', { name: 'Submit' }));
  expect(core.operations).toEqual([]);
  expect(screen.getByRole('alert')).toBeTruthy();
  core.dispose();
});
it('labels a server-supplied tool request as the server’s and never focuses an allow choice automatically', () => {
  const core = setup({
    subject: { type: 'mcpTool', server: 'tracker', tool: 'edit', input: { path: '/work/a' } },
  });
  expect(screen.getByText('MCP server’s request')).toBeTruthy();
  expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Allow once' }));
  core.dispose();
});
