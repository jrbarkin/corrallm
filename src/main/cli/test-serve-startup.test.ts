import { PassThrough } from 'node:stream';

import { expect, it, vi } from 'vitest';

import { waitForServing } from './test-serve-startup';

const API = { url: 'http://127.0.0.1:12345/mcp', pid: 12345 };
const LINE =
  'corrallm serve: serving m1.corral (one), m1.corral (two) at http://127.0.0.1:12345/mcp\n';
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(initial = '') {
  const output = new PassThrough();
  let text = initial;
  output.on('data', (chunk: Buffer) => {
    text += chunk.toString();
  });
  const api = Promise.withResolvers<typeof API>();
  const exited = Promise.withResolvers<number | null>();
  const ready = vi.fn();
  const failed = vi.fn();
  const started = waitForServing(api.promise, exited.promise, output, () => text);
  void started.then(ready, failed);
  return { output, api, exited, ready, failed, started };
}

it('waits after api.json is readable until the whole serving line arrives, even in chunks', async () => {
  const { api, output, started, ready } = setup();
  api.resolve(API);
  output.write('corrallm serve: a notice mentioning corrallm serve: serving something\n');
  await turn();
  expect(ready).not.toHaveBeenCalled();
  output.write('corrallm serve: serv');
  await turn();
  expect(ready).not.toHaveBeenCalled();
  output.write('ing m1.corral (one), m1.corral (two) at http://127.0.0.1:12345/mcp');
  await turn();
  expect(ready).not.toHaveBeenCalled();
  output.write('\n');
  await expect(started).resolves.toEqual(API);
  expect(output.listenerCount('data')).toBe(1);
});

it('still waits for api.json when the serving line arrives first', async () => {
  const { api, output, started, ready } = setup();
  output.write(LINE);
  await turn();
  expect(ready).not.toHaveBeenCalled();
  api.resolve(API);
  await expect(started).resolves.toEqual(API);
});

it('recognizes a serving line captured before the waiter attaches', async () => {
  const { api, started } = setup(LINE);
  api.resolve(API);
  await expect(started).resolves.toEqual(API);
});

it.each([false, true])(
  'rejects an exit with its diagnostic (api.json readable: %s)',
  async (published) => {
    const { api, output, exited, started } = setup();
    const rejected = expect(started).rejects.toThrow(
      'serve exited 1 before serving: The port is taken.',
    );
    if (published) api.resolve(API);
    output.write('The port is taken.\n');
    exited.resolve(1);
    await rejected;
    expect(output.listenerCount('data')).toBe(1);
  },
);

it('preserves an api.json read failure and removes its startup listener', async () => {
  const { api, output, started } = setup();
  const rejected = expect(started).rejects.toThrow('api.json is unreadable');
  api.reject(new Error('api.json is unreadable'));
  await rejected;
  expect(output.listenerCount('data')).toBe(1);
});
