import { describe, expect, it } from 'vitest';

import { HOOK_TOKEN } from '../terminal/hooks';
import { hookSettings } from './hooks';

describe('hookSettings', () => {
  it('posts the events corrallm follows to its server, with the token from the environment', () => {
    const settings = hookSettings('http://127.0.0.1:4000/hook');
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
            headers: { Authorization: `Bearer $${HOOK_TOKEN}` },
            allowedEnvVars: [HOOK_TOKEN],
            timeout: 5,
          },
        ],
      },
    ]);
  });
});
