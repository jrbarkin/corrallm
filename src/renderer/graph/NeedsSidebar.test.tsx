import { testPromptEntry } from '../../shared/test-prompts';
import { promptNeed } from '../../shared/model/prompt-views';
import { cleanup, render, screen, waitFor, act, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { NeedsItem } from '../../shared/model/needs';
import type { CanvasNode } from '../../shared/model/canvas';
import { newCanvasId } from '../../shared/canvas';
import { AgentId } from '../../shared/api/ids';
import { NEW_SESSION } from '../../shared/model/session';
import { sessionView } from '../../shared/model/views';
import { fakeCore, expectOneOp } from '../test-api';
import { events } from '../test-render';
import { NeedsSidebar } from './NeedsSidebar';
import css from './GraphEditor.css?raw';
const cores: ReturnType<typeof fakeCore>[] = [];
const detailStyle = document.createElement('style');
afterEach(() => {
  detailStyle.remove();
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

it.each([
  ['setup/tree/1', 'worktree', 'Run', 'run'],
  ['setup/tree/1', 'worktree', 'Skip', 'skip'],
  ['setup/tree/1', 'worktree', 'Always for this repository', 'always'],
  ['setup/tree/1', 'worktree', 'Stop', 'stop'],
  ['setup/tree/1', 'worktree', 'Run again', 'retry'],
  ['rebind/group%2Fteam/2', 'worktree', 'Switch, keeping the previous worktrees', 'switch'],
  ['proposal/cleanup', 'proposal', 'Delete, keep its work', 'allow'],
  ['proposal/cleanup', 'proposal', 'Delete, and discard its worktree and branch', 'discard'],
] as const)(
  'answers workspace choice %s %s %s with exactly one reply',
  async (id, kind, label, value) => {
    const item: NeedsItem = {
      ...proposal,
      id,
      kind,
      title: 'Workspace decision',
      detail: 'Current: corral/old\nDestination: Review team\nOutput: <script>untrusted</script>',
      choices: [{ label, value }],
    };
    const core = await setup([item]);
    const card = screen.getByRole('article', { name: item.title });
    expect(card.querySelector('script')).toBeNull();
    expect(card.textContent).toContain('<script>untrusted</script>');
    if (id.startsWith('rebind/')) expect(within(card).getByText('Workspace change')).toBeTruthy();
    await events.click(within(card).getByRole('button', { name: label }));
    expectOneOp(core, 'reply', { canvas, to: id, answer: { choice: value } });
  },
);

it('preserves the exact command’s spaces and the setup preview’s separate lines', async () => {
  const detail = `Runs: printf 'a  b'\nIn: /a project/checkout`;
  const rule = /\n\.graph-question-detail \{([^}]+)\}/.exec(css)?.[1] ?? '';
  detailStyle.textContent = `.graph-question-detail { ${rule} }`;
  document.head.append(detailStyle);
  await setup([{ ...proposal, kind: 'worktree', detail }]);
  const preview = screen.getByText((_, node) => node?.textContent === detail);
  expect(preview.textContent).toBe(detail);
  expect(getComputedStyle(preview).whiteSpace).toBe('pre-wrap');
});

it('keeps a setup’s live Stop and Retry choices after its Run reply returns started', async () => {
  const item: NeedsItem = {
    ...proposal,
    id: 'setup/11111111-1111-4111-8111-111111111111/1',
    kind: 'worktree',
    title: 'Set up Builder’s worktree?',
    choices: [
      { value: 'run', label: 'Run' },
      { value: 'skip', label: 'Skip' },
    ],
  };
  const core = await setup([item]);
  core.reply('reply', () => {
    core.change({
      topic: `needs:${canvas}`,
      rev: 1,
      replace: {
        items: [
          {
            ...item,
            title: 'Setting up Builder’s worktree',
            choices: [{ value: 'stop', label: 'Stop' }],
          },
        ],
      },
    });
    return Promise.resolve({ ok: true, value: { outcome: 'started', revs: {} } });
  });
  await events.click(screen.getByRole('button', { name: 'Run' }));
  expectOneOp(core, 'reply', { canvas, to: item.id, answer: { choice: 'run' } });
  expect(await screen.findByRole('button', { name: 'Stop' })).toBeTruthy();
  act(() => {
    core.change({
      topic: `needs:${canvas}`,
      rev: 2,
      replace: {
        items: [
          {
            ...item,
            title: 'Setup failed in Builder’s worktree',
            choices: [
              { value: 'retry', label: 'Run again' },
              { value: 'skip', label: 'Skip' },
            ],
          },
        ],
      },
    });
  });
  expect(await screen.findByRole('button', { name: 'Run again' })).toBeTruthy();
});

it('shows the core’s persistent oversized-run warning without offering an answer', async () => {
  const problem: NeedsItem = {
    ...proposal,
    id: `unsaved/${canvas}`,
    kind: 'hold',
    by: [],
    title: 'Run progress is too large to save',
    detail: 'Messages are still recorded and delivered.',
    choices: [],
  };
  await setup([problem]);
  const card = screen.getByRole('article', { name: problem.title });
  expect(within(card).getByText(problem.detail ?? '')).toBeTruthy();
  expect(within(card).queryAllByRole('button')).toHaveLength(0);
});
async function setup(items: NeedsItem[], nodes: CanvasNode[] = [], request?: { id: string }) {
  const core = fakeCore();
  cores.push(core);
  core.snapshot(`needs:${canvas}`, { items });
  core.snapshot(`messages:${canvas}`, { items: {}, order: [], next: '' });
  render(
    <NeedsSidebar
      canvas={canvas}
      mirror={core.topics}
      request={request}
      nodes={nodes}
      onOpen={() => undefined}
      onReply={(to, answer) => core.api.reply({ canvas, to, answer })}
    />,
  );
  if (items.length > 0 && !request) {
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

it('opens a requested card arriving later and focuses it once without taking focus on output updates', async () => {
  const core = await setup([], [], { id: file.id });
  act(() => {
    core.change({ topic: `needs:${canvas}`, rev: 1, replace: { items: [file] } });
  });
  const card = await screen.findByRole('article', { name: file.title });
  await waitFor(() => {
    expect(document.activeElement).toBe(card);
  });
  const keep = within(card).getByRole('button', { name: 'Keep' });
  keep.focus();
  act(() => {
    core.change({
      topic: `needs:${canvas}`,
      rev: 2,
      replace: { items: [{ ...file, detail: 'Updated preview' }] },
    });
  });
  expect(document.activeElement).toBe(keep);
  expect(core.operations).toEqual([]);
});
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

it('shows a stalled session with an Interrupt choice answered through one reply', async () => {
  const item: NeedsItem = {
    ...proposal,
    id: 'stalled/builder',
    agent: 'builder',
    kind: 'prompt',
    title: 'No activity from Codex for 20 minutes: its connection may have dropped.',
    choices: [{ value: 'interrupt', label: 'Interrupt' }],
  };
  const core = await setup(
    [item],
    [{ id: 'builder', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Builder' } }],
  );
  expect(await screen.findByText('Silent session: Builder')).toBeTruthy();
  core.reply('reply', () => Promise.resolve({ ok: true, value: { revs: {} } }));
  await events.click(await screen.findByRole('button', { name: 'Interrupt' }));
  expectOneOp(core, 'reply', { canvas, to: item.id, answer: { choice: 'interrupt' } });
});
it('drops an answered card when its stalled id leaves and is raised again, with live buttons and a badge', async () => {
  const item: NeedsItem = {
    ...proposal,
    id: 'stalled/builder',
    agent: 'builder',
    kind: 'prompt',
    title: 'No activity from Codex for 20 minutes: its connection may have dropped.',
    choices: [{ value: 'interrupt', label: 'Interrupt' }],
  };
  const core = await setup(
    [item],
    [{ id: 'builder', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Builder' } }],
  );
  core.reply('reply', () => {
    core.change({ topic: `needs:${canvas}`, rev: 1, replace: { items: [] } });
    return Promise.resolve({ ok: true, value: { revs: {} } });
  });
  await events.click(await screen.findByRole('button', { name: 'Interrupt' }));
  expect((await screen.findByRole('status')).textContent).toBe('Answered.');
  const bell = screen.getByRole('button', { name: 'Needs you' });
  expect(bell.querySelector('.float-needs-count')).toBeNull();
  // The agent's next turn goes silent too: the core raises the same id again.
  act(() => {
    core.change({ topic: `needs:${canvas}`, rev: 2, replace: { items: [item] } });
  });
  expect(await screen.findByRole('button', { name: 'Interrupt' })).toHaveProperty(
    'disabled',
    false,
  );
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByRole('button', { name: `Dismiss ${item.title}` })).toBeNull();
  expect(bell.querySelector('.float-needs-count')?.textContent).toBe('1');
});
it('keeps a refused reply at its card and lets it be retried', async () => {
  const core = await setup([proposal]);
  core.reply('reply', { ok: false, error: { code: 'unavailable', sentence: 'Not saved' } });
  await events.click(await screen.findByRole('button', { name: 'Allow' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Not saved');
  expect(screen.getByRole('button', { name: 'Allow' })).not.toHaveProperty('disabled', true);
});

it.each(['before', 'after'] as const)(
  'removes a failed reply card and its badge when the topic removes it %s the refusal',
  async (when) => {
    const core = await setup([proposal]);
    const reply = Promise.withResolvers<{
      ok: false;
      error: { code: 'not-found'; sentence: string };
    }>();
    core.reply('reply', () => reply.promise);
    await events.click(screen.getByRole('button', { name: 'Allow' }));
    const remove = () => {
      core.change({ topic: `needs:${canvas}`, rev: 1, replace: { items: [] } });
    };
    if (when === 'before') act(remove);
    await act(() => {
      reply.resolve({ ok: false, error: { code: 'not-found', sentence: 'No longer waiting' } });
      return Promise.resolve();
    });
    if (when === 'after') {
      expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'No longer waiting');
      act(remove);
    }
    await waitFor(() => {
      expect(screen.queryByRole('article', { name: proposal.title })).toBeNull();
    });
    const bell = screen.getByRole('button', { name: 'Needs you' });
    expect(bell).toHaveProperty('disabled', true);
    expect(bell.querySelector('.float-needs-count')).toBeNull();
    // A later prompt may reuse an id (stalled/<agent> does): it starts without the old error.
    act(() => {
      core.change({ topic: `needs:${canvas}`, rev: 2, replace: { items: [proposal] } });
    });
    await events.click(screen.getByRole('button', { name: 'Needs you' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Allow' })).toHaveProperty('disabled', false);
  },
);

it.each(['permission', 'trust'] as const)(
  'keeps the native Terminal %s wording beside its core Need',
  async (kind) => {
    const entry = testPromptEntry(
      {
        kind: 'approval',
        title: kind === 'permission' ? 'Approve Bash: echo hello?' : 'Trust the project folder?',
        answerIn: 'terminal',
        choices: [],
        ...(kind === 'permission'
          ? { summary: 'echo hello', subject: { type: 'tool', tool: 'Bash', input: {} } as const }
          : { subject: { type: 'trust' } as const }),
      },
      'a',
    );
    const item = promptNeed(
      { canvas, need: entry.need, name: 'A', prompt: entry.prompt, standIn: false },
      'you',
    );
    const core = fakeCore();
    cores.push(core);
    core.snapshot(`needs:${canvas}`, { items: [item] });
    // Its wording comes with the agent's summary, yours alone (B11 C: bounded asks).
    const summary = sessionView(AgentId.parse('a'), 'claude-code.terminal', {
      ...NEW_SESSION,
      entries: [entry],
    }).summary;
    core.snapshot(`sessions:${canvas}`, { agents: { [AgentId.parse('a')]: summary } });
    core.snapshot(
      `session:${canvas}:a`,
      sessionView(AgentId.parse('a'), 'claude-code.terminal', { ...NEW_SESSION, entries: [entry] }),
    );
    const opened = vi.fn();
    render(
      <NeedsSidebar
        canvas={canvas}
        mirror={core.topics}
        nodes={[{ id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'A' } }]}
        onOpen={opened}
        onReply={() => Promise.resolve({ revs: {} })}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Needs you' })).toHaveProperty('disabled', false);
    });
    await events.click(screen.getByRole('button', { name: 'Needs you' }));
    const card = await screen.findByRole('group', { name: 'A asks, in its terminal' });
    expect(card.textContent).toContain(
      kind === 'permission' ? 'Approve Bash: echo hello?' : 'Trust the project folder?',
    );
    await events.click(within(card).getByRole('button', { name: 'Open terminal' }));
    expect(opened).toHaveBeenCalledExactlyOnceWith('a');
  },
);

// B21 X3: asks and messages to you, and the loop breaker's hold, from the same Needs topic.
const asker: CanvasNode = {
  id: 'a',
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: 'Builder' },
};
const question = {
  id: 'q1',
  header: 'Plan',
  text: 'Which database?',
  options: [{ label: 'SQLite' }, { label: 'Postgres', description: 'Needs a server' }],
  multiple: false,
  other: false,
};
const toYou: NeedsItem = {
  id: 'ask/33333333-3333-4333-8333-333333333333',
  canvas,
  kind: 'prompt',
  for: 'you',
  by: ['you'],
  title: 'Builder asks: Which database?',
  choices: [
    { value: 'dismiss', label: 'Dismiss', humanOnly: 'Only you dismiss a question to you.' },
  ],
  questions: [question],
  answerIn: 'api',
};

it('answers an ask to you with the question card, in one reply carrying every answer', async () => {
  const core = await setup([toYou], [asker]);
  const card = screen.getByRole('article', { name: toYou.title });
  expect(within(card).getByText('Question')).toBeTruthy();
  expect(within(card).queryByText('Proposal')).toBeNull();
  expect(within(card).getByText(/Which database\?/)).toBeTruthy();
  const send = within(card).getByRole('button', { name: 'Send answers' });
  expect(send).toHaveProperty('disabled', true);
  await events.click(within(card).getByRole('radio', { name: 'Postgres' }));
  await events.click(send);
  expectOneOp(core, 'reply', {
    canvas,
    to: toYou.id,
    answer: { answers: { q1: { picked: ['Postgres'] } } },
  });
});

it('dismisses an ask to you with exactly one reply', async () => {
  const core = await setup([toYou], [asker]);
  await events.click(screen.getByRole('button', { name: 'Dismiss' }));
  expectOneOp(core, 'reply', { canvas, to: toYou.id, answer: { choice: 'dismiss' } });
});

it('sends picked and typed answers to every question together, retaining the draft on refusal', async () => {
  const item: NeedsItem = {
    ...toYou,
    questions: [
      question,
      {
        ...question,
        id: 'q2',
        header: 'Reason',
        text: 'Why this database?',
        options: [],
        other: true,
      },
    ],
  };
  const core = await setup([item], [asker]);
  core.reply('reply', {
    ok: false,
    error: { code: 'conflict', sentence: 'This question changed.' },
  });
  const send = screen.getByRole('button', { name: 'Send answers' });
  await events.click(screen.getByRole('radio', { name: 'SQLite' }));
  expect(send).toHaveProperty('disabled', true);
  await events.change(screen.getByRole('textbox', { name: 'Why this database?' }), {
    target: { value: 'Keep it local.' },
  });
  await events.click(send);
  expectOneOp(core, 'reply', {
    canvas,
    to: item.id,
    answer: { answers: { q1: { picked: ['SQLite'] }, q2: { text: 'Keep it local.' } } },
  });
  expect(screen.getByRole('alert').textContent).toBe('This question changed.');
  expect(screen.getByRole('radio', { name: 'SQLite' })).toHaveProperty('checked', true);
  expect(screen.getByRole('textbox', { name: 'Why this database?' })).toHaveProperty(
    'value',
    'Keep it local.',
  );
});

it('lets you answer an ask to an agent, which offers no Dismiss', async () => {
  const item: NeedsItem = { ...toYou, for: 'agent:b', by: ['agent:b', 'you'], choices: [] };
  const core = await setup([item], [asker]);
  expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  await events.click(screen.getByRole('radio', { name: 'SQLite' }));
  await events.click(screen.getByRole('button', { name: 'Send answers' }));
  expectOneOp(core, 'reply', {
    canvas,
    to: item.id,
    answer: { answers: { q1: { picked: ['SQLite'] } } },
  });
});

it('counts an ask as one thing waiting, however many questions it has', async () => {
  const item = { ...toYou, questions: [question, { ...question, id: 'q2' }] };
  await setup([item], [asker]);
  expect(screen.getByRole('heading', { name: /Needs you/ }).textContent).toContain('1');
});

const message: NeedsItem = {
  id: 'message/44444444-4444-4444-8444-444444444444',
  canvas,
  kind: 'message',
  for: 'you',
  by: ['you'],
  title: 'Message from Builder',
  detail: 'The migration is done.',
  choices: [{ value: 'dismiss', label: 'Dismiss' }],
  text: { placeholder: 'Reply' },
  answerIn: 'api',
};

it('shows a message to you as a message, and dismisses it with one reply', async () => {
  const core = await setup([message], [asker]);
  const card = screen.getByRole('article', { name: message.title });
  expect(within(card).getByText('Message')).toBeTruthy();
  expect(within(card).queryByText('Proposal')).toBeNull();
  expect(card.textContent).toContain('The migration is done.');
  await events.click(within(card).getByRole('button', { name: 'Dismiss' }));
  expectOneOp(core, 'reply', { canvas, to: message.id, answer: { choice: 'dismiss' } });
});

it('replies to a message to you in your words, with one reply', async () => {
  const core = await setup([message], [asker]);
  await events.change(screen.getByRole('textbox', { name: 'Reply' }), {
    target: { value: 'Thanks, go on' },
  });
  await events.click(screen.getByRole('button', { name: 'Reply' }));
  expectOneOp(core, 'reply', { canvas, to: message.id, answer: { text: 'Thanks, go on' } });
});

const loop: NeedsItem = {
  id: 'loop/a/b',
  canvas,
  kind: 'hold',
  for: 'you',
  by: ['you'],
  title: 'Builder and Reviewer have passed 10 turns between them without the user',
  choices: [{ value: 'goOn', label: 'Go on', humanOnly: 'Only you let agents go on.' }],
  answerIn: 'api',
  loop: { pair: ['a', 'b'], held: ['55555555-5555-4555-8555-555555555555'] },
};

it('shows the loop hold as the agents going back and forth, not as a run hold', async () => {
  const core = await setup([loop], [asker]);
  const card = screen.getByRole('article', { name: loop.title });
  expect(within(card).getByText('Agents going back and forth')).toBeTruthy();
  expect(within(card).queryByText('Run')).toBeNull();
  await events.click(within(card).getByRole('button', { name: 'Go on' }));
  expectOneOp(core, 'reply', { canvas, to: loop.id, answer: { choice: 'goOn' } });
});

it('shows the loop hold’s held message and its pair beside Go on, and no other message', async () => {
  const held = {
    id: '55555555-5555-4555-8555-555555555555',
    canvas,
    from: 'agent:a',
    to: 'agent:b',
    kind: 'text',
    body: 'Please look at it once more',
    state: 'pending',
    origin: 'agent',
  } as const;
  const other = { ...held, id: '66666666-6666-4666-8666-666666666666', to: 'agent:c', body: 'x' };
  const unheld = {
    ...held,
    id: '77777777-7777-4777-8777-777777777777',
    to: 'agent:a',
    body: 'Not in this hold',
  };
  const ended = {
    ...held,
    id: '88888888-8888-4888-8888-888888888888',
    from: 'corrallm',
    to: 'agent:a',
    kind: 'settled',
    body: 'The question expired.',
  };
  const core = fakeCore();
  cores.push(core);
  core.snapshot(`needs:${canvas}`, {
    items: [{ ...loop, loop: { pair: ['a', 'b'], held: [ended.id, held.id] } }],
  });
  core.snapshot(`messages:${canvas}`, {
    order: [held.id, other.id, unheld.id, ended.id],
    items: { [held.id]: held, [other.id]: other, [unheld.id]: unheld, [ended.id]: ended },
  } as never);
  render(
    <NeedsSidebar
      canvas={canvas}
      mirror={core.topics}
      nodes={[asker, { ...asker, id: 'b', data: { label: 'Reviewer' } }]}
      onOpen={() => undefined}
      onReply={(to, answer) => core.api.reply({ canvas, to, answer })}
    />,
  );
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Needs you' })).not.toHaveProperty('disabled', true);
  });
  await events.click(screen.getByRole('button', { name: 'Needs you' }));
  const list = screen.getByRole('list', { name: 'Held messages' });
  expect(list.textContent).toContain('Builder to Reviewer');
  expect(list.textContent).toContain('Please look at it once more');
  expect(list.textContent).toContain('corrallm to Builder');
  expect(list.textContent).toContain('The question expired.');
  expect(list.textContent).not.toContain('Not in this hold');
  expect(list.querySelectorAll('li')).toHaveLength(2);
  expect(list.querySelector('li')?.textContent).toContain('The question expired.');
});
