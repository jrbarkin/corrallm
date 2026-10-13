import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MODEL_PATTERN, PERMISSION_MODES } from '../../../shared/session';
import type { PermissionMode } from '../../../shared/session';
import type { Launch, TerminalCli, TerminalSignal } from './cli';
import { hookSettings } from './hooks';
import type { HookEvent, HookRegistration } from './hooks';
import type { Screen } from './screen';
import { keystrokes, typeable } from './typing';

/*
 * Claude Code, as a Terminal session runs it (cli.ts). It starts with --settings (a file in the
 * session's folder: corrallm's HTTP hooks, merged with the user's), --session-id (new) or --resume
 * (one with no transcript starts afresh under the same id), and --model/--permission-mode only
 * when corrallm chose them (Manual is left to the user's own default). Its screen reports its
 * state (Program Status, OSC 7501: read by the session's screen) and shows its prompt box (whose
 * draft screen.ts reads); its hooks tell its session id, the prompts it took, its last reply, why
 * a turn failed, its mode and its model. A message is typed in as a person would (typing.ts).
 */

/** The settings file in the session's folder. */
const SETTINGS = 'settings.json';

export class ClaudeCode implements TerminalCli<PermissionMode> {
  readonly name = 'Claude Code';
  readonly words = {
    answer: 'Answer Claude Code in its terminal.',
    mode: 'Switch modes in Claude Code’s terminal (Shift+Tab).',
    model: 'Switch models in Claude Code’s terminal (/model).',
    login: 'Claude Code needs you to log in: run /login in its terminal.',
  };

  newId(): string {
    return randomUUID();
  }

  async prepare(dir: string, hooks: HookRegistration): Promise<void> {
    await writeFile(path.join(dir, SETTINGS), JSON.stringify(hookSettings(hooks.url)), {
      mode: 0o600,
    });
  }

  args({ dir, id, resume, model, mode }: Launch<PermissionMode>): string[] {
    return [
      '--settings',
      path.join(dir, SETTINGS),
      ...(id === null ? [] : resume ? ['--resume', id] : ['--session-id', id]),
      ...(model === null ? [] : ['--model', model]),
      // Manual is Claude Code's default: the user's own default mode (their settings) applies.
      ...(mode === 'manual' ? [] : ['--permission-mode', mode]),
    ];
  }

  resumeFailed(screen: string): boolean {
    return /No conversation found/i.test(screen);
  }

  hook(event: HookEvent): TerminalSignal<PermissionMode>[] {
    const text = (key: string) => {
      const value = event[key];
      return typeof value === 'string' ? value : undefined;
    };
    const signals: TerminalSignal<PermissionMode>[] = [];
    const id = text('session_id');
    if (id !== undefined) signals.push({ kind: 'session', id });
    const mode = modeOf(text('permission_mode'));
    if (mode !== undefined) signals.push({ kind: 'mode', mode });
    switch (text('hook_event_name')) {
      case 'UserPromptSubmit':
        signals.push(
          { kind: 'prompt', text: text('prompt') ?? '' },
          { kind: 'state', state: 'working' },
        );
        break;
      case 'Stop': {
        const reply = text('last_assistant_message');
        if (reply !== undefined) signals.push({ kind: 'reply', text: reply });
        signals.push({ kind: 'state', state: 'done' });
        break;
      }
      case 'StopFailure':
        signals.push(
          {
            kind: 'failed',
            why: text('error_details') ?? text('last_assistant_message') ?? text('error'),
          },
          { kind: 'state', state: 'error' },
        );
        break;
      case 'SessionEnd':
        // /clear: the session goes on under a new id, which its next hook tells.
        if (text('reason') === 'clear') signals.push({ kind: 'cleared' });
        break;
      case 'PostModelSwitch': {
        const model = text('to_model');
        if (model !== undefined && MODEL_PATTERN.test(model))
          signals.push({ kind: 'model', model });
        break;
      }
    }
    return signals;
  }

  draft(screen: Screen): string | undefined {
    return screen.draft();
  }

  keystrokes(text: string): string[] {
    return keystrokes(text);
  }

  submitted(text: string): string {
    return typeable(text).trim();
  }
}

/** A permission mode as Claude Code's hooks name it ('default' is Manual). */
function modeOf(name: string | undefined): PermissionMode | undefined {
  if (name === 'default') return 'manual';
  return PERMISSION_MODES.find((mode) => mode === name);
}
