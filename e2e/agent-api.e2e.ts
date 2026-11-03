import { expect, test } from '@playwright/test';

import { openNeeds } from './canvas-actions';
import { continuityWorld } from './continuity-world';

test.skip(process.platform === 'win32', 'The native fake uses a POSIX wrapper.');

/*
 * B21 X4: what reaches you from a party's questions and messages, in the built app. Every
 * connection's `api` is off until C7, so no fake agent has a corrallm MCP of its own here: the
 * party is an outside orchestrator's write token (it may ask you and message you, as an agent
 * may), and every gesture on the answering side goes through the real window.
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
 * The journeys below need a fake agent that calls corrallm's MCP from inside its session. The
 * route for that is each connection's descriptor `api`, null on every connection until C7, and
 * the only way to give a fake one is `CoreConfig.sessions.api` (with `.callers`), a test seam the
 * built app and `serve` cannot reach and must not. C7 turns `api` on per connection, with its
 * recording; these cases then run with the fakes that already list and call their entry
 * (`src/main/sessions/fake-mcp-client.mjs`), needing from C7 only: the descriptor's `api`
 * routes on, for the fake connectors the unpackaged e2e build composes (or an e2e-only,
 * unpackaged gate that is not a production switch), and a fake script that makes the calls.
 */
const NEEDS_C7 = 'Needs C7: every connection’s descriptor api is null, so no session gets a route.';

test.fixme('fake agents ask you and each other, and continue their tasks on the answers', () => {
  test.info().annotations.push({ type: 'blocked', description: NEEDS_C7 });
});
test.fixme('a step is completed through complete, and its reported outcome shows on the row', () => {
  test.info().annotations.push({ type: 'blocked', description: NEEDS_C7 });
});
test.fixme('the loop breaker holds the pair at ten turns; a token is refused Go on; you release it', () => {
  test.info().annotations.push({ type: 'blocked', description: NEEDS_C7 });
});
test.fixme('a restart rotates an agent’s credential and closing the window does not', () => {
  test.info().annotations.push({ type: 'blocked', description: NEEDS_C7 });
});
test.fixme('serve runs agents on corrallm’s MCP', () => {
  test.info().annotations.push({ type: 'blocked', description: NEEDS_C7 });
});
test.fixme('outside registrations are inert inside an agent', () => {
  test.info().annotations.push({ type: 'blocked', description: NEEDS_C7 });
});
