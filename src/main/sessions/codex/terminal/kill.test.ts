import { auditKill } from '../../test-kill';
import { CommandHooks, CommandPty } from '../../terminal/test-command';
import { TerminalSession, TIMING } from '../../terminal/session';
import { CodexTui } from './tui';

auditKill('codex', 'codex.terminal', (folder, log) => ({
  start: async (spec, host) => {
    const hooks = new CommandHooks();
    const session = new TerminalSession({ ...spec, mode: 'auto' }, host, {
      executable: '/fake/native',
      cli: new CodexTui({ trust: () => Promise.resolve(new Map()) }),
      hooks,
      tmp: folder,
      env: () => ({}),
      timing: { ...TIMING, key: 0, enter: 1, settle: 5, batch: 1, kill: 300 },
      spawn: () =>
        Promise.resolve(
          new CommandPty(
            log,
            hooks,
            (draft, state) =>
              `\x1b]0;${state === 'working' ? '⠋ Working' : 'Ready'}\x07\x1b[H\x1b[2J\x1b[26;1H› ${draft === '' ? '\x1b[2mAsk Codex to do anything\x1b[22m' : draft}\x1b[26;${String(3 + draft.length)}H\x1b[?25h`,
          ),
        ),
    });
    await session.launch();
    return session;
  },
}));
