import { describe, expect, it } from 'vitest';

import { HOOK_HEADER, HOOK_TOKEN } from '../terminal/hooks';
import { hookSettings } from './hooks';

describe('hookSettings', () => {
  it('uses a private header file in its Bash command hook, including Git Bash on Windows', () => {
    const settings = hookSettings('http://127.0.0.1:4000/hook', 'secret');
    const command = settings.hooks.SessionStart?.[0]?.hooks[0]?.command;
    expect(command).toContain(`-H "@$${HOOK_HEADER}"`);
    expect(command).not.toContain('secret');
    expect(command).not.toContain(HOOK_TOKEN);
  });
  it('posts the events corrallm follows to its server, with the token from its private settings', () => {
    const settings = hookSettings('http://127.0.0.1:4000/hook', 'secret');
    expect(Object.keys(settings.hooks)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
      'StopFailure',
      'SessionEnd',
      'PostModelSwitch',
      'PermissionRequest',
      'Notification',
      'PreToolUse',
    ]);
    expect(settings.hooks.SessionStart?.[0]?.hooks[0]).toMatchObject({
      type: 'command',
      timeout: 10,
    });
    expect(settings.hooks.SessionStart?.[0]?.hooks[0]?.command).toContain('--data-binary @-');
    // Before a tool runs, only the two that ask the user: its questions, and a plan to approve.
    expect(settings.hooks.PreToolUse).toEqual([
      { matcher: 'AskUserQuestion|ExitPlanMode', hooks: settings.hooks.Stop?.[0]?.hooks },
    ]);
    expect(settings.hooks.Stop).toEqual([
      {
        hooks: [
          {
            type: 'http',
            url: 'http://127.0.0.1:4000/hook',
            headers: { Authorization: 'Bearer secret' },
            timeout: 5,
          },
        ],
      },
    ]);
  });

  it('tells Claude Code to wait 30 s for the one hook corrallm may hold, 5 s for every other', () => {
    const settings = hookSettings('http://127.0.0.1:4000/hook', 'secret');
    const timeouts = Object.fromEntries(
      Object.entries(settings.hooks).map(([name, groups]) => [
        name,
        groups.flatMap((group) => group.hooks.map((hook) => hook.timeout)),
      ]),
    );
    expect(timeouts.PermissionRequest).toEqual([30]);
    expect(timeouts.SessionStart).toEqual([10]);
    for (const name of Object.keys(timeouts).filter(
      (one) => one !== 'PermissionRequest' && one !== 'SessionStart',
    )) {
      expect(timeouts[name], name).toEqual([5]);
    }
  });
});
