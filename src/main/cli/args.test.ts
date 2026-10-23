import { describe, expect, it } from 'vitest';

import { parseCommand, UsageError } from './args';

/*
 * `corrallm serve` and `corrallm wait`'s command lines (API Spec §8.6). What they take is checked
 * here, before anything runs: no folder (folder trust is the app's), and never a token.
 */

const ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('parseCommand', () => {
  it('reads a read-only dump of the app profile or an explicit profile', () => {
    expect(parseCommand(['dump'])).toEqual({ command: 'dump' });
    expect(parseCommand(['dump', '--profile', '/a profile'])).toEqual({
      command: 'dump',
      profile: '/a profile',
    });
    expect(() => parseCommand(['dump', '--canvas', 'a.corral'])).toThrow(/--canvas/);
    expect(() => parseCommand(['dump', 'extra'])).toThrow(/extra/);
  });
  it('reads serve: its canvases, profile and port', () => {
    expect(
      parseCommand([
        'serve',
        '--canvas',
        'm1.corral',
        '--canvas',
        'worker.corral',
        '--port',
        '47000',
      ]),
    ).toEqual({ command: 'serve', canvases: ['m1.corral', 'worker.corral'], port: 47000 });
    expect(parseCommand(['serve', '--canvas=m1.corral', '--profile', '/p'])).toEqual({
      command: 'serve',
      canvases: ['m1.corral'],
      profile: '/p',
    });
    expect(parseCommand(['serve', '--canvas', 'm1.corral', '--port', '0'])).toMatchObject({
      port: 0,
    });
  });

  it('reads a new token: named orchestrator, for an hour, read-write, unless told otherwise', () => {
    expect(parseCommand(['serve', '--canvas', 'm1.corral', '--new-token'])).toMatchObject({
      newToken: { name: 'orchestrator', hours: 1, access: 'write' },
    });
    expect(
      parseCommand([
        'serve',
        '--canvas',
        'm1.corral',
        '--new-token',
        '--name',
        'watcher',
        '--hours',
        '12',
        '--read-only',
      ]),
    ).toMatchObject({ newToken: { name: 'watcher', hours: 12, access: 'read' } });
  });

  it('refuses what serve doesn’t take, saying why', () => {
    const refused = (args: string[], why: RegExp) => {
      expect(() => parseCommand(args)).toThrow(UsageError);
      expect(() => parseCommand(args)).toThrow(why);
    };
    refused(['serve'], /--canvas/);
    // Folder trust is the app's: there is no --project.
    refused(['serve', '--canvas', 'm1.corral', '--project', '/work'], /--project/);
    refused(['serve', '--canvas', 'm1.corral', '--name', 'x'], /--new-token/);
    refused(['serve', '--canvas', 'm1.corral', '--hours', '2'], /--new-token/);
    refused(['serve', '--canvas', 'm1.corral', '--read-only'], /--new-token/);
    for (const hours of ['0', '13', '1.5', 'two']) {
      refused(['serve', '--canvas', 'm1.corral', '--new-token', '--hours', hours], /1 to 12/);
    }
    for (const name of ['two words', '-x', '9lives', 'x'.repeat(33)]) {
      refused(['serve', '--canvas', 'm1.corral', '--new-token', '--name', name], /--name/);
    }
    for (const port of ['65536', '-1', 'http', '1.5']) {
      refused(['serve', '--canvas', 'm1.corral', '--port', port], /--port/);
    }
    refused(['serve', '--canvas', 'm1.corral', 'extra'], /extra/);
  });

  it('reads wait: what for, from where, for how long (an hour at most, and by default)', () => {
    expect(parseCommand(['wait'])).toEqual({ command: 'wait', timeout: 3600 });
    expect(
      parseCommand(['wait', '--for', ID, '--after', 'eyJhIjoxfQ', '--timeout', '900']),
    ).toEqual({ command: 'wait', for: ID, after: 'eyJhIjoxfQ', timeout: 900 });
    expect(parseCommand(['wait', '--timeout', '0'])).toMatchObject({ timeout: 0 });
  });

  it('refuses what wait doesn’t take: never a token on its command line', () => {
    expect(() => parseCommand(['wait', '--token', 'secret'])).toThrow(/--token/);
    expect(() => parseCommand(['wait', '--timeout', '3601'])).toThrow(/--timeout/);
    expect(() => parseCommand(['wait', '--timeout', 'soon'])).toThrow(/--timeout/);
    expect(() => parseCommand(['wait', '--for', 'not-an-id'])).toThrow(/--for/);
  });

  it('refuses a command it doesn’t have', () => {
    expect(() => parseCommand([])).toThrow(UsageError);
    expect(() => parseCommand(['run'])).toThrow(/run/);
  });
});
