import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { agentApiWorld, STEP_TOOL } from './agent-api-world';
import type { Logged } from './agent-api-world';
import { openNeeds } from './canvas-actions';
import { continuityWorld } from './continuity-world';

test.skip(process.platform === 'win32', 'The native fakes use POSIX wrappers.');
test.setTimeout(120_000);

/*
 * B21 X4: what reaches you from a party's questions and messages, in the built app. In the first
 * two cases the party is an outside orchestrator's write token (it may ask you and message you,
 * as an agent may), and every gesture on the answering side goes through the real window.
 */

const QUESTION = [
  {
    id: 'which',
    header: 'Plan',
    text: 'Which plan do you want?',
    options: [{ label: 'Small' }, { label: 'Large' }],
    multiple: false,
    other: false,
  },
];

test('a question to you is answered in the window and reaches its asker once; a dismissed one tells it so', async () => {
  const world = await continuityWorld({ queue: [] });
  try {
    const { canvas, page } = world;
    const first = await world.call('ask', { canvas, to: { party: 'you' }, questions: QUESTION });
    await openNeeds(page);
    const needs = page.getByRole('complementary', { name: 'Needs you' });
    await expect(needs.getByText('Which plan do you want?')).toBeVisible();

    // A token may not dismiss (or answer) what is asked of you; the card stays.
    const refused = await world.raw('reply', {
      canvas,
      to: `ask/${first.id}`,
      answer: { choice: 'dismiss' },
    });
    expect(refused.isError).toBe(true);
    await expect(needs.getByText('Which plan do you want?')).toBeVisible();

    await needs.getByRole('radio', { name: 'Large' }).check();
    await needs.getByRole('button', { name: 'Send answers' }).click();
    await expect(needs.getByText('Which plan do you want?')).toHaveCount(0);
    const answered = await world.call('wait', { timeoutSeconds: 10 });
    expect(JSON.stringify(answered.messages)).toContain('Large');

    const second = await world.call('ask', {
      canvas,
      to: { party: 'you' },
      questions: QUESTION,
    });
    await expect(needs.getByText('Which plan do you want?')).toBeVisible();
    await needs.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(needs.getByText('Which plan do you want?')).toHaveCount(0);
    await expect(needs.getByRole('status').filter({ hasText: 'Dismissed.' })).toHaveCount(1);
    await expect
      .poll(async () => JSON.stringify((await world.call('wait', { timeoutSeconds: 1 })).messages))
      .toContain(`dismissed your question ${second.id}`);
  } finally {
    await world.close();
  }
});

test('a message to you is replied to or dismissed in the window; a token may not dismiss it', async () => {
  const world = await continuityWorld({ queue: [] });
  try {
    const { canvas, page } = world;
    const sent = await world.call('message', {
      canvas,
      to: { party: 'you' },
      body: 'The build is green.',
    });
    await openNeeds(page);
    const needs = page.getByRole('complementary', { name: 'Needs you' });
    await expect(needs.getByText('The build is green.')).toBeVisible();

    const refused = await world.raw('reply', {
      canvas,
      to: `message/${sent.id}`,
      answer: { choice: 'dismiss' },
    });
    expect(refused.isError).toBe(true);
    await expect(needs.getByText('The build is green.')).toBeVisible();

    await needs.getByRole('textbox').fill('Thanks, ship it.');
    await needs.getByRole('button', { name: 'Reply', exact: true }).click();
    const card = (text: string) => needs.getByRole('article').filter({ hasText: text });
    await expect(card('The build is green.').getByRole('status')).toHaveText('Answered.');
    await expect
      .poll(async () => JSON.stringify((await world.call('wait', { timeoutSeconds: 1 })).messages))
      .toContain('Thanks, ship it.');

    await world.call('message', { canvas, to: { party: 'you' }, body: 'Never mind this one.' });
    await expect(needs.getByText('Never mind this one.')).toBeVisible();
    await needs.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(card('Never mind this one.').getByRole('status')).toHaveText('Dismissed.');
  } finally {
    await world.close();
  }
});

/*
 * B21 C7: fake agents on corrallm's own MCP. Every connection's descriptor routes it, so each
 * fake gets its session's entry, lists corrallm's tools as it starts, and makes a turn's scripted
 * calls (`rules`) through src/main/sessions/fake-mcp-client.mjs; agent-api-world.ts says how.
 */

const SIZE = [
  {
    id: 'size',
    header: 'Size',
    text: 'Which size should it be?',
    options: [{ label: 'Small' }, { label: 'Large' }],
    multiple: false,
    other: false,
  },
];

test('fake agents ask you and each other, and continue their tasks on the answers', async () => {
  const world = await agentApiWorld({
    agents: [
      {
        id: 'planner',
        label: 'Planner',
        connection: 'claude-code.terminal',
        queue: [
          { id: 'choose', action: 'Bash', instruction: 'plan-ask-you' },
          { id: 'size', action: 'Bash', instruction: 'plan-ask-builder' },
        ],
      },
      { id: 'builder', label: 'Builder', connection: 'claude-code.sdk' },
    ],
    links: [['planner', 'builder']],
    rules: [
      {
        when: 'plan-ask-you',
        calls: [{ tool: 'ask', args: { to: { party: 'you' }, questions: QUESTION } }],
        reply: 'Asked the user.',
      },
      { when: 'Answer from the user', reply: 'Planned it large.\nSUCCEEDED' },
      {
        when: 'plan-ask-builder',
        calls: [{ tool: 'ask', args: { to: 'builder', questions: SIZE } }],
        reply: 'Asked Builder.',
      },
      {
        when: 'Question from agent',
        calls: [
          {
            tool: 'reply',
            args: { to: 'ask/{ask}', answer: { answers: { size: { picked: ['Large'] } } } },
          },
        ],
        reply: 'Answered Planner.',
      },
      { when: 'Answer from agent', reply: 'Sized it large.\nSUCCEEDED' },
    ],
  });
  try {
    const { page } = world;
    await world.wake('planner');
    await world.wake('builder');
    await world.run();
    // Planner asks you in its step's own turn; that turn ends, and the step waits, unjudged.
    await expect(world.row('planner', 'choose')).toContainText('waiting for an answer', {
      timeout: 20_000,
    });
    // The fake logs a call once corrallm has answered it, which can trail what the core shows.
    await expect.poll(() => world.calls('plan-ask-you')).toMatchObject([{ tool: 'ask', ok: true }]);
    await openNeeds(page);
    const needs = page.getByRole('complementary', { name: 'Needs you' });
    await expect(needs.getByText('Which plan do you want?')).toBeVisible();
    await needs.getByRole('radio', { name: 'Large' }).check();
    await needs.getByRole('button', { name: 'Send answers' }).click();
    // Your answer continues the task, first in line; its turn's verdict judges the step.
    await expect(world.row('planner', 'choose')).toHaveAttribute('data-run', 'succeeded', {
      timeout: 20_000,
    });
    // Then Planner asks Builder, which answers through reply; the answer continues the next step.
    await expect(world.row('planner', 'size')).toHaveAttribute('data-run', 'succeeded', {
      timeout: 20_000,
    });
    // The fake logs a call once corrallm has answered it, which can trail what the core shows.
    await expect
      .poll(() => world.calls('plan-ask-builder'))
      .toMatchObject([{ tool: 'ask', ok: true }]);
    // The fake logs a call once corrallm has answered it, which can trail what the core shows.
    await expect
      .poll(() => world.calls('Question from agent'))
      .toMatchObject([{ tool: 'reply', ok: true }]);
    const prompts = await world.sdkPrompts();
    expect(prompts.filter((text) => text.includes('Question from agent "Planner"'))).toHaveLength(
      1,
    );
  } finally {
    await world.close();
  }
});

for (const connection of [
  'claude-code.terminal',
  'claude-code.sdk',
  'codex.app-server',
  'codex.terminal',
] as const) {
  test(`a step is completed through complete, and its reported outcome shows on the row (${connection})`, async () => {
    const world = await agentApiWorld({
      agents: [
        {
          id: 'worker',
          label: 'Worker',
          connection,
          queue: [
            {
              id: 'report',
              action: STEP_TOOL[connection.split('.')[0] ?? ''],
              instruction: 'report-done',
            },
          ],
        },
      ],
      rules: [
        {
          when: 'report-done',
          calls: [
            {
              tool: 'complete',
              args: { task: '{task}', outcome: 'succeeded', summary: 'Ran the suite, all green.' },
            },
          ],
          // No verdict line: the reported outcome alone judges the step.
          reply: 'Done.',
        },
      ],
    });
    try {
      await world.wake('worker');
      await world.run();
      await expect(world.row('worker', 'report')).toHaveAttribute('data-run', 'succeeded', {
        timeout: 20_000,
      });
      await expect(world.row('worker', 'report')).toContainText(
        'Reported succeeded: Ran the suite, all green.',
      );
      expect(await world.calls('report-done')).toMatchObject([{ tool: 'complete', ok: true }]);
    } finally {
      await world.close();
    }
  });
}

test('the loop breaker holds the pair at ten turns; a token is refused Go on; you release it', async () => {
  const world = await agentApiWorld({
    agents: [
      { id: 'a', label: 'Alpha', connection: 'claude-code.terminal' },
      { id: 'b', label: 'Beta', connection: 'claude-code.sdk' },
    ],
    links: [['a', 'b']],
    rules: [
      {
        when: 'ping-beta',
        calls: [{ tool: 'message', args: { to: 'b', body: 'pong-please' } }],
        reply: 'Sent.',
      },
    ],
  });
  try {
    const { canvas, page } = world;
    await world.wake('a');
    await world.wake('b');
    const pongs = async () =>
      (await world.sdkPrompts()).filter((text) => text.includes('pong-please')).length;
    const replies = async () =>
      (await world.terminalLog()).filter(
        (line) => line.event === 'prompt' && line.text?.includes('Reply from agent "Beta"'),
      ).length;
    // Five exchanges: Alpha's message to Beta and Beta's reply, each a turn between them. Your
    // orchestrator's messages to Alpha start them, and never count.
    for (let round = 1; round <= 5; round++) {
      await world.call('message', { canvas, to: 'a', body: `ping-beta ${String(round)}` });
      await expect.poll(pongs, { timeout: 20_000 }).toBe(round);
      await expect.poll(replies, { timeout: 20_000 }).toBe(round);
    }
    // The eleventh turn waits for you.
    await world.call('message', { canvas, to: 'a', body: 'ping-beta 6' });
    await expect
      .poll(async () => (await world.calls('ping-beta')).length, { timeout: 20_000 })
      .toBe(6);
    await openNeeds(page);
    const needs = page.getByRole('complementary', { name: 'Needs you' });
    const card = needs
      .getByRole('article')
      .filter({ hasText: 'have passed 10 turns between them without the user' });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByRole('list', { name: 'Held messages' })).toContainText('pong-please');
    expect(await pongs()).toBe(5);
    // A token can neither see nor answer it.
    const refused = await world.raw('reply', {
      canvas,
      to: 'loop/a/b',
      answer: { choice: 'goOn' },
    });
    expect(refused.isError).toBe(true);
    await expect(card).toBeVisible();
    // You let them go on: the held turn is delivered.
    await card.getByRole('button', { name: 'Go on', exact: true }).click();
    await expect.poll(pongs, { timeout: 20_000 }).toBe(6);
  } finally {
    await world.close();
  }
});

test('a restart rotates an agent’s credential and closing the window does not', async () => {
  const world = await agentApiWorld({
    agents: [{ id: 'worker', label: 'Worker', connection: 'claude-code.terminal' }],
    rules: [
      {
        when: 'say-hello',
        calls: [{ tool: 'message', args: { to: { party: 'you' }, body: 'Hello from Worker.' } }],
        reply: 'Said hello.',
      },
    ],
  });
  try {
    const { canvas } = world;
    const connected = async () =>
      (await world.logged()).filter((line) => line.event === 'connected');
    const said = async () => (await world.calls('say-hello')).filter((line) => line.ok);
    await world.wake('worker');
    const [first] = await connected();
    expect(first?.credential).toMatch(/^[0-9a-f]{16}$/);

    // Closing the window ends no session and rotates nothing: the credential still works.
    await world.closeWindow();
    await world.reopen();
    await world.call('message', { canvas, to: 'worker', body: 'say-hello once' });
    await expect.poll(async () => (await said()).length, { timeout: 20_000 }).toBe(1);
    expect(await connected()).toEqual([first]);
    expect((await world.listed()).worker).toBe(true);

    // A restart waits for an idle session: the turn that said hello ends first.
    await expect
      .poll(async () => (await world.call('session.get', { canvas, agent: 'worker' })).status, {
        timeout: 20_000,
      })
      .toBe('idle');
    // A restart is a new generation: the old credential ends as its close begins, and the new
    // session connects with a new one.
    await world.call('session.restart', { canvas, agent: 'worker' });
    await expect.poll(async () => (await connected()).length, { timeout: 20_000 }).toBe(2);
    const [, second] = await connected();
    expect(second?.credential).not.toBe(first?.credential);
    const closing = (await world.logged()).filter((line) => line.event === 'closing');
    expect(closing).toMatchObject([{ pid: first?.pid, ok: false }]);
    await expect.poll(async () => (await world.listed()).worker, { timeout: 20_000 }).toBe(true);
    await world.call('message', { canvas, to: 'worker', body: 'say-hello again' });
    await expect.poll(async () => (await said()).length, { timeout: 20_000 }).toBe(2);
    expect((await said()).at(-1)?.pid).toBe(second?.pid);
  } finally {
    await world.close();
  }
});

test('serve runs agents on corrallm’s MCP, and an agent’s question waits for you', async () => {
  const world = await agentApiWorld({
    headless: true,
    agents: [
      { id: 'a', label: 'Alpha', connection: 'claude-code.terminal' },
      { id: 'b', label: 'Beta', connection: 'codex.app-server' },
    ],
    links: [['a', 'b']],
    rules: [
      {
        when: 'relay-to-beta',
        calls: [{ tool: 'message', args: { to: 'b', body: 'relayed-hello' } }],
        reply: 'Relayed.',
      },
      { when: 'relayed-hello', calls: [{ tool: 'agents', args: {} }], reply: 'Got it.' },
      {
        when: 'ask-you-headless',
        calls: [{ tool: 'ask', args: { to: { party: 'you' }, questions: QUESTION } }],
        reply: 'Asked the user.',
      },
    ],
  });
  try {
    const { canvas } = world;
    await world.wake('a');
    await world.wake('b');
    expect(await world.listed()).toEqual({ a: true, b: true });
    // One agent messages another through corrallm's MCP; the other reads its own reach through it.
    await world.call('message', { canvas, to: 'a', body: 'relay-to-beta' });
    await expect
      .poll(async () => (await world.calls('relayed-hello')).map((line) => line.ok), {
        timeout: 20_000,
      })
      .toEqual([true]);
    expect(await world.calls('relay-to-beta')).toMatchObject([{ tool: 'message', ok: true }]);
    // Under serve no one is you: an agent's question to you stays open, answered by no token and
    // by nothing silently.
    await world.call('message', { canvas, to: 'a', body: 'ask-you-headless' });
    await expect
      .poll(async () => (await world.calls('ask-you-headless')).length, { timeout: 20_000 })
      .toBe(1);
    const [asked] = await world.calls('ask-you-headless');
    expect(asked).toMatchObject({ tool: 'ask', ok: true });
    const id = asked?.result?.id;
    expect(typeof id).toBe('string');
    const refused = await world.raw('reply', {
      canvas,
      to: `ask/${String(id)}`,
      answer: { answers: { which: { picked: ['Large'] } } },
    });
    expect(refused.isError).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const prompts = (await world.terminalLog()).filter((line) => line.event === 'prompt');
    expect(prompts.some((line) => line.text?.includes('Answer from'))).toBe(false);
  } finally {
    await world.close();
  }
});

test('outside registrations are inert inside an agent', async () => {
  const canary = randomBytes(32).toString('base64url');
  const cli = path.resolve('dist-cli/corrallm.cjs');
  let helper = '';
  const world = await agentApiWorld({
    agents: [{ id: 'worker', label: 'Worker', connection: 'claude-code.terminal' }],
    async setup(dir) {
      // An outside token as your shell might hold it (Codex's registration reads it from the
      // environment), and as a file a Claude Code headers helper reads it from.
      const file = path.join(dir, 'outside-token');
      await writeFile(file, canary, { mode: 0o600 });
      helper = `"${process.execPath}" "${cli}" token header --from "${file}"`;
      const server = { type: 'http', url: 'http://127.0.0.1:9/mcp', headersHelper: helper };
      await writeFile(
        path.join(dir, 'config', '.claude.json'),
        JSON.stringify({
          mcpServers: {
            'corrallm-server': server,
            'corrallm-server-dev': server,
            // Your own name for it: the session doesn't switch it off, so its helper runs.
            'my-corrallm': server,
          },
        }),
      );
      return { CORRALLM_OUTSIDE_TOKEN: canary };
    },
  });
  try {
    // Outside an agent the helper prints the header (it is shown nowhere here).
    const outside = await new Promise<{ code: number | null; printed: boolean }>((resolve) => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== 'CORRALLM_AGENT_SESSION'),
      );
      const child = spawn('/bin/sh', ['-c', helper], { env, stdio: ['ignore', 'pipe', 'ignore'] });
      let printed = false;
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().trim() !== '') printed = true;
      });
      child.on('close', (code) => {
        resolve({ code, printed });
      });
    });
    expect(outside).toEqual({ code: 0, printed: true });

    await world.wake('worker');
    // Its servers connect (and their helpers run) as it starts, beside corrallm's entry.
    const outsideServers = async () =>
      (await world.logged()).filter((line) => line.event === 'outside-server').length;
    await expect.poll(outsideServers, { timeout: 20_000 }).toBe(3);
    const lines = await world.logged();
    // No outside token reaches the agent's environment; the agent marker does.
    expect(lines.filter((line) => line.event === 'environment')).toMatchObject([
      { outsideToken: false, agentSession: '1' },
    ]);
    const servers: Record<string, Logged> = Object.fromEntries(
      lines
        .filter((line) => line.event === 'outside-server')
        .map((line) => [String(line.name), line]),
    );
    // The orchestrators' names are switched off for the session: their helpers never run.
    expect(servers['corrallm-server']).toMatchObject({ denied: true });
    expect(servers['corrallm-server-dev']).toMatchObject({ denied: true });
    expect(servers['corrallm-server']).not.toHaveProperty('helperExit');
    // A renamed registration still runs its helper, which gives an agent session nothing.
    expect(servers['my-corrallm']).toMatchObject({ denied: false, printed: false });
    expect(servers['my-corrallm']?.helperExit).not.toBe(0);
    // And the agent's own entry is the one that lists corrallm's tools.
    expect((await world.listed()).worker).toBe(true);
  } finally {
    await world.close();
  }
});
