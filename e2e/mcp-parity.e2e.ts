import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { toolName } from '../src/shared/api/registry';
import { openNeeds } from './canvas-actions';
import { continuityWorld } from './continuity-world';

test.skip(process.platform === 'win32', 'The native fake uses a POSIX wrapper.');

test('the window and outside MCP share document, messages and session, respecting their different audiences', async () => {
  const world = await continuityWorld({
    queue: [
      { id: 'edit', message: 'parity-seed' },
      { id: 'ok', approve: 'the parity result' },
      { id: 'after', message: 'parity-after-approval' },
    ],
  });
  try {
    const { canvas, page } = world;
    const args = { canvas, agent: 'builder' };
    await world.showQueues();
    const text = world.row('edit').getByRole('textbox', { name: 'Message to the agent' });
    const read = () => world.call('canvas.get', { canvas });
    const item = async () => (await read()).nodes[0]?.data.queue?.[0];
    await world.call('queue.update', {
      ...args,
      item: 'edit',
      change: { kind: 'message', message: 'parity-shared-text' },
    });
    await expect(text).toHaveValue('parity-shared-text');
    // The GUI's own reader retains the outside author's identity; no transport becomes you.
    const gui = await page.evaluate((canvas) => window.api.canvasGet({ canvas }), canvas);
    if (!gui.ok) throw new Error(gui.error.sentence);
    expect(gui.value.nodes[0]?.data.queue?.[0]).toMatchObject({
      message: 'parity-shared-text',
      by: 'outside:test',
    });
    await world.call('canvas.save', { canvas });
    const outsideFile = JSON.parse(await readFile(world.file, 'utf8')) as unknown;

    // Equivalent edits have identical canonical files apart from their deliberate authorship.
    // Yours is the unmarked author (a queue item says who wrote it only when it was not you), so
    // the person's edit clears the outside author the item carried.
    const authored = async () => {
      const current = await item();
      return { message: current?.message, by: current?.by };
    };
    await text.fill('parity-intermediate');
    await text.blur();
    await expect.poll(authored).toEqual({ message: 'parity-intermediate', by: undefined });
    await text.fill('parity-shared-text');
    await text.blur();
    await expect.poll(authored).toEqual({ message: 'parity-shared-text', by: undefined });
    await page.keyboard.press('ControlOrMeta+s');
    // Authorship is the one deliberate difference: the outside file names its author, yours none.
    const canonical = (value: unknown): unknown =>
      JSON.parse(
        JSON.stringify(value, (key, value: unknown) => (key === 'by' ? undefined : value)),
      );
    await expect
      .poll(async () => canonical(JSON.parse(await readFile(world.file, 'utf8'))))
      .toEqual(canonical(outsideFile));

    // These are absent from tools/list and refused even when named directly with valid input.
    const tools = (await world.client.listTools()).tools.map((tool) => tool.name);
    for (const op of ['session.setMode', 'session.viewCommand', 'canvas.open'] as const) {
      expect(tools).not.toContain(toolName(op));
    }
    expect((await world.raw('session.setMode', { ...args, mode: 'acceptEdits' })).isError).toBe(
      true,
    );
    expect((await world.raw('session.viewCommand', { ...args, text: '/mcp' })).isError).toBe(true);

    await world.queues().getByRole('button', { name: 'Run', exact: true }).click();
    await expect(world.row('ok')).toHaveAttribute('data-run', 'asking');
    expect((await world.raw('queue.remove', { ...args, item: 'ok' })).isError).toBe(true);
    await expect(world.row('ok')).toHaveAttribute('data-run', 'asking');
    expect((await item())?.message).toBe('parity-shared-text');

    await world.queues().getByRole('button', { name: 'Open Builder', exact: true }).click();
    const view = page.getByRole('dialog', { name: 'Builder', exact: true });
    const composer = view.getByRole('textbox', { name: 'Message Builder', exact: true });
    await composer.fill('parity-from-the-person');
    await composer.press('Enter');
    const transcript = view.getByRole('log', { name: 'Transcript' });
    await expect(transcript).toContainText('You said: parity-from-the-person', { timeout: 15_000 });
    await expect
      .poll(async () => (await world.call('session.transcript', args)).entries)
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'text',
            text: expect.stringContaining('parity-from-the-person'),
          }),
        ]),
      );
    const sent = await world.call('message', {
      canvas,
      to: 'builder',
      body: 'parity-from-outside',
    });
    await expect(transcript).toContainText('parity-from-outside');
    await expect
      .poll(async () => (await world.call('messages', { canvas })).items, { timeout: 15_000 })
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: sent.id, state: 'replied', from: 'outside:test' }),
          expect.objectContaining({
            replyTo: sent.id,
            body: expect.stringContaining('parity-from-outside'),
          }),
        ]),
      );
    const session = await world.call('session.get', args);
    expect(session.status).toBe('idle');
    expect(await page.evaluate((args) => window.api.sessionGet(args), args)).toMatchObject({
      ok: true,
      value: { status: session.status, connection: session.connection },
    });
    expect(await world.sessions()).toHaveLength(1);

    // Approve is a human gesture; the token couldn't erase the gate to get here.
    // The window shows the open OK twice (in its queue, and as the Needs you card); either answers.
    await view
      .getByRole('group', { name: 'Needs you' })
      .getByRole('button', { name: 'Approve', exact: true })
      .click();
    await view.getByRole('button', { name: 'All queues', exact: true }).click();
    await expect(world.queues().getByRole('status')).toHaveText('All done');
    // R7 protects even a completed OK. Only the person removes it before a token may propose
    // deleting this agent; the token's attempt above changed nothing.
    await world
      .row('ok')
      .getByRole('button', { name: /^Remove / })
      .click();
    await expect(world.row('ok')).toHaveCount(0);
    await world.queues().getByRole('button', { name: 'Back', exact: true }).click();
    const deletion = await world.call('canvas.delete', { canvas, nodes: ['builder'] });
    expect(deletion).toHaveProperty('proposed');
    await openNeeds(page);
    const needs = page.getByRole('complementary', { name: 'Needs you' });
    await expect(needs).toContainText('Builder');
    await expect(needs.getByRole('button', { name: 'Allow', exact: true })).toBeVisible();
    await needs.getByRole('button', { name: 'Refuse', exact: true }).click();
    await expect(page.locator('.react-flow__node-agent')).toHaveCount(1);
    expect((await read()).nodes).toHaveLength(1);
  } finally {
    await world.close();
  }
});
