import { randomUUID } from 'node:crypto';
import { realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  MAX_ANSWER_LENGTH,
  MAX_QUESTIONS,
  MODEL_PATTERN,
  PERMISSION_MODES,
} from '../../../shared/session';
import { CLAUDE_EFFORTS } from './efforts';
import type { PermissionMode, TerminalAsk } from '../../../shared/session';
import type { UsageWindows } from '../../../shared/usage';
import { claudeFailure } from './claude-errors';
import { isSessionId } from '../id';
import { askedQuestions } from './sdk/prompts';
import { proposedDetail, property, text as textOf, toolSummary } from './sdk/tools';
import type { Places } from './sdk/tools';
import { preview } from '../transcript';
import type { Launch, TerminalCli, TerminalSignal } from '../terminal/cli';
import { hookSettings } from './hooks';
import type { HookEvent, HookRegistration } from '../terminal/hooks';
import { hooksOff, hooksOffWarning, managedSettingsFolder } from './hooks-off';
import type { Screen } from '../terminal/screen';
import { statusLineSettings, statusLineUsage } from './statusline';
import { keystrokes, typeable } from './typing';

/*
 * Claude Code, as a Terminal session runs it (cli.ts). It starts with --settings (a file in the
 * session's folder: corrallm's HTTP hooks, merged with the user's, and corrallm's status line,
 * which reads its usage limits and runs the user's own: statusline.ts), --session-id (new) or --resume
 * (one with no transcript starts afresh under the same id), and --model, --effort (one of its
 * levels, where its claude takes the flag: connector.ts) and --permission-mode only when the agent
 * was set to them (otherwise the user's own default model, effort and mode apply). Its screen
 * reports its state (Program Status, OSC 7501: read by the session's screen) and shows its prompt
 * box (whose draft it reads); its hooks tell its session id, the prompts it took, its last
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
/** At most this many lines of what a permission is for (a diff, a file, a command) are listed. */
const PREVIEW_LINES = 12;
const LOGIN = 'Claude Code needs you to log in: run /login in its terminal.';
/** Its prompt mark, and the rules above and below its prompt box. */
const PROMPT = '❯';
const RULE = '─'.repeat(8);
/** Its folder trust dialog's choice to go on. */
const TRUST_DIALOG = 'Yes, I trust this folder';

export interface ClaudeCodeOptions {
  /** The project folder it works in: its asks show the files in it relative to it. */
  cwd: string;
  /** The user's home folder: where the files it asks about are shown from (as ~), outside it. */
  home: string;
  /** Its environment (the agents'), which finds the user's own status line and settings. */
  env: Readonly<Record<string, string>>;
  /** The effort to start at (one of Claude Code's levels), or null for the user's own. */
  effort?: string | null;
  /** Rebuild a changed role's prompt on resume, where the CLI supports snapshots. */
  resetPromptSnapshot?: boolean;
  /** Where its managed settings are (the organization's): the OS's folder for them by default. */
  managed?: string;
}

export class ClaudeCode implements TerminalCli<PermissionMode> {
  readonly name = 'Claude Code';
  // Interrupt running work, clear any draft, then exit at an empty prompt.
  readonly shutdownKeys = ['\x03', '\x03', '\x03'];
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
  /**
   * Enter once its prompt shows what was typed: keys that pile up while it is busy (just after
   * its folder trust dialog, or as a turn ends) are read in one go, as a paste, and 2.1.296 keeps
   * an Enter among them as an invisible character, not a submit.
   */
  readonly waitsForEcho = true;
  /** Where it works, for the files its asks are about. */
  #places: Places;
  readonly #env: Readonly<Record<string, string>>;
  /** Its effort, if it was given one of Claude Code's levels. */
  readonly #effort: string | undefined;
  readonly #resetPromptSnapshot: boolean;
  readonly #managed: string;
  /** Why corrallm can't hear it, once its settings were read (they turn its hooks off). */
  #unheard: string | undefined;

  constructor({
    cwd,
    home,
    env,
    effort = null,
    resetPromptSnapshot = false,
    managed = managedSettingsFolder(),
  }: ClaudeCodeOptions) {
    this.#places = { cwd, home };
    this.#env = env;
    this.#effort = effort !== null && Object.hasOwn(CLAUDE_EFFORTS, effort) ? effort : undefined;
    this.#resetPromptSnapshot = resetPromptSnapshot;
    this.#managed = managed;
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
    // Its settings may turn corrallm's hooks off: read (never changed), to say what won't work.
    const off = await hooksOff({ cwd, env: this.#env, managed: this.#managed, url: hooks.url });
    this.#unheard = off && hooksOffWarning(off);
  }

  unheard(): string | undefined {
    return this.#unheard;
  }

  args({ dir, id, resume, model, mode, role }: Launch<PermissionMode>): string[] {
    if (id !== null && !isSessionId(id)) throw new TypeError('Expected a UUID session id');
    return [
      '--settings',
      path.join(dir, SETTINGS),
      ...(id === null ? [] : resume ? [`--resume=${id}`] : ['--session-id', id]),
      // Rebuild a changed or removed role; unchanged resumes keep the cached prompt.
      ...(this.#resetPromptSnapshot && resume ? ['--system-prompt-snapshot=off'] : []),
      ...(role === undefined ? [] : [`--append-system-prompt=${role}`]),
      // Only what corrallm was given: otherwise the user's own default model, effort and mode apply.
      ...(model === null || model === 'default' ? [] : ['--model', model]),
      ...(this.#effort === undefined ? [] : ['--effort', this.#effort]),
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
    if (isSessionId(id)) signals.push({ kind: 'session', id });
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
            reason: claudeFailure(text('error') ?? 'unknown'),
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
    // What it is for, as its prompt shows it: a command in full, an edit's diff, a new file.
    const detail = proposedDetail(tool, input);
    return {
      kind: 'permission',
      id,
      tool,
      summary: toolSummary(tool, input, this.#places),
      ...(detail === undefined ? {} : { detail: preview(detail, PREVIEW_LINES) }),
    };
  }

  /**
   * What the user has typed in Claude Code's prompt and not sent: '' when it is empty (or shows
   * its dim placeholder), undefined when no prompt is on screen (a dialog, or still starting).
   * The prompt is the line that starts with ❯ right under a rule; the box ends at the next rule.
   */
  draft(screen: Screen): string | undefined {
    const { buffer, top, bottom } = screen.view();
    const lineText = (y: number) => buffer.getLine(y)?.translateToString(true) ?? '';
    for (let y = bottom - 1; y > top; y -= 1) {
      if (!lineText(y).startsWith(PROMPT) || !lineText(y - 1).startsWith(RULE)) continue;
      const typed: string[] = [];
      const cell = buffer.getNullCell();
      for (let row = y; row < bottom && (row === y || !lineText(row).startsWith(RULE)); row += 1) {
        const line = buffer.getLine(row);
        let text = '';
        // Past the prompt mark and its space (or the indent of a line after the first).
        for (let x = 2; line && x < line.length; x += 1) {
          const at = line.getCell(x, cell);
          if (!at || at.getWidth() === 0) continue;
          text += at.isDim() ? ' ' : at.getChars() || ' ';
        }
        typed.push(text.trimEnd());
      }
      return typed.join('\n').trim();
    }
    return undefined;
  }

  /**
   * Its folder trust dialog ("Quick safety check: Is this a project you created or one you
   * trust?", as 2.1.296 asks), whose default is "No, exit".
   */
  trusting(screen: Screen): boolean {
    return screen.text().includes(TRUST_DIALOG);
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
