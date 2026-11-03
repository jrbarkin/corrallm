import { describe, expect, it } from 'vitest';

import type { ConnectionDescriptor } from './adapter';
import { catalogOps } from './api/ops/catalog';
import { parseCommand, routeOf, routeRefusal } from './routing';
import type { RouteContext } from './routing';
import { MADE_UP, TWO_MADE_UP } from './test-made-up';

/*
 * B16 C2's one routing decision, over made-up adapters only: a connection that answers panels,
 * continues some commands (one only bare) and shell text in another connection whose prefix is
 * `$`, never a guessed `!`.
 */

const [, YAK] = TWO_MADE_UP.adapters as [unknown, { connections: ConnectionDescriptor[] }];
const [FREE, TERMINAL] = YAK.connections as [ConnectionDescriptor, ConnectionDescriptor];
/** Yak's transcript connection, continuing what it can't do in Yak's terminal. */
const CONTINUING: ConnectionDescriptor = {
  ...FREE,
  panels: { resume: true, rewind: { restores: ['conversation'] } },
  continueIn: {
    connection: TERMINAL.id,
    commands: [
      { name: 'login', description: 'Sign in', argumentHint: '' },
      { name: 'settings', description: 'Open settings', argumentHint: '', bare: true },
    ],
    shell: true,
    mcpSignIn: false,
  },
};
const context = (offered: string[] = []): RouteContext => ({
  connection: CONTINUING,
  target: TERMINAL,
  offered: offered.map((name) => ({ name, description: '', argumentHint: '' })),
});

describe('parseCommand', () => {
  it('reads a command’s name and what follows it, trimmed, across lines', () => {
    expect(parseCommand('  /settings  theme dark \n')).toEqual({
      name: 'settings',
      args: 'theme dark',
    });
    expect(parseCommand('/note first\nsecond')).toEqual({ name: 'note', args: 'first\nsecond' });
    expect(parseCommand('/usr/local/bin is a path')).toBeUndefined();
    expect(parseCommand('hello /resume')).toBeUndefined();
  });
});

describe('routeOf', () => {
  it('answers a declared panel first, even over a command the session offers', () => {
    expect(routeOf('/resume', context(['resume']))).toEqual({ kind: 'panel', panel: 'resume' });
    expect(routeOf(' /rewind later', context())).toEqual({ kind: 'panel', panel: 'rewind' });
    // Not declared: not a panel here.
    expect(routeOf('/mcp', context())).toEqual({ kind: 'send' });
    // The view's usable panels, where it passes them, are what it answers.
    expect(routeOf('/resume', { ...context(), panels: {} })).toEqual({ kind: 'send' });
  });

  it('continues only the commands its descriptor names, in the connection it names', () => {
    expect(routeOf('/login', context())).toMatchObject({
      kind: 'continue',
      connection: 'yak.terminal',
      command: { name: 'login' },
    });
    expect(routeOf('/login now', context())).toMatchObject({ kind: 'continue' });
    expect(routeOf('/config', context())).toEqual({ kind: 'send' });
  });

  it('lets a command the session offers win, except a bare-only one typed bare', () => {
    expect(routeOf('/login', context(['login']))).toEqual({ kind: 'command', name: 'login' });
    expect(routeOf('/settings', context(['settings']))).toMatchObject({
      kind: 'continue',
      command: { name: 'settings', bare: true },
    });
    expect(routeOf('  /settings  \n', context(['settings']))).toMatchObject({ kind: 'continue' });
    expect(routeOf('/settings theme dark', context(['settings']))).toEqual({
      kind: 'command',
      name: 'settings',
    });
    expect(routeOf('/settings theme\ndark', context(['settings']))).toEqual({
      kind: 'command',
      name: 'settings',
    });
    // Not offered by the session: continued with arguments too, as before.
    expect(routeOf('/settings theme dark', context())).toMatchObject({ kind: 'continue' });
  });

  it('continues shell text by its destination’s own prefix, never a guessed one', () => {
    expect(routeOf('  $ npm test', context())).toEqual({
      kind: 'shell',
      connection: 'yak.terminal',
      command: 'npm test',
    });
    expect(routeOf('!npm test', context())).toEqual({ kind: 'send' });
    // A destination with no prefix continues no shell text.
    expect(routeOf('$ npm test', { ...context(), target: FREE })).toEqual({ kind: 'send' });
    // Nor does a connection whose continuation takes none.
    expect(
      routeOf('$ npm test', {
        ...context(),
        connection: {
          ...CONTINUING,
          continueIn: {
            ...(CONTINUING.continueIn ?? { connection: '', commands: [] }),
            shell: false,
            mcpSignIn: false,
          },
        },
      }),
    ).toEqual({ kind: 'send' });
  });

  it('sends a session’s own command, and anything else, as typed', () => {
    expect(routeOf('/compact', context(['compact']))).toEqual({ kind: 'command', name: 'compact' });
    expect(routeOf('/compact', context())).toEqual({ kind: 'send' });
    expect(routeOf('/usr/local/bin is a path', context())).toEqual({ kind: 'send' });
    expect(routeOf('Fix the bug', context())).toEqual({ kind: 'send' });
  });

  it('routes an unfamiliar connection with no panels or continuation by its commands alone', () => {
    const [zed] = MADE_UP.adapters;
    const acp = zed?.connections[0];
    if (acp === undefined) throw new Error('No made-up connection');
    const plain = {
      connection: acp,
      offered: [{ name: 'login', description: '', argumentHint: '' }],
    };
    expect(routeOf('/resume', plain)).toEqual({ kind: 'send' });
    expect(routeOf('/login', plain)).toEqual({ kind: 'command', name: 'login' });
    expect(routeOf('$ ls', plain)).toEqual({ kind: 'send' });
  });
});

describe('routeRefusal', () => {
  const words = (text: string, offered: string[] = []) =>
    routeRefusal(routeOf(text, context(offered)), 'Builder', 'Yak Agent · Terminal');

  it('names a panel’s operations, and says a continuation runs only once you switch the agent', () => {
    expect(words('/resume')).toBe(
      'Builder’s /resume is answered by its view, never sent as a message: list its conversations with session.conversations and resume one with session.resumeConversation.',
    );
    expect(words('/rewind')).toMatch(/session\.rewindPreview.*session\.rewind\./);
    expect(words('/login')).toBe(
      '/login runs only in Builder’s Yak Agent · Terminal: it runs there once you switch the agent to it (session.continueIn), which only you do.',
    );
    expect(words('$ ls')).toBe(
      'That shell command runs only in Builder’s Yak Agent · Terminal: it runs there once you switch the agent to it (session.continueIn), which only you do.',
    );
  });

  it('refuses nothing it sends', () => {
    expect(words('/login', ['login'])).toBeUndefined();
    expect(words('/usr/bin')).toBeUndefined();
    expect(words('Hello')).toBeUndefined();
  });
});

describe('the strict catalog schema', () => {
  const output = catalogOps['catalog.get'].output;
  const withContinuation = (command: object) => ({
    adapters: [
      {
        ...TWO_MADE_UP.adapters[1],
        connections: [
          { ...CONTINUING, continueIn: { ...CONTINUING.continueIn, commands: [command] } },
        ],
      },
    ],
    usageBackends: [],
  });

  it('takes `bare: true` on a continuation command, and nothing else there', () => {
    const command = { name: 'settings', description: '', argumentHint: '' };
    expect(output.safeParse(withContinuation({ ...command, bare: true })).success).toBe(true);
    expect(output.safeParse(withContinuation({ ...command, bare: false })).success).toBe(false);
    expect(output.safeParse(withContinuation({ ...command, run: 'rm -rf /' })).success).toBe(false);
  });
});
