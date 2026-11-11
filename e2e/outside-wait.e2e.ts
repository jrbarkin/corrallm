import { spawn } from 'node:child_process';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { agentApiWorld } from './agent-api-world';

test.skip(process.platform === 'win32', 'The native fakes use POSIX wrappers.');
test.setTimeout(120_000);

/*
 * B24 X4: `serve` with no window, an outside orchestrator you already let answer approvals (its
 * grant is in the profile: nothing but the app gives one), and `corrallm wait` as it hears of a
 * request it may answer. It answers once, and is not told that request ended.
 */

interface Waited {
  code: number | null;
  line: { messages?: { body?: string }[]; next?: string } | undefined;
}

test('serve wakes a granted orchestrator, whose wait hears it and whose reply allows once', async () => {
  const w = await agentApiWorld({
    agents: [{ id: 'worker', label: 'Worker', connection: 'claude-code.sdk' }],
    headless: true,
    grant: true,
  });
  try {
    const url = await w.url();
    const wait = (timeout: number, after?: string) =>
      new Promise<Waited>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            path.resolve('dist-cli/corrallm.cjs'),
            'wait',
            '--timeout',
            String(timeout),
            ...(after === undefined ? [] : ['--after', after]),
          ],
          {
            env: {
              ...process.env,
              CORRALLM_URL: url,
              CORRALLM_OUTSIDE_TOKEN: w.token,
              CORRALLM_OUTSIDE_TOKEN_FILE: '',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString();
        });
        child.once('error', reject);
        child.once('exit', (code) => {
          const text = out.trim().split('\n').at(-1) ?? '';
          resolve({ code, line: text === '' ? undefined : (JSON.parse(text) as Waited['line']) });
        });
      });
    await w.call('message', { canvas: w.canvas, to: 'worker', body: 'please run it' });
    // Its waits end with what came; keep waiting until the record for the request comes.
    let after: string | undefined;
    let heard = '';
    for (let tries = 0; tries < 6 && !heard.includes('you may answer it once'); tries += 1) {
      const waited = await wait(20, after);
      expect([0, 1]).toContain(waited.code);
      after = waited.line?.next ?? after;
      heard += JSON.stringify(waited.line?.messages ?? []);
    }
    expect(heard).toContain('you may answer it once');

    const need = (await w.call('needs', { canvas: w.canvas })).items.find(
      (item) => item.kind === 'prompt' && item.agent === 'worker',
    );
    if (need === undefined) throw new Error('The request must still wait for an answer');
    expect(need.choices.map((choice) => choice.hint)).toContain('allow_once');
    expect(need.choices.map((choice) => choice.hint)).not.toContain('allow_always');
    await w.call('reply', { canvas: w.canvas, to: need.id, answer: { choice: 'allow' } });
    await expect
      .poll(async () =>
        (await w.call('needs', { canvas: w.canvas })).items.some((item) => item.id === need.id),
      )
      .toBe(false);
    // It answered, so it is not told that the request ended.
    const later = await wait(3, after);
    expect([0, 1], 'The final wait must receive messages or time out normally').toContain(
      later.code,
    );
    expect(later.line?.next, 'The final wait must return a valid cursor').toBeTruthy();
    expect(JSON.stringify(later.line?.messages ?? [])).not.toContain('no longer waits for you');
  } finally {
    await w.close();
  }
});
