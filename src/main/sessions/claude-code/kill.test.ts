import { auditKill } from '../test-kill';
import { CommandHooks, CommandPty } from '../terminal/test-command';
import { TerminalSession, TIMING } from '../terminal/session';
import { ClaudeCode } from './claude-code';

auditKill('claude-code', 'claude-code.terminal', (folder, log) => ({
  start: async (spec, host) => {
    const hooks = new CommandHooks();
    const session = new TerminalSession(spec, host, {
      executable: '/fake/native',
      cli: new ClaudeCode({ cwd: spec.cwd, home: folder, env: {} }),
      hooks,
      tmp: folder,
      env: () => ({}),
      timing: { ...TIMING, key: 0, enter: 1, settle: 5, batch: 1, kill: 300 },
      spawn: () =>
        Promise.resolve(
          new CommandPty(log, hooks, (draft, state) => {
            const rule = '─'.repeat(40);
            return `\x1b]7501;state=${state}\x07\x1b[H\x1b[2JClaude Code (fake)\r\n\r\n${rule}\r\n❯ ${draft === '' ? '\x1b[2mTry "fix lint errors"\x1b[22m' : draft}\r\n${rule}\r\n? for shortcuts`;
          }),
        ),
    });
    await session.launch();
    return session;
  },
}));
