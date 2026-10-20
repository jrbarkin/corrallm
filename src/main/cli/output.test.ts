import { afterEach, expect, it, vi } from 'vitest';

import { writtenOut } from './output';

afterEach(() => vi.useRealTimers());

it('waits for a pipe after the terminal’s cap expires', async () => {
  vi.useFakeTimers();
  let pipeWritten: () => void = () => undefined;
  let finished = false;
  const draining = writtenOut([
    { isTTY: true, write: () => undefined },
    {
      write: (_text, done) => {
        pipeWritten = done;
      },
    },
  ]).then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(1600);
  expect(finished).toBe(false);
  pipeWritten();
  await draining;
  expect(finished).toBe(true);
});

it('caps the terminal once a pipe is written, and finishes early when both drain', async () => {
  vi.useFakeTimers();
  let terminalWritten: () => void = () => undefined;
  let finished = false;
  const draining = writtenOut([
    {
      isTTY: true,
      write: (_text, done) => {
        terminalWritten = done;
      },
    },
    {
      write: (_text, done) => {
        done();
      },
    },
  ]).then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(999);
  expect(finished).toBe(false);
  terminalWritten();
  await draining;
  expect(vi.getTimerCount()).toBe(0);
  finished = false;
  const capped = writtenOut([{ isTTY: true, write: () => undefined }]).then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(1000);
  await capped;
  expect(finished).toBe(true);
});
import { spawn } from 'node:child_process';
import path from 'node:path';

it.skipIf(process.platform === 'win32')(
  'prints all of wait’s JSON to a slow pipe when stderr is a terminal',
  async () => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        `data:text/javascript,${encodeURIComponent("Object.defineProperty(process.stderr, 'isTTY', { value: true });")}`,
        path.resolve('dist-cli/corrallm.cjs'),
        'wait',
        '--for',
        '\x01'.repeat(100_000),
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stdout.pause();
    const ended = new Promise<void>((resolve) => child.stdout.on('end', resolve));
    const exited = new Promise<number | null>((resolve, reject) => {
      child.on('exit', resolve);
      child.on('error', reject);
    });
    try {
      await new Promise<void>((resolve) => child.stdout.once('readable', resolve));
      await new Promise((resolve) => setTimeout(resolve, 1500));
      child.stdout.resume();
      await ended;
      expect(await exited).toBe(64);
      expect(output.endsWith('\n')).toBe(true);
      expect(JSON.parse(output)).toMatchObject({ error: { code: 'invalid' } });
      expect(output.length).toBeGreaterThan(600_000);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  },
  10_000,
);
