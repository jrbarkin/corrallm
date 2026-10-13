import { describe, expect, it } from 'vitest';

import type { CodexMode } from '../../../../shared/session';
import type { TerminalSignal } from '../../terminal/cli';
import type { HookRegistration } from '../../terminal/hooks';
import type { ProgramStatus } from '../../terminal/status';
import { computedTrust } from './hooks';
import { RECORDED_SESSION, recordedScreen, recordedTerminal } from './recorded';
import { CodexTui, PASTE_END, PASTE_START, pasteable } from './tui';

const HOOKS: HookRegistration = {
  url: 'http://127.0.0.1:4000/hook',
  token: 'secret',
  release: () => undefined,
};

async function prepared(): Promise<CodexTui> {
  const tui = new CodexTui({
    trust: (hooks) => Promise.resolve(computedTrust(hooks)),
    platform: 'darwin',
  });
  await tui.prepare('/tmp/session', HOOKS);
  return tui;
}

const LAUNCH = {
  dir: '/tmp/session',
  id: null,
  resume: false,
  model: null,
  mode: 'auto' as const,
  cwd: '/work/shop',
};

/** The values of its `-c` overrides. */
const overrides = (args: readonly string[]) =>
  args.flatMap((arg, i) => (args[i - 1] === '-c' ? [arg] : []));

describe('starting Codex', () => {
  it('runs its own agent in the project folder, with corrallm’s overrides for this session only', async () => {
    const args = (await prepared()).args(LAUNCH);
    expect(args.slice(0, 3)).toEqual(['--no-daemon', '-C', '/work/shop']);
    const values = overrides(args);
    expect(values).toContain('projects={"/work/shop"={trust_level="trusted"}}');
    expect(values).toContain('tui.terminal_title=["activity","run-state"]');
    expect(values).toContain('check_for_update_on_startup=false');
    expect(values).toContain('tui.auto_recap=false');
    // Its hooks post to corrallm's server, and are trusted for the session.
    const hooks = values.filter(
      (value) => /^hooks\.\w+=/.test(value) && !value.startsWith('hooks.state'),
    );
    expect(hooks.map((value) => value.split('=')[0])).toEqual([
      'hooks.UserPromptSubmit',
      'hooks.Stop',
      'hooks.Interrupt',
    ]);
    for (const hook of hooks) expect(hook).toContain('http://127.0.0.1:4000/hook');
    const state = values.find((value) => value.startsWith('hooks.state='));
    expect(state).toContain('"/<session-flags>/config.toml:stop:0:0"={trusted_hash="sha256:');
    // Nothing else: Default leaves the user's own sandbox and approvals be.
    expect(args.filter((arg) => arg.startsWith('-') && arg !== '-c')).toEqual([
      '--no-daemon',
      '-C',
    ]);
  });

  it('resumes a session by its id', async () => {
    const args = (await prepared()).args({ ...LAUNCH, id: 'thread-1', resume: true });
    expect(args.slice(0, 5)).toEqual(['resume', 'thread-1', '--no-daemon', '-C', '/work/shop']);
  });

  it('starts in the mode and with the model corrallm chose', async () => {
    const tui = await prepared();
    expect(tui.args({ ...LAUNCH, mode: 'read-only' }).slice(-4)).toEqual([
      '-s',
      'read-only',
      '-a',
      'on-request',
    ]);
    expect(tui.args({ ...LAUNCH, mode: 'full-access' }).slice(-4)).toEqual([
      '-s',
      'danger-full-access',
      '-a',
      'never',
    ]);
    // Plan is chosen in its terminal (Shift+Tab), with Default's permissions.
    expect(tui.args({ ...LAUNCH, mode: 'plan' })).not.toContain('-s');
    expect(tui.args({ ...LAUNCH, model: 'gpt-6-luna' }).slice(-2)).toEqual(['-m', 'gpt-6-luna']);
  });

  it('starts with the reasoning effort corrallm chose, and otherwise the user’s own', async () => {
    expect(overrides((await prepared()).args(LAUNCH)).join(' ')).not.toContain('reasoning');
    const tui = new CodexTui({
      trust: (hooks) => Promise.resolve(computedTrust(hooks)),
      platform: 'darwin',
      effort: 'xhigh',
    });
    await tui.prepare('/tmp/session', HOOKS);
    expect(overrides(tui.args(LAUNCH))).toContain('model_reasoning_effort="xhigh"');
  });

  it('knows when a session it resumes is gone', async () => {
    const tui = await prepared();
    const screen = await recordedScreen('resume-missing', Infinity);
    expect(tui.resumeFailed(screen.text())).toBe(true);
    expect(tui.resumeFailed('OpenAI Codex (v0.160.1)')).toBe(false);
    screen.dispose();
  });
});

/** What a CodexTui makes of the recorded session's titles and hooks, in the order they came. */
async function replayed(): Promise<(ProgramStatus | TerminalSignal<CodexMode> | 'holds')[]> {
  const tui = await prepared();
  const seen: (ProgramStatus | TerminalSignal<CodexMode> | 'holds')[] = [];
  let previous: string | undefined;
  for (const record of recordedTerminal('prompts')) {
    if (record.kind === 'title') {
      const report = tui.title(record.data);
      // The spinner turns many times a second: one of each.
      const said = JSON.stringify(report ?? (tui.holds() ? 'holds' : null));
      if (said !== previous && said !== 'null') seen.push(report ?? 'holds');
      previous = said;
    } else if (record.kind === 'hook') {
      seen.push(...tui.hook(record.data.ev));
      previous = undefined;
    }
  }
  return seen;
}

describe('following Codex', () => {
  it('reads what its title and hooks say, as the real Codex said it', async () => {
    expect(await replayed()).toEqual([
      // Ready, then its MCP servers start: a message sent meanwhile is held.
      { state: 'idle' },
      'holds',
      { state: 'working' },
      // Its SessionStart hook (the recording had it), then UserPromptSubmit.
      { kind: 'session', id: RECORDED_SESSION },
      { kind: 'model', model: 'gpt-6-luna' },
      { kind: 'session', id: RECORDED_SESSION },
      { kind: 'prompt', text: 'Say hi in one word.' },
      { state: 'working' },
      { kind: 'session', id: RECORDED_SESSION },
      { kind: 'reply', text: 'Hi' },
      { state: 'done' },
      { state: 'working' },
      { kind: 'session', id: RECORDED_SESSION },
      { kind: 'prompt', text: 'Create a file named bye.txt containing the word bye.' },
      { state: 'working' },
      // The command's approval (its PermissionRequest hook tells nothing corrallm needs).
      { kind: 'session', id: RECORDED_SESSION },
      { state: 'blocked' },
      { state: 'working' },
      { kind: 'session', id: RECORDED_SESSION },
      { kind: 'reply', text: 'Created [bye.txt](/work/smoke/p2/bye.txt) with the word `bye`.' },
      { state: 'done' },
    ]);
  });

  it('takes a turn that ends without its Stop hook for one that failed', async () => {
    const tui = await prepared();
    expect(tui.title('⠋ Working')).toEqual({ state: 'working' });
    tui.hook({ session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
    expect(tui.title('Ready')).toMatchObject({ state: 'error' });
    // The next turn starts clean.
    expect(tui.title('⠙ Working')).toEqual({ state: 'working' });
    tui.hook({ session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: 'again' });
    tui.hook({ session_id: 's', hook_event_name: 'Interrupt', turn_id: 't' });
    expect(tui.title('Ready')).toEqual({ state: 'idle' });
    // A turn its hooks did not tell of (a slash command's) just ends.
    expect(tui.title('⠹ Thinking')).toEqual({ state: 'working' });
    expect(tui.title('Ready')).toEqual({ state: 'done' });
  });

  it('leaves out a subagent’s hooks, and a model it already said', async () => {
    const tui = await prepared();
    expect(
      tui.hook({ session_id: 'child', agent_id: 'a1', hook_event_name: 'Stop', model: 'm' }),
    ).toEqual([]);
    expect(tui.hook({ session_id: 's', hook_event_name: 'Stop', model: 'gpt-6-luna' })).toEqual([
      { kind: 'session', id: 's' },
      { kind: 'model', model: 'gpt-6-luna' },
    ]);
    expect(tui.hook({ session_id: 's', hook_event_name: 'Stop', model: 'gpt-6-luna' })).toEqual([
      { kind: 'session', id: 's' },
    ]);
  });
});

describe('Codex’s composer', () => {
  it('reads what is typed in it, as the real Codex drew it', async () => {
    const tui = await prepared();
    const at = async (t: number) => {
      const screen = await recordedScreen('prompts', t);
      const draft = tui.draft(screen);
      screen.dispose();
      return draft;
    };
    // Before its title says anything, it is not ready for a message.
    expect(await at(2100)).toBeUndefined();
    tui.title('Ready');
    // Its placeholder shows; then the pasted message; then it works with the composer empty.
    expect(await at(2400)).toBe('');
    expect(await at(2900)).toBe('Say hi in one word.');
    expect(await at(3500)).toBe('');
    // A command's approval: its choices are not the composer.
    expect(await at(17_080)).toBeUndefined();
    expect(await at(23_678)).toBe('');
  });

  it('reads it unshaded too, as Codex draws it when no terminal said what its background is', async () => {
    const tui = await prepared();
    tui.title('Ready');
    // Main's copy of the screen does not answer Codex's question about the background colour.
    const unshaded = (data: string) => data.replace(/48;2;\d+;\d+;\d+/g, '49');
    for (const [t, draft] of [
      [2400, ''],
      [2900, 'Say hi in one word.'],
      [17_080, undefined],
    ] as const) {
      const screen = await recordedScreen('prompts', t, unshaded);
      expect(tui.draft(screen)).toBe(draft);
      screen.dispose();
    }
  });

  it('takes a message pasted in, as nothing but text', async () => {
    const tui = await prepared();
    expect(tui.keystrokes('Fix it\r\nthen test')).toEqual([
      `${PASTE_START}Fix it\nthen test${PASTE_END}`,
    ]);
    // An escape in it would end the paste: control characters go.
    expect(pasteable(`a${PASTE_END}b\x07c\td`)).toBe('a[201~bc\td');
    expect(tui.keystrokes('  \n ')).toEqual([]);
    expect(tui.submitted(' Fix it\r\n')).toBe('Fix it');
  });
});
