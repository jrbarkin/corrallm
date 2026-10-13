import { randomUUID } from 'node:crypto';
import { realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  MAX_ANSWER_LENGTH,
  MAX_QUESTIONS,
  MODEL_PATTERN,
  PERMISSION_MODES,
} from '../../../shared/session';
import type { PermissionMode, TerminalAsk } from '../../../shared/session';
import type { UsageWindows } from '../../../shared/usage';
import { askedQuestions } from '../sdk/prompts';
import { property, text as textOf, toolSummary } from '../sdk/tools';
import type { Places } from '../sdk/tools';
import type { Launch, TerminalCli, TerminalSignal } from './cli';
import { hookSettings } from './hooks';
import type { HookEvent, HookRegistration } from './hooks';
import type { Screen } from './screen';
import { statusLineSettings, statusLineUsage } from './statusline';
import { keystrokes, typeable } from './typing';

/*
 * Claude Code, as a Terminal session runs it (cli.ts). It starts with --settings (a file in the
 * session's folder: corrallm's HTTP hooks, merged with the user's, and corrallm's status line,
 * which reads its usage limits and runs the user's own: statusline.ts), --session-id (new) or --resume
 * (one with no transcript starts afresh under the same id), and --model/--permission-mode only
 * when corrallm was given them (otherwise the user's own default model and mode apply). Its screen
 * reports its state (Program Status, OSC 7501: read by the session's screen) and shows its prompt
 * box (whose draft screen.ts reads); its hooks tell its session id, the prompts it took, its last
 * reply, why a turn failed, its mode and its model, and what it is about to ask the user in its
 * terminal (a permission prompt and what it is for, its questions, a plan to approve, what its
 * notifications say it needs). A message is typed in as a person would (typing.ts).
 */

/** The settings file in the session's folder. */
const SETTINGS = 'settings.json';
/** Notifications that Claude Code needs the user (not that it is idle, or done). */
const NEEDS_YOU = new Set([
  'permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
]);
/** At most this much of a notification is listed. */
const MAX_ASK_TEXT = 2000;
const LOGIN = 'Claude Code needs you to log in: run /login in its terminal.';

export interface ClaudeCodeOptions {
  /** The project folder it works in: its asks show the files in it relative to it. */
  cwd: string;
  /** The user's home folder: where the files it asks about are shown from (as ~), outside it. */
  home: string;
  /** Its environment (the agents'), which finds the user's own status line. */
  env: Readonly<Record<string, string>>;
}

export class ClaudeCode implements TerminalCli<PermissionMode> {
  readonly name = 'Claude Code';
  readonly words = {
    answer: 'Answer Claude Code in its terminal.',
    mode: 'Switch modes in Claude Code’s terminal (Shift+Tab).',
    model: 'Switch models in Claude Code’s terminal (/model).',
    login: LOGIN,
    waiting: {
      permission: 'Claude Code asks for your permission.',
      question: 'Claude Code asks you something.',
      auth: LOGIN,
      none: 'Claude Code is waiting for you.',
    },
  };
  /** Manual, as Claude Code calls its default mode. */
  readonly defaultMode = 'manual';
  /**
   * Enter once its prompt shows what was typed: keys that pile up while it is busy (just after
   * its folder trust dialog, or as a turn ends) are read in one go, as a paste, and 2.1.296 keeps
   * an Enter among them as an invisible character, not a submit.
   */
  readonly waitsForEcho = true;
  /** Where it works, for the files its asks are about. */
  #places: Places;
  readonly #env: Readonly<Record<string, string>>;

  constructor({ cwd, home, env }: ClaudeCodeOptions) {
    this.#places = { cwd, home };
    this.#env = env;
  }

  newId(): string {
    return randomUUID();
  }

  async prepare(dir: string, hooks: HookRegistration): Promise<void> {
    // It works in the folder's real path (a folder reached through a link).
    const { cwd } = this.#places;
    const realCwd = await realpath(cwd).catch(() => cwd);
    if (realCwd !== cwd) this.#places = { ...this.#places, realCwd };
    // corrallm's status line, which wraps the user's own, reports Claude Code's usage limits.
    const statusLine = await statusLineSettings({
      dir,
      url: hooks.statusUrl,
      token: hooks.token,
      env: this.#env,
      cwd,
    });
    await writeFile(
      path.join(dir, SETTINGS),
      JSON.stringify({ ...hookSettings(hooks.url), ...statusLine }),
      { mode: 0o600 },
    );
  }

  args({ dir, id, resume, model, mode }: Launch<PermissionMode>): string[] {
    return [
      '--settings',
      path.join(dir, SETTINGS),
      ...(id === null ? [] : resume ? ['--resume', id] : ['--session-id', id]),
      // Only what corrallm was given: otherwise the user's own default model and mode apply.
      ...(model === null || model === 'default' ? [] : ['--model', model]),
      // (Its flag takes corrallm's names: 'manual' among them, as of 2.1.296.)
      ...(mode === null ? [] : ['--permission-mode', mode]),
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
      // What it is about to ask the user: a permission prompt (and its questions or plan, as
      // their tools start: told by both).
      case 'PermissionRequest':
      case 'PreToolUse': {
        const ask = this.#askOf(text('tool_name'), event.tool_input, text('tool_use_id'));
        if (ask) signals.push({ kind: 'ask', ask });
        break;
      }
      case 'Notification': {
        const message = text('message')?.trim() ?? '';
        if (message !== '' && NEEDS_YOU.has(text('notification_type') ?? '')) {
          signals.push({ kind: 'needs', text: message.slice(0, MAX_ASK_TEXT) });
        }
        break;
      }
    }
    return signals;
  }

  /** What a tool call asks of the user, as a hook tells it: its questions, a plan, or permission. */
  #askOf(
    tool: string | undefined,
    input: unknown,
    toolUseId: string | undefined,
  ): TerminalAsk | undefined {
    if (tool === undefined || tool === '') return undefined;
    const id =
      toolUseId !== undefined && /^[\w-]{1,200}$/.test(toolUseId) ? toolUseId : randomUUID();
    if (tool === 'AskUserQuestion') {
      const questions = askedQuestions(property(input, 'questions'));
      return questions && { kind: 'question', id, questions: questions.slice(0, MAX_QUESTIONS) };
    }
    if (tool === 'ExitPlanMode') {
      const plan = (textOf(property(input, 'plan')) ?? '').slice(0, MAX_ANSWER_LENGTH);
      return { kind: 'plan', id, plan };
    }
    return { kind: 'permission', id, tool, summary: toolSummary(tool, input, this.#places) };
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

  statusLine(input: HookEvent): UsageWindows | undefined {
    return statusLineUsage(input, Date.now());
  }
}

/** A permission mode as Claude Code's hooks name it ('default' is Manual). */
function modeOf(name: string | undefined): PermissionMode | undefined {
  if (name === 'default') return 'manual';
  return PERMISSION_MODES.find((mode) => mode === name);
}
