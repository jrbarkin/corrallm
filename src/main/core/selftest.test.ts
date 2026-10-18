import { fork } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  checkAgentSdk,
  checkForkRefused,
  checkLoopbackHttp,
  checkSpawn,
  checkTerminalScreen,
  runChecks,
  selfTestChecks,
} from './selftest';

/*
 * The native self-test's checks, run here as they run in the packaged app's main process, in its
 * core process and in the CLI bundle, so that a change to the Agent SDK's protocol, the terminal's
 * screen or what the core needs of Node breaks them here first. node-pty's check is not run here:
 * unit tests never load native modules.
 */

describe('the native self-test', () => {
  it('finds a copy of a terminal screen working', async () => {
    await expect(checkTerminalScreen()).resolves.toBe('@xterm/headless ok (40×5)');
  });

  it('starts an Agent SDK query on its own fake claude, and hears its result', async () => {
    await expect(checkAgentSdk()).resolves.toBe('Agent SDK ok (the fake claude said “ok”)');
  });

  it('fails when the fake claude cannot run', async () => {
    await expect(checkAgentSdk({ PATH: '/nowhere' })).rejects.toThrow();
  });

  it('serves HTTP on 127.0.0.1 and calls it, as the hook and MCP servers are called', async () => {
    await expect(checkLoopbackHttp()).resolves.toMatch(/^loopback HTTP ok \(127\.0\.0\.1:\d+\)$/);
  });

  it('spawns a child process and reads what it printed', async () => {
    await expect(checkSpawn()).resolves.toMatch(/^spawn ok \(pid \d+, exit 0\)$/);
  });

  it('passes where child_process.fork throws, as the RunAsNode fuse makes it', async () => {
    const refusing = () => {
      throw new Error('fork is not supported');
    };

    await expect(checkForkRefused(refusing)).resolves.toBe(
      'child_process.fork refused (fork is not supported)',
    );
  });

  it('fails where child_process.fork starts a process, as plain Node does', async () => {
    await expect(checkForkRefused(fork)).rejects.toThrow(
      'child_process.fork started a process: the RunAsNode fuse is off?',
    );
  });

  it('checks child_process.fork only in a packaged app, whose fuses refuse it', () => {
    const names = (packaged: boolean) => selfTestChecks({ packaged }).map(({ name }) => name);

    expect(names(false)).toEqual([
      'node-pty',
      'terminal screen',
      'Agent SDK',
      'loopback HTTP',
      'spawn',
    ]);
    expect(names(true)).toEqual([...names(false), 'child_process.fork']);
  });

  it('runs every check, reporting each one’s result or failure', async () => {
    const results = await runChecks([
      { name: 'first', run: () => Promise.resolve('first ok') },
      { name: 'second', run: () => Promise.reject(new Error('it broke')) },
      { name: 'third', run: () => Promise.resolve('third ok') },
    ]);

    expect(results).toEqual([
      { name: 'first', ok: true, said: 'first ok' },
      { name: 'second', ok: false, said: 'second failed: it broke' },
      { name: 'third', ok: true, said: 'third ok' },
    ]);
  });
});
