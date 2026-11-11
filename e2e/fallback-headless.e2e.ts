import { ItemId } from '../src/shared/api/ids';
import { expect, test } from '@playwright/test';
import { expectRestorable } from '../src/main/core/engine/run/test-restore';
import { fallbackWorld, WORKER } from './fallback-world';

test.skip(process.platform === 'win32', 'The native fake CLIs use POSIX executable wrappers.');
test.afterEach(expectRestorable);
test.setTimeout(120_000);

test('serve switches into a fresh Terminal step and keeps its native permission waiting without a window or automatic approval', async () => {
  const world = await fallbackWorld({
    source: 'app-server',
    headless: true,
    queue: [
      { id: 'limit', message: 'codex-limit' },
      { id: 'next', message: 'must-wait-for-terminal' },
    ],
  });
  try {
    await world.start();
    await expect
      .poll(async () => (await world.worker())?.data.connection, {
        message: 'Headless admission must commit the configured Terminal endpoint',
        timeout: 25_000,
      })
      .toBe('claude-code.terminal');
    await expect
      .poll(
        async () =>
          (await world.call('needs', { canvas: world.canvas })).items.some(
            (need) => need.agent === WORKER && need.answerIn === 'both',
          ),
        {
          message: 'The held Terminal permission must remain a live Need with no window',
          timeout: 20_000,
        },
      )
      .toBe(true);
    const need = (await world.call('needs', { canvas: world.canvas })).items.find(
      (need) => need.agent === WORKER && need.answerIn === 'both',
    );
    expect(need?.choices, 'A reached outside token must receive no human answer controls').toEqual(
      [],
    );
    expect(
      (await world.run()).agents[WORKER]?.outcomes[ItemId.parse('limit')],
      'A native permission cannot be treated as successful work',
    ).toBeUndefined();
    expect(
      (await world.run()).agents[WORKER]?.outcomes[ItemId.parse('next')],
      'Later work must stay unsent behind the native wait',
    ).toBeUndefined();
    expect(
      await world.claudePrompts(),
      'The Terminal must receive the one continuation, never the next task',
    ).toEqual([expect.stringContaining('codex-limit')]);
    const session = await world.call('session.get', { canvas: world.canvas, agent: WORKER });
    expect(session.prompts, 'The core prompt owner must retain the headless native wait').toBe(1);
    await world.checkpoint();
  } catch (error) {
    await world.diagnose(error);
    throw error;
  } finally {
    await world.close();
  }
});
