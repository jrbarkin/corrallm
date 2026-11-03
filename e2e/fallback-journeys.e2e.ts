import { existsSync } from 'node:fs';
import { ItemId } from '../src/shared/api/ids';
import { expect, test } from '@playwright/test';
import { expectRestorable } from '../src/main/core/engine/run/test-restore';
import { fallbackWorld, HANDOFF, LIMIT_QUEUE, WORKER } from './fallback-world';
import { openNeeds } from './canvas-actions';
import { agentChipName } from './catalog';

test.skip(process.platform === 'win32', 'The native fake CLIs use POSIX executable wrappers.');
test.afterEach(expectRestorable);
test.setTimeout(120_000);

async function handoffCarried(world: Awaited<ReturnType<typeof fallbackWorld>>) {
  await world.completed('next');
  const latest = await world.call('session.handoff', { canvas: world.canvas, agent: WORKER });
  expect(latest.handoff?.text, 'The handoff must be the source agent’s exact completed reply').toBe(
    HANDOFF,
  );
  expect(
    latest.handoff?.source,
    'The recorded author must be the source Terminal, never the new backend',
  ).toMatchObject({ adapter: 'claude-code', connection: 'claude-code.terminal' });
  const source = await world.claudePrompts();
  expect(
    source,
    'The native source must finish the warm-up, write its handoff, then attempt the limited task in that order',
  ).toEqual([
    expect.stringContaining('fallback-warm'),
    expect.stringContaining('Your context is 60% full'),
    expect.stringContaining('fallback-limit'),
  ]);
  expect(
    source.filter((text) => text.includes('corrallm asks you to write your handoff now')),
    'Context crossing must request one handoff turn, separate from work',
  ).toHaveLength(1);
  expect(
    source.filter((text) => text.includes('fallback-limit')),
    'The source must receive the failed task once',
  ).toHaveLength(1);
  const target = await world.codexPrompts();
  const carried = target.filter((text) => text.includes(HANDOFF));
  expect(carried, 'Exactly the first automated target send must carry the handoff').toHaveLength(1);
  const text = carried[0] ?? '';
  const nonce = /\nhandoff ([0-9a-f]+) begins\n/.exec(text)?.[1];
  expect(nonce, 'The handoff must be inside corrallm’s nonce delimiters').toBeDefined();
  expect(text, 'The target must get the original task before the untrusted handoff').toContain(
    'fallback-limit',
  );
  expect(text.indexOf('fallback-limit'), 'Task text must precede the handoff block').toBeLessThan(
    text.indexOf(HANDOFF),
  );
  expect(
    text,
    'The handoff must retain both matching nonce boundaries and the source’s exact text',
  ).toContain(
    `handoff ${nonce ?? 'missing'} begins\n${HANDOFF}\nhandoff ${nonce ?? 'missing'} ends`,
  );
  expect(text, 'The handoff must be explicitly attributed as the previous agent’s notes').toContain(
    'neither the user’s words nor corrallm’s',
  );
  expect(
    target.filter((text) => text.includes('fallback-limit')),
    'The task must be continued once on the target',
  ).toHaveLength(1);
  expect(
    target.find((text) => text.includes('fallback-next')),
    'The next target task must not carry the handoff again',
  ).not.toContain(HANDOFF);
  const run = (await world.run()).agents[WORKER];
  const attempts = run?.attempts?.[ItemId.parse('limit')];
  expect(
    attempts,
    'The usage-limit failure must be retained with exactly one continuation attempt',
  ).toHaveLength(2);
  expect(attempts?.[0], 'The old attempt must stay failed on the limit').toMatchObject({
    status: 'failed',
    reason: 'usage-limit',
  });
  expect(
    attempts?.[1],
    'Only the new attempt may finish the task, linked to the old one',
  ).toMatchObject({ status: 'succeeded', retryOf: attempts?.[0]?.id });
  const doc = await world.doc();
  expect(doc.entities[`node/${WORKER}`]?.by, 'Only corrallm must author the switch commit').toBe(
    'corrallm',
  );
  expect(
    (await world.worker())?.data,
    'The document must describe the actual target and saved chain position',
  ).toMatchObject({
    adapter: 'codex',
    connection: 'codex.app-server',
    fallback: { on: { step: 0, why: 'usage-limit' } },
  });
  expect(
    (await world.worker())?.data.queue,
    'The switch must leave the authored queue unchanged',
  ).toEqual(LIMIT_QUEUE);
  await world.checkpoint();
}

test('a Terminal context crossing writes its handoff, then a hard limit continues the same task once on the next backend', async () => {
  const world = await fallbackWorld();
  try {
    await world.start();
    await handoffCarried(world);
    await world.page.locator('.react-flow__node-agent').dblclick();
    const view = world.page.getByRole('dialog', { name: 'Worker', exact: true });
    await expect(
      view.getByRole('button', { name: agentChipName('codex.app-server'), exact: true }),
      'The chip must follow the core’s committed endpoint',
    ).toBeVisible();
    await expect(
      view.getByText(/Worker carries on with .*usage ran out/),
      'The switch notice must say why and where the work moved',
    ).toBeVisible();
    await view.getByRole('button', { name: 'Read handoff', exact: true }).click();
    await expect(
      world.page.getByRole('dialog', { name: 'Latest handoff' }).locator('pre'),
      'The tile must open the exact kept handoff',
    ).toHaveText(HANDOFF);
  } catch (error) {
    await world.diagnose(error);
    throw error;
  } finally {
    await world.close();
  }
});

test('a real native usage reading switches between tasks without failing or resending the completed task', async () => {
  const world = await fallbackWorld({
    source: 'app-server',
    queue: [
      { id: 'boundary', message: 'fallback-rule' },
      { id: 'after', message: 'rule-after' },
    ],
  });
  try {
    // This is a rule, not usage.simulate; only the native fake supplies the reading.
    await world.page.evaluate(async () => {
      const result = await window.api.usageSetRule({
        backend: 'codex',
        rule: { window: 'fiveHour', percent: 80, action: 'fallback' },
      });
      if (!result.ok) throw new Error(`The fallback rule must save: ${result.error.sentence}`);
    });
    await world.start();
    await world.completed('after');
    const reading = (await world.call('usage.get')).readings.find((one) => one.backend === 'codex');
    expect(reading, 'The switch must be driven by a real native 90% reading').toMatchObject({
      windows: { fiveHour: { usedPercent: 90 } },
    });
    expect(reading?.simulated, 'A simulated reading must never stand in for this journey').not.toBe(
      true,
    );
    expect(
      (await world.worker())?.data.fallback?.on?.why,
      'The saved reason must distinguish a rule from a hard limit',
    ).toBe('rule');
    expect(
      (await world.codexPrompts()).filter((text) => text.includes('fallback-rule')),
      'The first task must run once on its source',
    ).toHaveLength(1);
    const target = await world.claudePrompts();
    expect(
      target.filter((text) => text.includes('rule-after')),
      'Only the next task must go to the target',
    ).toHaveLength(1);
    expect(
      target.some((text) => text.includes('fallback-rule')),
      'The completed source task must not be resent',
    ).toBe(false);
    const run = (await world.run()).agents[WORKER];
    expect(
      run?.attempts?.[ItemId.parse('boundary')],
      'A rule switch must not turn a successful task into a failed/retried one',
    ).toHaveLength(1);
    expect(run?.attempts?.[ItemId.parse('boundary')]?.[0]?.status).toBe('succeeded');
    await world.checkpoint();
  } catch (error) {
    await world.diagnose(error);
    throw error;
  } finally {
    await world.close();
  }
});

test('an opted-in return waits for the source reset and the next admitted task, never interrupting the target', async () => {
  const queue = [
    ...LIMIT_QUEUE.slice(0, 2),
    { id: 'review', approve: 'return to the own backend' },
    { id: 'return', message: 'fallback-return' },
  ];
  const world = await fallbackWorld({ back: true, queue, resetAfterSeconds: 20 });
  try {
    await world.start();
    await world.completed('limit');
    await expect
      .poll(async () => (await world.run()).agents[WORKER]?.current, {
        message: 'The target must stop at the explicit OK before returning',
        timeout: 20_000,
      })
      .toBe('review');
    const source = (await world.call('usage.get')).readings.find(
      (one) => one.backend === 'claude-code',
    );
    const reset = source?.windows.fiveHour?.resetsAt;
    expect(reset, 'The native failure must have reported a real reset time').toBeGreaterThan(0);
    await expect
      .poll(() => reset !== undefined && reset !== null && Date.now() >= reset, {
        message: 'The native source usage window must reach its reported reset',
        timeout: 30_000,
      })
      .toBe(true);
    expect(
      (await world.worker())?.data.adapter,
      'A reset alone must not interrupt the idle target or answer the OK',
    ).toBe('codex');
    await world.checkpoint();
    await openNeeds(world.page);
    await world.page.getByRole('button', { name: 'Approve', exact: true }).click();
    await world.completed('return');
    expect(
      (await world.worker())?.data,
      'The next admission must restore the own endpoint',
    ).toMatchObject({ adapter: 'claude-code', connection: 'claude-code.terminal' });
    expect(
      (await world.worker())?.data.fallback?.on,
      'Returning must clear the chain position',
    ).toBeUndefined();
    expect(
      (await world.claudePrompts()).filter((text) => text.includes('fallback-return')),
      'The returned task must go once to the source',
    ).toHaveLength(1);
    expect(
      (await world.codexPrompts()).some((text) => text.includes('fallback-return')),
      'The target must not receive the returned task',
    ).toBe(false);
    await world.checkpoint();
  } catch (error) {
    await world.diagnose(error);
    throw error;
  } finally {
    await world.close();
  }
});

test('an unknown action stays unsent with only Skip and Stop here, and Skip releases the next task', async () => {
  const world = await fallbackWorld({
    source: 'app-server',
    queue: [
      { id: 'unknown', action: 'UnknownAction' },
      { id: 'next', message: 'after-unknown' },
    ],
  });
  try {
    await world.start();
    await expect
      .poll(async () => (await world.run()).agents[WORKER]?.refused?.kind, {
        message: 'The core must refuse the unknown action before any native send',
      })
      .toBe('unknown-action');
    expect(await world.codexPrompts(), 'An unknown action must never start a turn').toEqual([]);
    await openNeeds(world.page);
    const needs = world.page.getByRole('complementary', { name: 'Needs you' });
    await expect(needs.getByRole('button', { name: 'Skip', exact: true })).toBeVisible();
    await expect(needs.getByRole('button', { name: 'Stop here', exact: true })).toBeVisible();
    await expect(
      needs.getByRole('button', { name: /Retry|Go on/ }),
      'The refusal must provide no override that sends the unknown action',
    ).toHaveCount(0);
    await world.checkpoint();
    await needs.getByRole('button', { name: 'Skip', exact: true }).click();
    await world.completed('next');
    expect(
      (await world.run()).agents[WORKER]?.outcomes[ItemId.parse('unknown')],
      'Only an explicit Skip may settle the unknown task',
    ).toBe('skipped');
    expect(await world.codexPrompts(), 'Only the next authored message may be sent').toEqual([
      expect.stringContaining('after-unknown'),
    ]);
    await world.checkpoint();
  } catch (error) {
    await world.diagnose(error);
    throw error;
  } finally {
    await world.close();
  }
});

test('with no chain a native hard limit remains held for the user, without a second attempt or target process', async () => {
  const world = await fallbackWorld({
    source: 'app-server',
    chain: false,
    queue: [
      { id: 'limit', message: 'codex-limit' },
      { id: 'next', message: 'must-wait' },
    ],
  });
  try {
    await world.start();
    await expect
      .poll(async () => (await world.run()).agents[WORKER]?.problem?.reason, {
        message: 'The limit must remain the existing user-held problem when no chain is configured',
        timeout: 20_000,
      })
      .toBe('usage-limit');
    await openNeeds(world.page);
    await expect(
      world.page.getByRole('button', { name: 'Retry', exact: true }),
      'The existing user decision must remain available',
    ).toBeVisible();
    expect(
      (await world.run()).agents[WORKER]?.attempts?.[ItemId.parse('limit')],
      'No automatic continuation may appear without a chain',
    ).toHaveLength(1);
    expect(await world.codexPrompts(), 'The source must receive exactly the original task').toEqual(
      [expect.stringContaining('codex-limit')],
    );
    expect(await world.claudePrompts(), 'No target CLI may start without a chain').toEqual([]);
    expect((await world.worker())?.data.adapter).toBe('codex');
    await world.checkpoint();
  } catch (error) {
    await world.diagnose(error);
    throw error;
  } finally {
    await world.close();
  }
});

for (const noWindow of [false, true]) {
  test(`${noWindow ? 'with no window' : 'after closing the window'} the real core writes and carries the handoff and completes the run`, async () => {
    test.skip(
      noWindow && process.platform !== 'darwin',
      'Only macOS closes the last window while keeping the core; other OSes minimize it.',
    );
    const world = await fallbackWorld({ gateWarm: true });
    try {
      await world.start();
      await world.waitGate();
      const pid = (await world.discovery()).pid;
      await world.closeWindow();
      if (noWindow)
        expect(
          await world.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
          'This journey must have zero renderer windows',
        ).toBe(0);
      await world.release();
      await handoffCarried(world);
      expect(
        (await world.discovery()).pid,
        'Closing a view must leave the same core in charge of the switch',
      ).toBe(pid);
      await world.reopen();
      await expect(
        world.page.locator('.react-flow__node-agent'),
        'Reopening must project the existing worker',
      ).toHaveCount(1);
      await world.page.locator('.react-flow__node-agent').dblclick();
      await expect(
        world.page
          .getByRole('dialog', { name: 'Worker', exact: true })
          .getByRole('button', { name: agentChipName('codex.app-server'), exact: true }),
        'The reopened chip must show the committed target',
      ).toBeVisible();
    } catch (error) {
      await world.diagnose(error);
      throw error;
    } finally {
      await world.close();
    }
  });
}

test('a core crash during source close leaves no switch committed; Resume decides it once from the durable limit', async () => {
  const world = await fallbackWorld({
    source: 'app-server',
    linger: true,
    queue: [
      { id: 'limit', message: 'codex-limit' },
      { id: 'next', message: 'after-crash' },
    ],
  });
  try {
    await world.start();
    await expect
      .poll(() => existsSync(`${world.linger}.waiting`), {
        message: 'The source fake must be closing but still alive before the switch commit',
        timeout: 20_000,
      })
      .toBe(true);
    expect(
      (await world.worker())?.data.adapter,
      'The source close must finish before any document switch',
    ).toBe('codex');
    await expect
      .poll(
        async () =>
          (await world.call('session.get', { canvas: world.canvas, agent: WORKER })).fallback
            ?.switching,
        { message: 'The core must still report its in-progress switch' },
      )
      .toBe(true);
    await world.checkpoint();
    await world.crash();
    await world.releaseClose();
    const restored = await world.run();
    expect(restored.paused, 'A real core crash must restore the run paused').toBe(true);
    expect(
      (await world.worker())?.data.adapter,
      'An uncommitted switch must never be replayed at startup',
    ).toBe('codex');
    expect(
      await world.claudePrompts(),
      'The target must not start merely because the core restarted',
    ).toEqual([]);
    await world.call('run.resume', { canvas: world.canvas });
    await world.completed('next');
    expect(
      (await world.worker())?.data.adapter,
      'Explicit Resume must decide the still-durable source limit',
    ).toBe('claude-code');
    expect(
      (await world.claudePrompts()).filter((text) => text.includes('codex-limit')),
      'The target must get exactly one continuation after recovery',
    ).toHaveLength(1);
    expect(
      (await world.run()).agents[WORKER]?.attempts?.[ItemId.parse('limit')],
      'Recovery must retain the failed source and one successful continuation',
    ).toHaveLength(2);
    await world.checkpoint();
  } catch (error) {
    await world.diagnose(error);
    throw error;
  } finally {
    await world.close();
  }
});
